// Cloudflare Worker: market-brief (朝のマーケットブリーフ) に渡す市場コンテキストを 1 call で返す。
//
//   GET /market-context?now=<ISO8601 任意>
//
// 取得は D1 直読み。出力構造:
//   { asof, market_phase, event_context, premarket, us_peers, live_indexes, sectors, market_news,
//     investor_flows, market_short_ratio }
//
// premarket は judge-context と違い us_indexes / date も載せる (市場全体のマーケットブリーフに使うため)。
// us_peers は海外ピア個別株の前夜の騰落 (決算日に当たる銘柄は終値に反映済みか付き)。
// live_indexes は場中に同時進行で動く指数 (日経225/KOSPI) の最新現値 (premarket=前夜確定 と対)。

import { desc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { db } from "../lib/db";
import type { Env } from "../lib/env";
import { buildEventContext, type MacroEventRow } from "../lib/event-context";
import { buildInvestorFlows, readInvestorFlows } from "../lib/investor-flows";
import { buildLiveIndexesBlock, type LiveIndexRow } from "../lib/live-indexes";
import { resolveMarketPhase } from "../lib/market-phase";
import {
	buildPremarketBlock,
	buildUsPeersBlock,
	PREMARKET_COLUMNS,
	parseUsIndexes,
} from "../lib/premarket";
import {
	daily,
	liveIndexes,
	macroEvents,
	marketNews,
	premarketBackdrop,
} from "../lib/schema";
import {
	buildSectors,
	type DailyBar,
	type PremarketLine,
} from "../lib/sectors";
import {
	buildMarketShortRatio,
	readMarketShortRatio,
} from "../lib/short-interest";
import { WATCHLIST_META } from "../lib/watchlist";

// 寄り前の地合い (premarket 最新 1 行) と場中の指数 (日経225/KOSPI の最新現値) を読む。
// sq-context も同じものを使う。
export async function readMarketBackdrop(
	env: Env,
	epochNow: number,
	today: string,
) {
	// premarket 最新 1 行 (us_indexes_json はパースして展開する)。
	const pmRow = await db(env.DB)
		.select(PREMARKET_COLUMNS)
		.from(premarketBackdrop)
		.orderBy(desc(premarketBackdrop.fetchedAt))
		.limit(1)
		.get();

	const usIndexes = parseUsIndexes(
		pmRow?.us_indexes_json,
	) as PremarketLine["us_indexes"];

	// live_indexes: key ごとに最新 1 行 (fetched_at DESC)。key 数は少ないので key 別に引く。
	const liveIndexRows: LiveIndexRow[] = [];
	for (const key of ["nikkei225", "kospi"]) {
		const row = await db(env.DB)
			.select({
				key: liveIndexes.key,
				price: liveIndexes.price,
				change: liveIndexes.change,
				change_pct: liveIndexes.changePct,
				quote_time: liveIndexes.quoteTime,
				fetched_at: liveIndexes.fetchedAt,
			})
			.from(liveIndexes)
			.where(eq(liveIndexes.key, key))
			.orderBy(desc(liveIndexes.fetchedAt))
			.limit(1)
			.get();
		if (row) liveIndexRows.push(row);
	}

	// premarket ブロック (鮮度判定 age>20h で stale、休場またぎ判定 us_session)。
	// 整形は lib/premarket に集約。date は jst_time から解決した米国クローズの JST 暦日。
	const premarketBlock = buildPremarketBlock(pmRow ?? null, epochNow, today);
	const premarketLine: PremarketLine | null = pmRow
		? {
				date: (premarketBlock.date as string | null) ?? null,
				us_session: (premarketBlock.us_session as string | null) ?? null,
				sox_change_pct: pmRow.sox_change_pct,
				nasdaq_change_pct: pmRow.nasdaq_change_pct,
				dow_change_pct: pmRow.dow_change_pct,
				nikkei_futures_price: pmRow.nikkei_futures_price,
				us_indexes: usIndexes,
			}
		: null;
	return { pmRow, premarketBlock, premarketLine, liveIndexRows };
}

export const marketContext = new Hono<{ Bindings: Env }>();

marketContext.get("/market-context", async (c: Context<{ Bindings: Env }>) => {
	const env = c.env;
	const now = c.req.query("now") ?? null;
	const epochNow = Date.now();
	const { today, marketPhase } = resolveMarketPhase(now, epochNow);

	const { pmRow, premarketBlock, premarketLine, liveIndexRows } =
		await readMarketBackdrop(env, epochNow, today);

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
		us_peers: buildUsPeersBlock(
			pmRow?.us_peers_json,
			pmRow?.fetched_at,
			(premarketBlock.date as string | null) ?? null,
			macroRows,
		),
		live_indexes: buildLiveIndexesBlock(liveIndexRows, epochNow),
		sectors:
			sectorReports.length > 0
				? { status: "ok", sectors: sectorReports }
				: { status: "unavailable", sectors: [] },
		market_news: newsRows,
		investor_flows: buildInvestorFlows(await readInvestorFlows(env.DB)),
		market_short_ratio: buildMarketShortRatio(
			await readMarketShortRatio(env.DB),
		),
	});
});
