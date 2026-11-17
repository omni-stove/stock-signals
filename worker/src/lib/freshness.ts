// Cloudflare Worker: 収集データの途絶検知。
//
// 引け後 intake (JST 18:00) に、その日までに入っているはずのデータが D1 に入っているかを表ごとに
// 確かめ、遅れている収集を運用チャンネルに 1 行で知らせる。エラーを出さずに止まった収集
// (ソース側の仕様変更・取得はできたが中身が空 など) を拾うためのもので、LLM には何も渡さない。
//
// 日足 (TOPIX・日経225 を含む)・5分足・強制決済スコア・fundamentals は、東証カレンダー
// (market-calendar.ts) で求めた今日以前の最新営業日まで来ているかで判定する。週次・日次の
// 公表データと決算予定日の取得は、最新日から今日までの東証営業日数で判定する。

import { and, desc, gte, inArray, max, sql } from "drizzle-orm";
import { db } from "./db";
import type { Env } from "./env";
import {
	latestTseBusinessDay,
	tseBusinessDaysBetween,
} from "./market-calendar";
import {
	daily,
	earnings,
	forcedLiquidation,
	fundamentals,
	investorFlows,
	macroEvents,
	margin,
	marketShortRatio,
	premarketBackdrop,
	prices,
} from "./schema";
import { DAILY_CODES, WATCHLIST } from "./timeseries";
import { jstDate } from "./utils";

export interface FreshnessSnapshot {
	daily: Record<string, string | null>; // code → 最新の日足日付
	prices: Record<string, string | null>; // ticker → 最新 5 分足の日付
	forced: Record<string, string | null>;
	fundamentals: Record<string, string | null>;
	premarket: string | null; // 最新取得の JST 日付
	usPeers: boolean | null; // 最新の寄り前取得で海外ピアの騰落が 1 銘柄でも取れたか (行なしは null)
	margin: string | null; // 信用残の最新集計基準日
	investorFlows: string | null; // 投資部門別の最新 week_end
	marketShortRatio: string | null;
	earnings: Record<string, string | null>; // ticker → 決算予定日の最新取得の JST 日付
	nextMacro: string | null; // 今日以降で最も近い FOMC/日銀
}

function toJstDate(iso: string | null): string | null {
	if (!iso) return null;
	const t = Date.parse(iso);
	return Number.isFinite(t) ? jstDate(t) : null;
}

// 公表データの許容遅れ (今日までの東証営業日数)。週次は公表曜日のずれを見込む。
const MAX_LAG_DAYS = {
	margin: 10,
	investorFlows: 12,
	marketShortRatio: 3,
	earnings: 2,
} as const;

// 遅れている収集のラベル (例 "daily:6857 (最新 2026-11-10)") を返す。空配列 = 全部揃っている。
export function staleSources(s: FreshnessSnapshot, today: string): string[] {
	const out: string[] = [];
	const label = (name: string, last: string | null) =>
		`${name} (最新 ${last ?? "なし"})`;
	const lagOver = (last: string | null, maxLag: number) =>
		last == null || tseBusinessDaysBetween(last, today) > maxLag;

	const marketDate = latestTseBusinessDay(today);
	const behind = (name: string, rows: Record<string, string | null>) => {
		for (const [code, last] of Object.entries(rows))
			if (last == null || last < marketDate)
				out.push(label(`${name}:${code}`, last));
	};
	behind("daily", s.daily);
	behind("prices", s.prices);
	behind("forced", s.forced);
	behind("fundamentals", s.fundamentals);
	if (s.premarket == null || s.premarket < today)
		out.push(label("premarket", s.premarket));
	if (s.usPeers === false) out.push("us-peers (騰落が全銘柄なし)");
	if (lagOver(s.margin, MAX_LAG_DAYS.margin))
		out.push(label("margin", s.margin));
	if (lagOver(s.investorFlows, MAX_LAG_DAYS.investorFlows))
		out.push(label("investor-flows", s.investorFlows));
	if (lagOver(s.marketShortRatio, MAX_LAG_DAYS.marketShortRatio))
		out.push(label("market-short-ratio", s.marketShortRatio));
	for (const [code, last] of Object.entries(s.earnings))
		if (lagOver(last, MAX_LAG_DAYS.earnings))
			out.push(label(`earnings:${code}`, last));
	if (s.nextMacro == null) out.push("macro-events (今後の FOMC/日銀なし)");
	return out;
}

// us_peers_json ([{ticker, change_pct, …}]) に騰落の取れた銘柄が 1 つでもあるか。
function anyPeerQuote(json: string | null): boolean {
	try {
		const quotes = JSON.parse(json ?? "[]") as { change_pct?: unknown }[];
		return (
			Array.isArray(quotes) &&
			quotes.some((q) => typeof q?.change_pct === "number")
		);
	} catch {
		return false;
	}
}

function maxByTicker(
	rows: { ticker: string; last: string | null }[],
	codes: readonly string[],
): Record<string, string | null> {
	const m = new Map(rows.map((r) => [r.ticker, r.last]));
	return Object.fromEntries(codes.map((c) => [c, m.get(c) ?? null]));
}

export async function readFreshness(
	env: Pick<Env, "DB">,
	today: string,
): Promise<FreshnessSnapshot> {
	const d = db(env.DB);
	const dailyRows = await d
		.select({ ticker: daily.ticker, last: max(daily.date) })
		.from(daily)
		.where(inArray(daily.ticker, DAILY_CODES))
		.groupBy(daily.ticker)
		.all();
	const priceRows = await d
		.select({
			ticker: prices.ticker,
			last: sql<string | null>`substr(max(${prices.slot}), 1, 10)`,
		})
		.from(prices)
		.where(inArray(prices.ticker, WATCHLIST))
		.groupBy(prices.ticker)
		.all();
	const forcedRows = await d
		.select({
			ticker: forcedLiquidation.ticker,
			last: max(forcedLiquidation.date),
		})
		.from(forcedLiquidation)
		.groupBy(forcedLiquidation.ticker)
		.all();
	const fundRows = await d
		.select({ ticker: fundamentals.ticker, last: max(fundamentals.date) })
		.from(fundamentals)
		.groupBy(fundamentals.ticker)
		.all();
	const earningsRows = await d
		.select({ ticker: earnings.ticker, last: earnings.fetchedAt })
		.from(earnings)
		.where(inArray(earnings.ticker, WATCHLIST))
		.all();
	const peersRow = await d
		.select({ json: premarketBackdrop.usPeersJson })
		.from(premarketBackdrop)
		.orderBy(desc(premarketBackdrop.fetchedAt))
		.limit(1)
		.get();
	const one = async <T>(q: Promise<{ v: T | null } | undefined>) =>
		(await q)?.v ?? null;
	return {
		daily: maxByTicker(dailyRows, DAILY_CODES),
		prices: maxByTicker(priceRows, WATCHLIST),
		forced: maxByTicker(forcedRows, WATCHLIST),
		fundamentals: maxByTicker(fundRows, WATCHLIST),
		usPeers: peersRow ? anyPeerQuote(peersRow.json) : null,
		premarket: toJstDate(
			await one(
				d
					.select({ v: max(premarketBackdrop.fetchedAt) })
					.from(premarketBackdrop)
					.get(),
			),
		),
		margin: await one(
			d
				.select({ v: max(margin.date) })
				.from(margin)
				.get(),
		),
		investorFlows: await one(
			d
				.select({ v: max(investorFlows.weekEnd) })
				.from(investorFlows)
				.get(),
		),
		marketShortRatio: await one(
			d
				.select({ v: max(marketShortRatio.date) })
				.from(marketShortRatio)
				.get(),
		),
		earnings: maxByTicker(
			earningsRows.map((r) => ({ ticker: r.ticker, last: toJstDate(r.last) })),
			WATCHLIST,
		),
		nextMacro: await one(
			d
				.select({ v: sql<string | null>`min(${macroEvents.date})` })
				.from(macroEvents)
				.where(
					and(
						inArray(macroEvents.kind, ["fomc", "boj"]),
						gte(macroEvents.date, today),
					),
				)
				.get(),
		),
	};
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("anyPeerQuote", () => {
		it("騰落が 1 銘柄でも取れていれば true", () => {
			expect(
				anyPeerQuote(
					'[{"ticker":"MU","change_pct":null},{"ticker":"NVDA","change_pct":1.2}]',
				),
			).toBe(true);
			expect(anyPeerQuote('[{"ticker":"MU","change_pct":null}]')).toBe(false);
			expect(anyPeerQuote(null)).toBe(false);
			expect(anyPeerQuote("{")).toBe(false);
		});
	});

	describe("staleSources", () => {
		const TODAY = "2026-11-13"; // 金曜
		const all = (v: string | null, codes: readonly string[]) =>
			Object.fromEntries(codes.map((c) => [c, v]));
		const at = (today: string, daily: string): FreshnessSnapshot => ({
			daily: all(daily, DAILY_CODES),
			prices: all(daily, WATCHLIST),
			forced: all(daily, WATCHLIST),
			fundamentals: all(daily, WATCHLIST),
			premarket: today,
			usPeers: true,
			margin: "2026-11-06",
			investorFlows: "2026-11-06",
			marketShortRatio: daily,
			earnings: all(daily, WATCHLIST),
			nextMacro: "2026-12-16",
		});
		const fresh = () => at(TODAY, TODAY);

		it("全部揃っていれば空", () => {
			expect(staleSources(fresh(), TODAY)).toEqual([]);
		});

		it("最新営業日に届かない銘柄別の表を挙げる", () => {
			const s = fresh();
			s.daily["6857"] = "2026-11-12";
			s.prices["6920"] = null;
			expect(staleSources(s, TODAY)).toEqual([
				"daily:6857 (最新 2026-11-12)",
				"prices:6920 (最新 なし)",
			]);
		});

		it("日足がそろって止まっても TOPIX を含めて挙げる", () => {
			const s = fresh();
			for (const k of Object.keys(s.daily)) s.daily[k] = "2026-11-12";
			const out = staleSources(s, TODAY);
			expect(out).toHaveLength(DAILY_CODES.length);
			expect(out).toContain("daily:0010 (最新 2026-11-12)");
		});

		it("祝日・年末年始の連休明けでも、直前の営業日まであれば鳴らさない", () => {
			expect(
				staleSources(at("2026-11-23", "2026-11-20"), "2026-11-23"),
			).toEqual([]);
			const ny = at("2027-01-01", "2026-12-30");
			ny.margin = "2026-12-25";
			ny.investorFlows = "2026-12-25";
			expect(staleSources(ny, "2027-01-01")).toEqual([]);
			const gw = at("2026-05-06", "2026-05-01");
			gw.margin = "2026-04-24";
			gw.investorFlows = "2026-04-24";
			expect(staleSources(gw, "2026-05-06")).toEqual([]);
		});

		it("決算予定日は銘柄ごとに見る", () => {
			const s = fresh();
			s.earnings["6920"] = "2026-11-09";
			expect(staleSources(s, TODAY)).toEqual([
				"earnings:6920 (最新 2026-11-09)",
			]);
		});

		it("週次・日次の公表データは営業日数の許容を超えたら挙げる", () => {
			const s = fresh();
			s.margin = "2026-10-23"; // 15 営業日
			s.marketShortRatio = "2026-11-12";
			s.nextMacro = null;
			s.premarket = "2026-11-12";
			s.usPeers = false;
			expect(staleSources(s, TODAY)).toEqual([
				"premarket (最新 2026-11-12)",
				"us-peers (騰落が全銘柄なし)",
				"margin (最新 2026-10-23)",
				"macro-events (今後の FOMC/日銀なし)",
			]);
		});
	});
}
