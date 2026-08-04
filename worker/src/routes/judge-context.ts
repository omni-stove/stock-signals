// Cloudflare Worker: ticker-brief / crash-scenario / slack-reply に渡す数値コンテキストを
// 1 call で返すバンドルエンドポイント。
//
//   GET /judge-context?code=285A&now=<ISO8601 任意>
//
// 取得は D1/R2 直読み (サブリクエストなし)。正規化は lib/judge-context.ts に集約。
//
// 出力 (event_context は需給イベント1行、market_brief は当日朝のマーケットブリーフ / 無ければ null、
// forced は強制決済フローのスコア / stance==none なら {status:"none"}):
//   { ticker, today, market_phase, market_brief, event_context, ticker_note,
//     context_body, earnings, earnings_result, valuation, premarket, sector, daily, prices, margin, forced }
// sector は対象銘柄が属する同一セクタのピアの相対強弱 (無ければ null)。
// now はテスト時刻注入兼用 (省略時はサーバ実時刻)。market_phase / today は JST 換算で出す。

import { desc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { db } from "../lib/db";
import type { Env } from "../lib/env";
import { buildEventContext, type MacroEventRow } from "../lib/event-context";
import type { DailyRow } from "../lib/indicators";
import { avgVolume20d } from "../lib/indicators";
import {
	buildDaily,
	buildEarnings,
	buildEarningsResult,
	buildForced,
	buildMargin,
	buildPremarket,
	buildPrices,
	buildValuation,
	type ForcedRow,
	type FundamentalsSnapshot,
	type MarginRow,
	type PremarketRow,
	type PriceRow,
} from "../lib/judge-context";
import { resolveMarketPhase, sessionElapsedFrac } from "../lib/market-phase";
import {
	briefs,
	contexts,
	daily,
	earnings,
	forcedLiquidation,
	fundamentals,
	macroEvents,
	margin,
	premarketBackdrop,
	prices,
} from "../lib/schema";
import {
	buildSectors,
	type DailyBar,
	type PremarketLine,
} from "../lib/sectors";
import { TICKERS, WATCHLIST_META } from "../lib/watchlist";

export const judgeContext = new Hono<{ Bindings: Env }>();

judgeContext.get("/judge-context", async (c: Context<{ Bindings: Env }>) => {
	const env = c.env;
	const code = c.req.query("code") || "285A";
	const now = c.req.query("now") ?? null;
	const epochNow = Date.now();
	const { today, marketPhase } = resolveMarketPhase(now, epochNow);

	// すべて D1 直読み (latest.ts と同じ select 形)。
	const contextRow = await db(env.DB)
		.select({ body: contexts.body })
		.from(contexts)
		.where(eq(contexts.ticker, code))
		.limit(1)
		.get();

	const earningsRow = await db(env.DB)
		.select({ next_date: earnings.nextDate })
		.from(earnings)
		.where(eq(earnings.ticker, code))
		.get();

	// fundamentals の日次スナップショット (date 降順)。actual_period の四半期切替で
	// 「決算が出た日」を割り出すため、四半期 (約90日) を跨ぐ余裕を持って遡る。
	const fundamentalsRows = (await db(env.DB)
		.select({
			date: fundamentals.date,
			actual_eps: fundamentals.actualEps,
			actual_period: fundamentals.actualPeriod,
			forecast_eps: fundamentals.forecastEps,
		})
		.from(fundamentals)
		.where(eq(fundamentals.ticker, code))
		.orderBy(desc(fundamentals.date))
		.limit(120)
		.all()) as FundamentalsSnapshot[];

	const dailyRows = (await db(env.DB)
		.select({
			date: daily.date,
			open: daily.open,
			high: daily.high,
			low: daily.low,
			close: daily.close,
			changePct: daily.changePct,
			volume: daily.volume,
		})
		.from(daily)
		.where(eq(daily.ticker, code))
		.orderBy(desc(daily.date))
		.limit(70)
		.all()) as DailyRow[];

	// latest.ts の prices select と完全に揃える (row 全体)。
	const priceRows = (await db(env.DB)
		.select({
			ticker: prices.ticker,
			slot: prices.slot,
			price: prices.price,
			change: prices.change,
			change_pct: prices.changePct,
			volume: prices.volume,
			quote_time: prices.quoteTime,
			pts_price: prices.ptsPrice,
			fetched_at: prices.fetchedAt,
		})
		.from(prices)
		.where(eq(prices.ticker, code))
		.orderBy(desc(prices.fetchedAt))
		.limit(20)
		.all()) as PriceRow[];

	const premarketRow = (await db(env.DB)
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
		.get()) as PremarketRow | undefined;

	const marginRows = (await db(env.DB)
		.select({
			date: margin.date,
			long_qty: margin.longQty,
			short_qty: margin.shortQty,
			ratio: margin.ratio,
		})
		.from(margin)
		.where(eq(margin.ticker, code))
		.orderBy(desc(margin.date))
		.limit(4)
		.all()) as MarginRow[];

	// 強制決済フローの最新スコア (eod cron が算出済み)。「投げ/踏みが今日いつ出るか」を
	// judge が読む材料として渡す。post-signal.sh が末尾に貼る観測行とは別経路。
	const forcedRow = (await db(env.DB)
		.select({
			date: forcedLiquidation.date,
			direction: forcedLiquidation.direction,
			stance: forcedLiquidation.stance,
			fuel: forcedLiquidation.fuel,
			fire: forcedLiquidation.fire,
			exhaust: forcedLiquidation.exhaust,
			settle_warning_in_days: forcedLiquidation.settleWarningInDays,
			summary: forcedLiquidation.summary,
		})
		.from(forcedLiquidation)
		.where(eq(forcedLiquidation.ticker, code))
		.orderBy(desc(forcedLiquidation.date))
		.limit(1)
		.get()) as ForcedRow | undefined;

	// 当日朝のマーケットブリーフ (market-brief が寄り前に書いたもの、briefs の ticker='market' 行)。
	// 市場全体の事実サマリーとして ticker-brief / crash-scenario に market_brief として渡す。
	// briefedAt が JST 当日でなければ null (= 古い朝の材料を今日の地合いと誤読させない)。
	const marketBriefRow = await db(env.DB)
		.select({
			headline: briefs.headline,
			body: briefs.body,
			briefedAt: briefs.briefedAt,
		})
		.from(briefs)
		.where(eq(briefs.ticker, "market"))
		.get();
	const marketBriefDate = marketBriefRow
		? resolveMarketPhase(marketBriefRow.briefedAt, epochNow).today
		: null;

	// 需給イベント文脈: SQ/指数リバランスは today から計算、FOMC/日銀/ピア決算は macro_events 全件を渡す。
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

	// sectors: 対象銘柄と同一 sector のピアの相対強弱 (5日リターン差) を渡し、judge が
	// SOX/海外ピア決算という間接材料でなくセクタ内の実データで足場を持てるようにする。
	// 対象に sector が無ければ null。同一 sector メンバーの daily を 20 本ずつ引く (対象銘柄分は
	// 上の dailyRows を流用)。
	const selfSector =
		WATCHLIST_META.find((t) => t.code === code)?.sector ?? null;
	const sectorMeta = selfSector
		? WATCHLIST_META.filter((t) => t.sector === selfSector)
		: [];
	const sectorBarsByCode: Record<string, DailyBar[]> = {};
	for (const t of sectorMeta) {
		if (t.code === code) {
			sectorBarsByCode[t.code] = dailyRows as unknown as DailyBar[];
			continue;
		}
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
		sectorBarsByCode[t.code] = bars;
	}
	// premarket ブロックを先に組み、休場またぎ判定 (us_session) を sectors の backdrop にも渡す。
	const premarketBlock = buildPremarket(premarketRow ?? null, epochNow, today);
	const premarketLine: PremarketLine | null = premarketRow
		? {
				date: (premarketBlock.us_close_jst_date as string | null) ?? null,
				us_session: (premarketBlock.us_session as string | null) ?? null,
				sox_change_pct: premarketRow.sox_change_pct,
				nasdaq_change_pct: premarketRow.nasdaq_change_pct,
				dow_change_pct: premarketRow.dow_change_pct,
				nikkei_futures_price: premarketRow.nikkei_futures_price,
			}
		: null;
	const sectorReports = buildSectors(
		sectorMeta,
		premarketLine,
		sectorBarsByCode,
	);

	// ザラ場中 (前場/昼休み/後場) で daily にまだ当日行が無いとき、当日の vol_x を
	// prices の当日累積出来高からペース換算で組み立てて buildDaily に渡す。引け後や
	// 当日 daily が既にあるときは null (= vol_x_20d 本体が当日確定値なので intraday 不要)。
	const inSession =
		marketPhase === "morning_session" ||
		marketPhase === "lunch_break" ||
		marketPhase === "afternoon_session";
	const dailyLatestDate = dailyRows[0]?.date ?? null;
	const intradayVol =
		inSession && dailyLatestDate !== today
			? {
					cumVolume: priceRows[0]?.volume ?? null,
					elapsedFrac: sessionElapsedFrac(now, epochNow),
					avgVol20d: avgVolume20d(dailyRows),
				}
			: null;

	return c.json({
		ticker: code,
		today,
		market_phase: marketPhase,
		market_brief:
			marketBriefRow && marketBriefDate === today
				? {
						headline: marketBriefRow.headline,
						body: marketBriefRow.body,
						date: marketBriefDate,
					}
				: null,
		event_context: buildEventContext(today, macroRows, marketPhase),
		// 当該銘柄分の固定注記だけ同梱 (watchlist は静的、note 未設定なら null)。
		ticker_note: TICKERS.find((t) => t.code === code)?.note ?? null,
		context_body: contextRow?.body ?? null,
		earnings: buildEarnings(earningsRow?.next_date ?? null, today),
		earnings_result: buildEarningsResult(fundamentalsRows, today),
		// 現値 × 予想EPS の実績PER を watchlist の fair_per と突き合わせる (above/inline/below)。
		valuation: buildValuation(
			(priceRows[0]?.price as number | null) ?? null,
			fundamentalsRows[0]?.forecast_eps ?? null,
			TICKERS.find((t) => t.code === code)?.fair_per ?? null,
		),
		premarket: premarketBlock,
		// 対象銘柄が属する sector の1件だけ (rows は相対強弱の強い順)。sector 未設定なら null。
		sector: sectorReports[0] ?? null,
		daily: buildDaily(dailyRows, intradayVol, today),
		prices: buildPrices(priceRows, epochNow),
		margin: buildMargin(marginRows),
		forced: buildForced(forcedRow ?? null),
	});
});
