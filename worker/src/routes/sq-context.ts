// Cloudflare Worker: sq-brief (SQ週の値動きシナリオ) に渡すコンテキストを 1 call で返す。
//
//   GET /sq-context?now=<ISO8601 任意>
//
// 出力構造:
//   { asof, market_phase, sq, event_context, premarket, live_indexes, market_short_ratio,
//     investor_flows, market: { nikkei225, topix, nt_ratio }, tickers: [{ code, name, sector_role,
//     history, week_to_date }] }
// sq は今週の日本SQ (SQ週でなければ次の SQ と in_week=false)。history は過去の SQ週の値動きと
// SQ連動度 (lib/sq-week)。日経225 と銘柄は TOPIX 比の超過分も持つ。

import { desc, eq } from "drizzle-orm";
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
import { daily, macroEvents } from "../lib/schema";
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

	const topix = await readBars(env, BENCHMARK_CODE);
	const nikkei = await readBars(env, NIKKEI225_CODE);
	const tickers = [];
	for (const t of WATCHLIST_META) {
		const bars = await readBars(env, t.code);
		tickers.push({
			code: t.code,
			name: t.name,
			sector_role: t.sector_role,
			history: buildSqHistory(bars, weekStart, topix),
			week_to_date: week ? buildSqWeekToDate(bars, weekStart, topix) : null,
		});
	}

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
				history: buildSqHistory(nikkei, weekStart, topix),
				week_to_date: week ? buildSqWeekToDate(nikkei, weekStart, topix) : null,
			},
			topix: {
				history: buildSqHistory(topix, weekStart),
				week_to_date: week ? buildSqWeekToDate(topix, weekStart) : null,
			},
			nt_ratio: buildNtRatio(nikkei, topix, weekStart),
		},
		tickers,
	});
});
