// Cloudflare Worker: sq-brief (SQ週の値動きシナリオ) に渡すコンテキストを 1 call で返す。
//
//   GET /sq-context?now=<ISO8601 任意>
//
// 出力構造:
//   { asof, market_phase, sq, event_context, premarket, live_indexes, market_short_ratio,
//     investor_flows, market: { nikkei225, topix, nt_ratio }, tickers: [{ code, name, sector_role,
//     history, week_to_date }] }
// sq は今週の日本SQ (SQ週でなければ次の SQ と in_week=false)。history は過去の SQ週の値動きと
// SQ連動度 (lib/sq-week)。日経225 と銘柄は TOPIX 比の超過分も持つ。各回の備考のタグは macro_events と、
// 銘柄なら決算発表日 (articles の決算短信の日付 + earnings.detail の直近 2 回) から付ける。

import { and, desc, eq, like, notLike } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { db } from "../lib/db";
import type { Env } from "../lib/env";
import {
	addDaysYmd,
	buildEventContext,
	jpSqDates,
	jpSqWeek,
	type MacroEventRow,
} from "../lib/event-context";
import { buildInvestorFlows, readInvestorFlows } from "../lib/investor-flows";
import { buildLiveIndexesBlock } from "../lib/live-indexes";
import { resolveMarketPhase } from "../lib/market-phase";
import { articles, daily, earnings, macroEvents } from "../lib/schema";
import {
	buildMarketShortRatio,
	readMarketShortRatio,
} from "../lib/short-interest";
import {
	buildNtRatio,
	buildSqHistory,
	buildSqWeekToDate,
	type SqBar,
} from "../lib/sq-week";
import { BENCHMARK_CODE, NIKKEI225_CODE } from "../lib/timeseries";
import { WATCHLIST_META } from "../lib/watchlist";
import { readMarketBackdrop } from "./market-context";

// 約1年分 (= SQ 約12回) の日足。
const DAILY_ROWS = 300;

async function readBars(env: Env, code: string): Promise<SqBar[]> {
	return (await db(env.DB)
		.select({
			date: daily.date,
			open: daily.open,
			close: daily.close,
			volume: daily.volume,
		})
		.from(daily)
		.where(eq(daily.ticker, code))
		.orderBy(desc(daily.date))
		.limit(DAILY_ROWS)
		.all()) as SqBar[];
}

// 決算発表日 (YYYY-MM-DD)。決算短信の掲載日と、earnings.detail に残る直近 2 回の発表日を合わせる。
async function readEarningsDates(env: Env, code: string): Promise<string[]> {
	const rows = await db(env.DB)
		.select({ published_at: articles.publishedAt })
		.from(articles)
		.where(
			and(
				eq(articles.ticker, code),
				like(articles.title, "%決算短信%"),
				notLike(articles.title, "%訂正%"),
			),
		)
		.all();
	const next = await db(env.DB)
		.select({ detail: earnings.detail })
		.from(earnings)
		.where(eq(earnings.ticker, code))
		.get();
	const dates = new Set<string>();
	for (const r of rows) {
		const d = r.published_at?.slice(0, 10);
		if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) dates.add(d);
	}
	for (const m of next?.detail?.matchAll(/\((\d{4}-\d{2}-\d{2})\)/g) ?? [])
		dates.add(m[1]);
	return [...dates].sort();
}

export const sqContext = new Hono<{ Bindings: Env }>();

sqContext.get("/sq-context", async (c: Context<{ Bindings: Env }>) => {
	const env = c.env;
	const now = c.req.query("now") ?? null;
	const epochNow = Date.now();
	const { today, marketPhase } = resolveMarketPhase(now, epochNow);

	const week = jpSqWeek(today);
	const next = week ?? jpSqDates(today, addDaysYmd(today, 40))[0];
	const weekStart = week?.week_start ?? today;
	const sq = {
		date: next.date,
		month: next.month,
		major: next.major,
		in_week: week != null,
		days_to_sq: week?.days_to_sq ?? null,
		week_start: week?.week_start ?? null,
	};

	const { premarketBlock, liveIndexRows } = await readMarketBackdrop(
		env,
		epochNow,
		today,
	);

	const macroRows = (await db(env.DB)
		.select({
			date: macroEvents.date,
			kind: macroEvents.kind,
			label: macroEvents.label,
			impact: macroEvents.impact,
			jst_effect_date: macroEvents.jstEffectDate,
		})
		.from(macroEvents)
		.all()) as MacroEventRow[];

	const topix = await readBars(env, BENCHMARK_CODE);
	const nikkei = await readBars(env, NIKKEI225_CODE);
	const tickers = [];
	for (const t of WATCHLIST_META) {
		const bars = await readBars(env, t.code);
		tickers.push({
			code: t.code,
			name: t.name,
			sector_role: t.sector_role,
			history: buildSqHistory(bars, weekStart, topix, {
				code: t.code,
				earningsDates: await readEarningsDates(env, t.code),
				macroRows,
			}),
			week_to_date: week ? buildSqWeekToDate(bars, weekStart, topix) : null,
		});
	}

	return c.json({
		asof: today,
		market_phase: marketPhase,
		sq,
		event_context: buildEventContext(today, macroRows, marketPhase),
		premarket: premarketBlock,
		live_indexes: buildLiveIndexesBlock(liveIndexRows, epochNow),
		market_short_ratio: buildMarketShortRatio(
			await readMarketShortRatio(env.DB),
		),
		investor_flows: buildInvestorFlows(await readInvestorFlows(env.DB)),
		market: {
			nikkei225: {
				history: buildSqHistory(nikkei, weekStart, topix, { macroRows }),
				week_to_date: week ? buildSqWeekToDate(nikkei, weekStart, topix) : null,
			},
			topix: {
				history: buildSqHistory(topix, weekStart, undefined, { macroRows }),
				week_to_date: week ? buildSqWeekToDate(topix, weekStart) : null,
			},
			nt_ratio: buildNtRatio(nikkei, topix, weekStart),
		},
		tickers,
	});
});
