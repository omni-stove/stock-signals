// Cloudflare Worker: 収集データの途絶検知。
//
// 引け後 intake (JST 20:00) に、その日までに入っているはずのデータが D1 に入っているかを表ごとに
// 確かめ、遅れている収集を運用チャンネルに 1 行で知らせる。エラーを出さずに止まった収集
// (ソース側の仕様変更・取得はできたが中身が空 など) を拾うためのもので、LLM には何も渡さない。
//
// 東証の営業日は TOPIX 日足の最新日 (market_date) で代用する。祝日は TOPIX 日足が進まないので、
// 銘柄別の日足・5分足・強制決済スコア・fundamentals は「market_date まで来ているか」で判定し、
// 祝日カレンダーを持たない。TOPIX 自身と週次・日次の公表データは、今日からの平日数で判定する。

import { and, gte, inArray, max, sql } from "drizzle-orm";
import { db } from "./db";
import type { Env } from "./env";
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
import { BENCHMARK_CODE, DAILY_CODES, WATCHLIST } from "./timeseries";

export interface FreshnessSnapshot {
	daily: Record<string, string | null>; // code → 最新の日足日付
	prices: Record<string, string | null>; // ticker → 最新 5 分足の日付
	forced: Record<string, string | null>;
	fundamentals: Record<string, string | null>;
	premarket: string | null; // 最新取得の JST 日付
	margin: string | null; // 信用残の最新集計基準日
	investorFlows: string | null; // 投資部門別の最新 week_end
	marketShortRatio: string | null;
	earnings: string | null; // 決算予定日の最新取得の JST 日付
	nextMacro: string | null; // 今日以降で最も近い FOMC/日銀
}

// from (YYYY-MM-DD) の翌日から to までの平日数。from >= to なら 0。
function weekdaysBetween(from: string, to: string): number {
	const d = new Date(`${from}T12:00:00Z`);
	const end = new Date(`${to}T12:00:00Z`);
	let n = 0;
	while (d < end) {
		d.setUTCDate(d.getUTCDate() + 1);
		const w = d.getUTCDay();
		if (w !== 0 && w !== 6) n++;
	}
	return n;
}

function toJstDate(iso: string | null): string | null {
	if (!iso) return null;
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return null;
	return new Date(t + 9 * 3600_000).toISOString().slice(0, 10);
}

// 公表データの許容遅れ (今日からの平日数)。週次は公表曜日のずれと祝日週を見込む。
const MAX_LAG_WEEKDAYS = {
	topix: 2,
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
		last == null || weekdaysBetween(last, today) > maxLag;

	const marketDate = s.daily[BENCHMARK_CODE] ?? null;
	if (lagOver(marketDate, MAX_LAG_WEEKDAYS.topix))
		out.push(label(`daily:${BENCHMARK_CODE}`, marketDate));
	if (marketDate) {
		const behind = (name: string, rows: Record<string, string | null>) => {
			for (const [code, last] of Object.entries(rows)) {
				if (code === BENCHMARK_CODE) continue;
				if (last == null || last < marketDate)
					out.push(label(`${name}:${code}`, last));
			}
		};
		behind("daily", s.daily);
		behind("prices", s.prices);
		behind("forced", s.forced);
		behind("fundamentals", s.fundamentals);
	}
	if (s.premarket == null || s.premarket < today)
		out.push(label("premarket", s.premarket));
	if (lagOver(s.margin, MAX_LAG_WEEKDAYS.margin))
		out.push(label("margin", s.margin));
	if (lagOver(s.investorFlows, MAX_LAG_WEEKDAYS.investorFlows))
		out.push(label("investor-flows", s.investorFlows));
	if (lagOver(s.marketShortRatio, MAX_LAG_WEEKDAYS.marketShortRatio))
		out.push(label("market-short-ratio", s.marketShortRatio));
	if (lagOver(s.earnings, MAX_LAG_WEEKDAYS.earnings))
		out.push(label("earnings", s.earnings));
	if (s.nextMacro == null) out.push("macro-events (今後の FOMC/日銀なし)");
	return out;
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
	const one = async <T>(q: Promise<{ v: T | null } | undefined>) =>
		(await q)?.v ?? null;
	return {
		daily: maxByTicker(dailyRows, DAILY_CODES),
		prices: maxByTicker(priceRows, WATCHLIST),
		forced: maxByTicker(forcedRows, WATCHLIST),
		fundamentals: maxByTicker(fundRows, WATCHLIST),
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
		earnings: toJstDate(
			await one(
				d
					.select({ v: max(earnings.fetchedAt) })
					.from(earnings)
					.get(),
			),
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

	describe("weekdaysBetween", () => {
		it("翌日から to までの平日を数える", () => {
			expect(weekdaysBetween("2026-11-12", "2026-11-13")).toBe(1); // 木→金
			expect(weekdaysBetween("2026-11-13", "2026-11-16")).toBe(1); // 金→月
			expect(weekdaysBetween("2026-11-06", "2026-11-13")).toBe(5);
			expect(weekdaysBetween("2026-11-13", "2026-11-13")).toBe(0);
			expect(weekdaysBetween("2026-11-14", "2026-11-13")).toBe(0);
		});
	});

	describe("staleSources", () => {
		const TODAY = "2026-11-13"; // 金曜
		const all = (v: string | null, codes: readonly string[]) =>
			Object.fromEntries(codes.map((c) => [c, v]));
		const fresh = (): FreshnessSnapshot => ({
			daily: all(TODAY, DAILY_CODES),
			prices: all(TODAY, WATCHLIST),
			forced: all(TODAY, WATCHLIST),
			fundamentals: all(TODAY, WATCHLIST),
			premarket: TODAY,
			margin: "2026-11-06",
			investorFlows: "2026-11-06",
			marketShortRatio: "2026-11-12",
			earnings: TODAY,
			nextMacro: "2026-12-16",
		});

		it("全部揃っていれば空", () => {
			expect(staleSources(fresh(), TODAY)).toEqual([]);
		});

		it("TOPIX より遅れた銘柄別の表を挙げる", () => {
			const s = fresh();
			s.daily["6857"] = "2026-11-12";
			s.prices["6920"] = null;
			expect(staleSources(s, TODAY)).toEqual([
				"daily:6857 (最新 2026-11-12)",
				"prices:6920 (最新 なし)",
			]);
		});

		it("祝日で TOPIX が進まない日は、銘柄別が TOPIX と揃っていれば鳴らさない", () => {
			const s = fresh();
			for (const rows of [s.daily, s.prices, s.forced])
				for (const k of Object.keys(rows)) rows[k] = "2026-11-12";
			expect(staleSources(s, TODAY)).toEqual([]);
		});

		it("TOPIX・週次・日次の公表データは平日数の許容を超えたら挙げる", () => {
			const s = fresh();
			s.daily["0010"] = "2026-11-10"; // 3 平日遅れ
			s.margin = "2026-10-23"; // 15 平日
			s.marketShortRatio = "2026-11-12";
			s.nextMacro = null;
			s.premarket = "2026-11-12";
			expect(staleSources(s, TODAY)).toEqual(
				expect.arrayContaining([
					"daily:0010 (最新 2026-11-10)",
					"margin (最新 2026-10-23)",
					"premarket (最新 2026-11-12)",
					"macro-events (今後の FOMC/日銀なし)",
				]),
			);
			expect(staleSources(s, TODAY)).not.toContain(
				"market-short-ratio (最新 2026-11-12)",
			);
		});
	});
}
