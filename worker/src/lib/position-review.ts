// Cloudflare Worker: 全ユーザーのポジション評価を組み、各ユーザーへ DM する。
//
// 設計: signal-judge は銘柄ごとの最新判定 (方向 buy/sell + ライン) を signals テーブルに残す
// (ポジション非依存)。ここはそれを「ユーザーの建玉」に当てて読み替える後段。判定 (judge=LLM) と
// 読み替え (利確/損切り/継続) を分け、読み替えは決定論で行う:
//   - long  保有 × buy 判定  → 継続/増し玉余地 (順行)
//   - long  保有 × sell 判定 → 利確/手仕舞い検討 (逆行)
//   - short 保有 × sell 判定 → 継続/増し玉余地 (順行)
//   - short 保有 × buy 判定  → 買い戻し/手仕舞い検討 (逆行)
// 含み損益% は positions.ts の pnlPct と同じ符号則。参照現値は当日 daily の close (eod cron は
// daily 収集直後に呼ぶので最新足が揃っている)。判定が無い銘柄は「判定待ち」とだけ書く。
//
// 発火は eod cron (引け後 1 日 1 回)。対象は WATCHLIST 内の保有銘柄のみ。DM は postMessage の
// channel に userId を直接渡す (chat.postMessage が DM チャンネルを自動で開く)。best-effort。

import { desc, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import type { Env } from "./env";
import { daily, positions, signals } from "./schema";
import { postMessage } from "./slack";
import { WATCHLIST, WATCHLIST_NAMES } from "./watchlist";

// 1 ユーザーの 1 保有行 + その銘柄の最新判定を読み替えた評価。
interface PositionEval {
	ticker: string;
	name: string;
	account: string; // cash | margin
	side: string; // long | short
	avgPrice: number;
	pnlPct: number | null; // 含み損益% (参照現値が無ければ null)
	judgeSide: string | null; // buy | sell | null (判定なし)
	stance: "順行" | "逆行" | "判定待ち"; // 建玉に対する判定の向き
	action: string; // 読み替え (利確/損切り検討 / 継続・増し玉余地 / 判定待ち)
	headline: string | null; // 判定 headline (DM に同梱)
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

// 建玉 side と判定 side から「順行/逆行」と読み替え文言を決める。判定なしは判定待ち。
function readVerdict(
	side: string,
	judgeSide: string | null,
): { stance: PositionEval["stance"]; action: string } {
	if (judgeSide == null) return { stance: "判定待ち", action: "判定待ち" };
	// long は buy 判定が順行、short は sell 判定が順行。
	const aligned = side === "short" ? judgeSide === "sell" : judgeSide === "buy";
	if (aligned) return { stance: "順行", action: "継続・増し玉余地" };
	return { stance: "逆行", action: "利確/損切り検討" };
}

// 全ユーザーのポジションを評価して各ユーザーへ DM する。SLACK_BOT_TOKEN 未設定なら no-op。
// 返り値は送信したユーザー数 (テスト/ログ用)。
export async function reviewPositions(env: Env): Promise<{ users: number }> {
	if (!env.SLACK_BOT_TOKEN) return { users: 0 };
	const d = db(env.DB);

	// 全保有行を引く。WATCHLIST 内の銘柄だけを評価対象にする (judge 対象と揃える)。
	const rows = (await d
		.select({
			userId: positions.userId,
			ticker: positions.ticker,
			account: positions.account,
			side: positions.side,
			avgPrice: positions.avgPrice,
		})
		.from(positions)
		.where(inArray(positions.ticker, [...WATCHLIST]))
		.all()) as {
		userId: string;
		ticker: string;
		account: string;
		side: string;
		avgPrice: number;
	}[];
	if (rows.length === 0) return { users: 0 };

	// 評価に要る銘柄だけ最新判定 + 当日 close を引く (ユーザー横断で 1 銘柄 1 回に集約)。
	const tickers = [...new Set(rows.map((r) => r.ticker))];
	const sigRows = (await d
		.select({
			ticker: signals.ticker,
			side: signals.side,
			headline: signals.headline,
		})
		.from(signals)
		.where(inArray(signals.ticker, tickers))
		.all()) as { ticker: string; side: string; headline: string }[];
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

	// ユーザーごとに評価行をまとめる。
	const byUser = new Map<string, PositionEval[]>();
	for (const r of rows) {
		const sig = sigByTicker.get(r.ticker) ?? null;
		const judgeSide = sig?.side ?? null;
		const { stance, action } = readVerdict(r.side, judgeSide);
		const evalRow: PositionEval = {
			ticker: r.ticker,
			name: WATCHLIST_NAMES[r.ticker] ?? r.ticker,
			account: r.account,
			side: r.side,
			avgPrice: r.avgPrice,
			pnlPct: reviewPnlPct(
				r.side,
				r.avgPrice,
				priceByTicker.get(r.ticker) ?? null,
			),
			judgeSide,
			stance,
			action,
			headline: sig?.headline ?? null,
		};
		const list = byUser.get(r.userId) ?? [];
		list.push(evalRow);
		byUser.set(r.userId, list);
	}

	let users = 0;
	for (const [userId, evals] of byUser) {
		const blocks = buildReviewBlocks(evals);
		const posted = await postMessage(env, {
			channel: userId,
			text: "📋 保有ポジション評価",
			blocks,
		});
		if (posted) users += 1;
	}
	return { users };
}

// ユーザー 1 人分の DM blocks を組む。1 銘柄 1 section。先頭に見出し。
function buildReviewBlocks(evals: PositionEval[]): unknown[] {
	const header = {
		type: "section",
		text: { type: "mrkdwn", text: "*📋 保有ポジション評価 (引け後)*" },
	};
	const lines = evals.map((e) => ({
		type: "section",
		text: { type: "mrkdwn", text: formatEvalLine(e) },
	}));
	return [header, ...lines];
}

// 1 銘柄分の DM 行。建玉・含み損益・判定の向き・読み替え・judge headline を 1 ブロックに畳む。
function formatEvalLine(e: PositionEval): string {
	const acc = e.account === "margin" ? "信用" : "現物";
	const sideJa = e.side === "short" ? "売建" : "買建";
	const pnl = e.pnlPct == null ? "—" : `${e.pnlPct > 0 ? "+" : ""}${e.pnlPct}%`;
	const head = `*${e.ticker} ${e.name}* ${acc}${sideJa} 建値${e.avgPrice} 含損益${pnl}`;
	const verdict =
		e.stance === "判定待ち"
			? "→ 判定待ち (最新シグナルなし)"
			: `→ ${e.stance}: ${e.action}`;
	const detail = e.headline ? `\n${e.headline}` : "";
	return `${head}\n${verdict}${detail}`;
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

	describe("readVerdict", () => {
		it("long × buy は順行", () => {
			expect(readVerdict("long", "buy")).toEqual({
				stance: "順行",
				action: "継続・増し玉余地",
			});
		});
		it("long × sell は逆行 (利確/損切り検討)", () => {
			expect(readVerdict("long", "sell").stance).toBe("逆行");
		});
		it("short × sell は順行", () => {
			expect(readVerdict("short", "sell").stance).toBe("順行");
		});
		it("short × buy は逆行", () => {
			expect(readVerdict("short", "buy").stance).toBe("逆行");
		});
		it("判定なしは判定待ち", () => {
			expect(readVerdict("long", null)).toEqual({
				stance: "判定待ち",
				action: "判定待ち",
			});
		});
	});

	describe("formatEvalLine", () => {
		it("含み益はプラス符号つき、judge headline を畳む", () => {
			const line = formatEvalLine({
				ticker: "285A",
				name: "キオクシア",
				account: "cash",
				side: "long",
				avgPrice: 1000,
				pnlPct: 10,
				judgeSide: "buy",
				stance: "順行",
				action: "継続・増し玉余地",
				headline: "🧭 285A signal: buy",
			});
			expect(line).toContain("現物買建");
			expect(line).toContain("+10%");
			expect(line).toContain("順行: 継続・増し玉余地");
			expect(line).toContain("🧭 285A signal: buy");
		});
		it("判定なしは判定待ち行で headline を畳まない", () => {
			const line = formatEvalLine({
				ticker: "6857",
				name: "アドバンテスト",
				account: "margin",
				side: "short",
				avgPrice: 5000,
				pnlPct: null,
				judgeSide: null,
				stance: "判定待ち",
				action: "判定待ち",
				headline: null,
			});
			expect(line).toContain("信用売建");
			expect(line).toContain("含損益—");
			expect(line).toContain("判定待ち (最新シグナルなし)");
		});
	});
}
