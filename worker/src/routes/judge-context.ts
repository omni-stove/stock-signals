// Cloudflare Worker: signal-judge / crash-scenario / slack-reply に渡す数値コンテキストを
// 1 call で返すバンドルエンドポイント。
//
//   GET /judge-context?code=285A&now=<ISO8601 任意>
//
// 旧 scripts/judge-context.sh (= /context + /latest×5 の 6 call) + scripts/event-context.sh
// (= /latest?macro-events の 1 call) を Worker 1 call に集約 (計 7 call → 1)。
// 取得は D1/R2 直読み (サブリクエストなし)。正規化は lib/judge-context.ts に集約。
//
// 出力は旧 judge-context.sh の JSON に event_context (旧 event-context.sh の 1 行) を加えたもの:
//   { ticker, today, market_phase, event_context, context_body,
//     earnings, premarket, daily, prices, margin }
// now はテスト時刻注入兼用 (省略時はサーバ実時刻)。market_phase / today は JST 換算で出す。

import { desc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { db } from "../lib/db";
import type { Env } from "../lib/env";
import { buildEventContext, type MacroEventRow } from "../lib/event-context";
import type { DailyRow } from "../lib/indicators";
import {
	buildDaily,
	buildEarnings,
	buildMargin,
	buildPremarket,
	buildPrices,
	type MarginRow,
	type PremarketRow,
	type PriceRow,
} from "../lib/judge-context";
import { resolveMarketPhase } from "../lib/market-phase";
import {
	contexts,
	daily,
	earnings,
	macroEvents,
	margin,
	premarketBackdrop,
	prices,
} from "../lib/schema";

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

	// latest.ts の prices select と完全に揃える (latest=row全体を旧 judge-context.sh と一致させるため)。
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

	return c.json({
		ticker: code,
		today,
		market_phase: marketPhase,
		event_context: buildEventContext(today, macroRows),
		context_body: contextRow?.body ?? null,
		earnings: buildEarnings(earningsRow?.next_date ?? null, today),
		premarket: buildPremarket(premarketRow ?? null, epochNow),
		daily: buildDaily(dailyRows),
		prices: buildPrices(priceRows, epochNow),
		margin: buildMargin(marginRows),
	});
});
