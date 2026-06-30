// Cloudflare Worker: ポジション評価の「材料作り」。建玉 × 最新判定 (signals) × 当日 close を
// ユーザー単位の JSON にまとめ、GitHub Actions の position-review ワークフローに渡す。
//
// 設計: signal-judge は銘柄ごとの最新判定 (方向 buy/sell + ライン) を signals テーブルに残す
// (ポジション非依存)。ここはそれを「ユーザーの建玉」に当てる前処理。判定 (judge=LLM) と読み替え
// (利確/損切り/継続) を分け、読み替えの「強弱・優先度・ポートフォリオ横断の所見」は Actions の
// position-review が LLM で行う。Worker 側は数値 (含み損益・順行/逆行のヒント) を決定論で揃えて渡す:
//   - long  保有 × buy 判定  → 順行 (継続/増し玉余地のヒント)
//   - long  保有 × sell 判定 → 逆行 (利確/手仕舞い検討のヒント)
//   - short 保有 × sell 判定 → 順行
//   - short 保有 × buy 判定  → 逆行
// 含み損益% は positions.ts の pnlPct と同じ符号則。参照現値は当日 daily の close (eod cron は
// daily 収集直後に発火するので最新足が揃っている)。判定が無い銘柄は judge=null で渡す。
//
// 発火は eod cron (引け後 1 日 1 回)。cron は listPositionUsers が示す対象がいれば repository_dispatch
// (position-review) を 1 回撃つだけ。ワークフローは /position-users で userId 配列を引き、ユーザー
// ごとに /position-context?userId= を読んで LLM 評価し DM する。対象は WATCHLIST 内の保有銘柄のみ。

import { desc, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import type { Env } from "./env";
import { daily, positions, signals } from "./schema";
import { WATCHLIST, WATCHLIST_NAMES } from "./watchlist";

// 1 ユーザーの 1 保有行 + その銘柄の最新判定を決定論で添えた評価材料。LLM はこれを読んで
// アクション (利確/一部利確/損切り/継続/増し玉) と優先度・ポートフォリオ所見を出す。
export interface PositionContextRow {
	ticker: string;
	name: string;
	account: string; // cash | margin
	side: string; // long | short
	avgPrice: number;
	price: number | null; // 参照現値 (当日 daily close)。無ければ null
	pnlPct: number | null; // 含み損益% (参照現値が無ければ null)
	stance: "順行" | "逆行" | "判定待ち"; // 建玉に対する判定の向き (決定論ヒント)
	// 最新判定 (signals)。判定が無い銘柄は null。
	judge: {
		side: string; // buy | sell
		exec: string; // now | wait
		line: string | null; // wait の指値
		stop: string | null; // 損切りライン
		rr: string | null; // リスクリワード
		headline: string; // 判定 headline
	} | null;
}

// 含み損益%。positions.ts pnlPct と同じ符号則 (long: 上昇で益 / short: 下落で益)。
// price 無し・avg<=0・非有限は null。四捨五入は小数第1位。
function reviewPnlPct(
	side: string,
	avgPrice: number,
	price: number | null,
): number | null {
	if (price == null || !Number.isFinite(price)) return null;
	if (!Number.isFinite(avgPrice) || avgPrice <= 0) return null;
	const raw =
		side === "short"
			? (avgPrice - price) / avgPrice
			: (price - avgPrice) / avgPrice;
	return Math.round(raw * 1000) / 10;
}

// 建玉 side と判定 side から「順行/逆行」を決める (決定論ヒント)。判定なしは判定待ち。
// 読み替え (利確/損切り/継続) の文言は LLM が含み損益や line/stop を踏まえて決めるので、
// ここでは向きだけを出す (signal-judge 時代の固定文言は LLM に委ねる)。
function reviewStance(
	side: string,
	judgeSide: string | null,
): PositionContextRow["stance"] {
	if (judgeSide == null) return "判定待ち";
	// long は buy 判定が順行、short は sell 判定が順行。
	const aligned = side === "short" ? judgeSide === "sell" : judgeSide === "buy";
	return aligned ? "順行" : "逆行";
}

// 建玉を持つユーザーの userId 一覧 (WATCHLIST 内銘柄に限る)。position-review ワークフローの
// fan-out が /position-users 経由でこれを引き、matrix に展開する。重複は畳む。
export async function listPositionUsers(env: Env): Promise<string[]> {
	const rows = (await db(env.DB)
		.select({ userId: positions.userId })
		.from(positions)
		.where(inArray(positions.ticker, [...WATCHLIST]))
		.all()) as { userId: string }[];
	return [...new Set(rows.map((r) => r.userId))];
}

// 1 ユーザーの全建玉について、最新判定 + 当日 close + 含み損益 + 順行/逆行を組んで返す。
// /position-context?userId= がこれを JSON で返し、LLM が評価材料として読む。対象は WATCHLIST
// 内の保有銘柄のみ。建玉が無ければ空配列。
export async function buildPositionContext(
	env: Env,
	userId: string,
): Promise<PositionContextRow[]> {
	const d = db(env.DB);
	const rows = (await d
		.select({
			ticker: positions.ticker,
			account: positions.account,
			side: positions.side,
			avgPrice: positions.avgPrice,
		})
		.from(positions)
		.where(eq(positions.userId, userId))
		.all()) as {
		ticker: string;
		account: string;
		side: string;
		avgPrice: number;
	}[];
	// WATCHLIST 内の銘柄だけ評価対象にする (judge 対象と揃える)。
	const targets = rows.filter((r) => WATCHLIST.includes(r.ticker));
	if (targets.length === 0) return [];

	// 評価に要る銘柄だけ最新判定 + 当日 close を引く (1 銘柄 1 回に集約)。
	const tickers = [...new Set(targets.map((r) => r.ticker))];
	const sigRows = (await d
		.select({
			ticker: signals.ticker,
			side: signals.side,
			exec: signals.exec,
			line: signals.line,
			stop: signals.stop,
			rr: signals.rr,
			headline: signals.headline,
		})
		.from(signals)
		.where(inArray(signals.ticker, tickers))
		.all()) as {
		ticker: string;
		side: string;
		exec: string;
		line: string | null;
		stop: string | null;
		rr: string | null;
		headline: string;
	}[];
	const sigByTicker = new Map(sigRows.map((s) => [s.ticker, s]));

	// 各銘柄の最新 daily close を参照現値にする。
	const priceByTicker = new Map<string, number | null>();
	for (const t of tickers) {
		const row = await d
			.select({ close: daily.close })
			.from(daily)
			.where(eq(daily.ticker, t))
			.orderBy(desc(daily.date))
			.limit(1)
			.get();
		priceByTicker.set(t, row?.close ?? null);
	}

	return targets.map((r) => {
		const sig = sigByTicker.get(r.ticker) ?? null;
		const price = priceByTicker.get(r.ticker) ?? null;
		return {
			ticker: r.ticker,
			name: WATCHLIST_NAMES[r.ticker] ?? r.ticker,
			account: r.account,
			side: r.side,
			avgPrice: r.avgPrice,
			price,
			pnlPct: reviewPnlPct(r.side, r.avgPrice, price),
			stance: reviewStance(r.side, sig?.side ?? null),
			judge: sig
				? {
						side: sig.side,
						exec: sig.exec,
						line: sig.line,
						stop: sig.stop,
						rr: sig.rr,
						headline: sig.headline,
					}
				: null,
		};
	});
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("reviewPnlPct", () => {
		it("long は上昇で益", () => {
			expect(reviewPnlPct("long", 1000, 1100)).toBe(10);
		});
		it("short は下落で益", () => {
			expect(reviewPnlPct("short", 1000, 900)).toBe(10);
		});
		it("price 無し / avg<=0 は null", () => {
			expect(reviewPnlPct("long", 1000, null)).toBeNull();
			expect(reviewPnlPct("long", 0, 1000)).toBeNull();
		});
	});

	describe("reviewStance", () => {
		it("long × buy は順行", () => {
			expect(reviewStance("long", "buy")).toBe("順行");
		});
		it("long × sell は逆行", () => {
			expect(reviewStance("long", "sell")).toBe("逆行");
		});
		it("short × sell は順行", () => {
			expect(reviewStance("short", "sell")).toBe("順行");
		});
		it("short × buy は逆行", () => {
			expect(reviewStance("short", "buy")).toBe("逆行");
		});
		it("判定なしは判定待ち", () => {
			expect(reviewStance("long", null)).toBe("判定待ち");
		});
	});
}
