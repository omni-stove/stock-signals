// Cloudflare Worker: ポジション事実レポートの「材料作り」。建玉 × 最新材料ブリーフ (briefs) ×
// 当日 close をユーザー単位の JSON にまとめ、GitHub Actions の position-report ワークフローに渡す。
//
// 設計: 売買アクションの提案はしない。Worker は数値 (含み損益) とその銘柄の最新材料ブリーフを
// 決定論で揃えて渡すだけで、建玉と材料の紐付け (この建玉にどの新着材料・リスクが効いているか) は
// Actions の position-report が LLM で行う。建玉の事実行 (建値/現値/含み損益) の整形も
// post-position-report.sh が決定論で行い、LLM には通さない。
// 含み損益% は positions.ts の pnlPct と同じ符号則。参照現値は当日 daily の close (eod cron は
// daily 収集直後に発火するので最新足が揃っている)。ブリーフが無い銘柄は brief=null で渡す。
//
// 発火は eod cron (引け後 1 日 1 回)。cron は listPositionUsers が示す対象がいれば repository_dispatch
// (position-report) を 1 回撃つだけ。ワークフローは /position-users で userId 配列を引き、ユーザー
// ごとに /position-context?userId= を読んで LLM が材料を紐付け DM する。対象は WATCHLIST 内の保有銘柄のみ。

import { desc, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import type { Env } from "./env";
import { briefs, daily, positions } from "./schema";
import { WATCHLIST, WATCHLIST_NAMES } from "./watchlist";

// 1 ユーザーの 1 保有行 + その銘柄の最新材料ブリーフを決定論で添えたレポート材料。LLM はこれを
// 読んで「建玉に関係する新着材料・リスク」を事実として並べる (アクション・緊急度は出さない)。
export interface PositionContextRow {
	ticker: string;
	name: string;
	account: string; // cash | margin
	side: string; // long | short
	avgPrice: number;
	price: number | null; // 参照現値 (当日 daily close)。無ければ null
	pnlPct: number | null; // 含み損益% (参照現値が無ければ null)
	// 最新材料ブリーフ (briefs)。ブリーフが無い銘柄は null。
	brief: {
		headline: string;
		body: string | null;
		briefedAt: string; // 保存時刻 (ISO8601)。鮮度の判断は LLM 側で行う
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

// 建玉を持つユーザーの userId 一覧 (WATCHLIST 内銘柄に限る)。position-report ワークフローの
// fan-out が /position-users 経由でこれを引き、matrix に展開する。重複は畳む。
export async function listPositionUsers(env: Env): Promise<string[]> {
	const rows = (await db(env.DB)
		.select({ userId: positions.userId })
		.from(positions)
		.where(inArray(positions.ticker, [...WATCHLIST]))
		.all()) as { userId: string }[];
	return [...new Set(rows.map((r) => r.userId))];
}

// 1 ユーザーの全建玉について、最新材料ブリーフ + 当日 close + 含み損益を組んで返す。
// /position-context?userId= がこれを JSON で返し、LLM がレポート材料として読む。対象は WATCHLIST
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
	// WATCHLIST 内の銘柄だけレポート対象にする (ブリーフ対象と揃える)。
	const targets = rows.filter((r) => WATCHLIST.includes(r.ticker));
	if (targets.length === 0) return [];

	// レポートに要る銘柄だけ最新ブリーフ + 当日 close を引く (1 銘柄 1 回に集約)。
	const tickers = [...new Set(targets.map((r) => r.ticker))];
	const briefRows = (await d
		.select({
			ticker: briefs.ticker,
			headline: briefs.headline,
			body: briefs.body,
			briefedAt: briefs.briefedAt,
		})
		.from(briefs)
		.where(inArray(briefs.ticker, tickers))
		.all()) as {
		ticker: string;
		headline: string;
		body: string | null;
		briefedAt: string;
	}[];
	const briefByTicker = new Map(briefRows.map((b) => [b.ticker, b]));

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
		const brief = briefByTicker.get(r.ticker) ?? null;
		const price = priceByTicker.get(r.ticker) ?? null;
		return {
			ticker: r.ticker,
			name: WATCHLIST_NAMES[r.ticker] ?? r.ticker,
			account: r.account,
			side: r.side,
			avgPrice: r.avgPrice,
			price,
			pnlPct: reviewPnlPct(r.side, r.avgPrice, price),
			brief: brief
				? {
						headline: brief.headline,
						body: brief.body,
						briefedAt: brief.briefedAt,
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
}
