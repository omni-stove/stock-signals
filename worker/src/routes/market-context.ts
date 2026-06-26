// Cloudflare Worker: market-check に渡す地合い (market regime) コンテキストを 1 call で返す。
//
//   GET /market-context?now=<ISO8601 任意>
//
// 取得は D1 直読み。出力構造:
//   { asof, market_phase, event_context, premarket, sectors }
//
// premarket は judge-context と違い us_indexes / date も載せる (市場全体の地合い判定に使うため)。

import { desc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { db } from "../lib/db";
import type { Env } from "../lib/env";
import { buildEventContext, type MacroEventRow } from "../lib/event-context";
import { resolveMarketPhase } from "../lib/market-phase";
import { buildPremarketBlock, parseUsIndexes } from "../lib/premarket";
import {
	daily,
	macroEvents,
	marketNews,
	premarketBackdrop,
} from "../lib/schema";
import {
	buildSectors,
	type DailyBar,
	type PremarketLine,
} from "../lib/sectors";
import { WATCHLIST_META } from "../lib/watchlist";

export const marketContext = new Hono<{ Bindings: Env }>();

marketContext.get("/market-context", async (c: Context<{ Bindings: Env }>) => {
	const env = c.env;
	const now = c.req.query("now") ?? null;
	const epochNow = Date.now();
	const { today, marketPhase } = resolveMarketPhase(now, epochNow);

	// premarket 最新 1 行 (us_indexes_json はパースして展開する)。
	const pmRow = await db(env.DB)
		.select({
			fetched_at: premarketBackdrop.fetchedAt,
			sox_change_pct: premarketBackdrop.soxChangePct,
			nasdaq_change_pct: premarketBackdrop.nasdaqChangePct,
			dow_change_pct: premarketBackdrop.dowChangePct,
			nikkei_futures_price: premarketBackdrop.nikkeiFuturesPrice,
			nikkei_contract: premarketBackdrop.nikkeiContract,
			us_indexes_json: premarketBackdrop.usIndexesJson,
		})
		.from(premarketBackdrop)
		.orderBy(desc(premarketBackdrop.fetchedAt))
		.limit(1)
		.get();

	const usIndexes = parseUsIndexes(
		pmRow?.us_indexes_json,
	) as PremarketLine["us_indexes"];

	// premarket ブロック (鮮度判定 age>20h で stale)。整形は lib/premarket に集約。
	// premarket_backdrop に date 列は無い (PK=fetched_at) ので date は常に null。
	const premarketBlock = buildPremarketBlock(pmRow ?? null, epochNow);
	const premarketLine: PremarketLine | null = pmRow
		? {
				date: null,
				sox_change_pct: pmRow.sox_change_pct,
				nasdaq_change_pct: pmRow.nasdaq_change_pct,
				dow_change_pct: pmRow.dow_change_pct,
				nikkei_futures_price: pmRow.nikkei_futures_price,
				us_indexes: usIndexes,
			}
		: null;

	// sectors: watchlist 各銘柄の daily を 20 本ずつ引いて集計する。
	const barsByCode: Record<string, DailyBar[]> = {};
	for (const t of WATCHLIST_META) {
		const bars = (await db(env.DB)
			.select({
				date: daily.date,
				close: daily.close,
				change_pct: daily.changePct,
				volume: daily.volume,
			})
			.from(daily)
			.where(eq(daily.ticker, t.code))
			.orderBy(desc(daily.date))
			.limit(20)
			.all()) as DailyBar[];
		barsByCode[t.code] = bars;
	}
	const sectorReports = buildSectors(WATCHLIST_META, premarketLine, barsByCode);

	// market_news 最新 8 件 (半導体/AI/金利/米国市場のテーマ見出し)。地合いの tilt を肉付けする材料。
	// 本文ではなく見出し + topic + 日時だけ渡す (premarket が主、これは補強)。
	const newsRows = await db(env.DB)
		.select({
			title: marketNews.title,
			topic: marketNews.topic,
			published_at: marketNews.publishedAt,
		})
		.from(marketNews)
		.orderBy(desc(marketNews.fetchedAt))
		.limit(8)
		.all();

	// macro_events 全件 (SQ/指数は today から計算、FOMC/日銀/ピアは rows から近接抽出)。
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
		event_context: buildEventContext(today, macroRows, marketPhase),
		premarket: premarketBlock,
		sectors:
			sectorReports.length > 0
				? { status: "ok", sectors: sectorReports }
				: { status: "unavailable", sectors: [] },
		market_news: newsRows,
	});
});
