// Cloudflare Worker: signal-judge / crash-scenario / slack-reply に渡す数値コンテキストを
// 1 call で返すバンドルエンドポイント。
//
//   GET /judge-context?code=285A&now=<ISO8601 任意>
//
// 取得は D1/R2 直読み (サブリクエストなし)。正規化は lib/judge-context.ts に集約。
//
// 出力 (event_context は需給イベント1行、market_regime は当日の market-check 地合いコール / 無ければ null、
// forced は強制決済フローのスコア / stance==none なら {status:"none"}):
//   { ticker, today, market_phase, market_regime, event_context, ticker_note,
//     context_body, earnings, earnings_result, premarket, daily, prices, margin, forced }
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
	type ForcedRow,
	type FundamentalsSnapshot,
	type MarginRow,
	type PremarketRow,
	type PriceRow,
} from "../lib/judge-context";
import { resolveMarketPhase, sessionElapsedFrac } from "../lib/market-phase";
import {
	contexts,
	daily,
	earnings,
	forcedLiquidation,
	fundamentals,
	macroEvents,
	margin,
	marketRegime,
	premarketBackdrop,
	prices,
} from "../lib/schema";
import { TICKERS } from "../lib/watchlist";

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

	// 当日の地合いコール (market-check が寄り前に書いたもの)。前段ゲートとして signal-judge /
	// crash-scenario に market_regime として渡す。当日分が無ければ null (= 銘柄単体で判断)。
	const regimeRow = await db(env.DB)
		.select({
			regime: marketRegime.regime,
			stance: marketRegime.stance,
			headline: marketRegime.headline,
		})
		.from(marketRegime)
		.where(eq(marketRegime.date, today))
		.get();

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
		market_regime: regimeRow
			? {
					regime: regimeRow.regime,
					stance: regimeRow.stance,
					headline: regimeRow.headline,
				}
			: null,
		event_context: buildEventContext(today, macroRows, marketPhase),
		// 当該銘柄分の固定注記だけ同梱 (watchlist は静的、note 未設定なら null)。
		ticker_note: TICKERS.find((t) => t.code === code)?.note ?? null,
		context_body: contextRow?.body ?? null,
		earnings: buildEarnings(earningsRow?.next_date ?? null, today),
		earnings_result: buildEarningsResult(fundamentalsRows, today),
		premarket: buildPremarket(premarketRow ?? null, epochNow),
		daily: buildDaily(dailyRows, intradayVol),
		prices: buildPrices(priceRows, epochNow),
		margin: buildMargin(marginRows),
		forced: buildForced(forcedRow ?? null),
	});
});
