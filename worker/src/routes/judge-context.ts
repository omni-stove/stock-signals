// Cloudflare Worker: ticker-brief / crash-scenario / slack-reply に渡す数値コンテキストを
// 1 call で返すバンドルエンドポイント。
//
//   GET /judge-context?code=285A&now=<ISO8601 任意>
//
// 取得は D1/R2 直読み (サブリクエストなし)。正規化は lib/judge-context.ts に集約。
//
// 出力 (lib/judge-context.ts の JUDGE_BLOCKS。null・中身の無い status のブロックと特になしの
// event_context は compactJudgeContext が落とす):
//   { ticker, today, market_phase, market_brief, event_context, ticker_note,
//     context_body, earnings, earnings_result, revisions, valuation, premarket, sector, daily, trend,
//     relative, event_reactions, prices, margin, short_interest, supply, forced }
// sector は同一セクタ内での対象銘柄の順位・相対強弱とセクタ平均。trend / relative /
// event_reactions は約1年分の日足と TOPIX から、supply は適時開示・公式 IR の見出しと EDINET の
// 大量保有報告書から組む。
// 市場全体の需給 (投資部門別・東証全体の空売り比率) は market-brief 側に任せて載せない。
// now はテスト時刻注入兼用 (省略時はサーバ実時刻)。market_phase / today は JST 換算で出す。

import { and, desc, eq, gte, like, or } from "drizzle-orm";
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
	buildRevisions,
	buildValuation,
	compactJudgeContext,
	type ForcedRow,
	type ForecastSnapshot,
	type FundamentalsSnapshot,
	type MarginRow,
	type PremarketRow,
	type PriceRow,
} from "../lib/judge-context";
import { readLargeHoldings } from "../lib/large-holdings";
import { resolveMarketPhase, sessionElapsedFrac } from "../lib/market-phase";
import { PREMARKET_COLUMNS } from "../lib/premarket";
import {
	buildEventReactions,
	buildRelative,
	buildTrend,
} from "../lib/price-history";
import {
	articles,
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
	sectorForTicker,
} from "../lib/sectors";
import {
	buildLending,
	buildShortPositions,
	readShortInterest,
} from "../lib/short-interest";
import { buildSupply } from "../lib/supply-events";
import { BENCHMARK_CODE } from "../lib/timeseries";
import { TICKERS, WATCHLIST_META } from "../lib/watchlist";

// 52週高値・安値と MA75 に使う日足の本数 (約1年 + 余裕)。短期指標 (buildDaily) は直近 DAILY_SHORT 本で組む。
const DAILY_LONG = 260;
const DAILY_SHORT = 70;
// 材料の超過リターンと供給イベントを拾う見出しの遡り日数。
const ARTICLE_LOOKBACK_DAYS = 400;

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

	// fundamentals の日次スナップショット (date 降順)。actual_period の四半期切替で「決算が出た日」を、
	// 予想の発表日・予想値の変化で業績予想の修正を割り出すため、約1年遡る。
	const fundamentalsRows = (await db(env.DB)
		.select({
			date: fundamentals.date,
			per: fundamentals.per,
			pbr: fundamentals.pbr,
			dividend_yield: fundamentals.dividendYield,
			actual_eps: fundamentals.actualEps,
			actual_period: fundamentals.actualPeriod,
			forecast_eps: fundamentals.forecastEps,
			forecast_period: fundamentals.forecastPeriod,
			forecast_sales: fundamentals.forecastSales,
			forecast_ordinary: fundamentals.forecastOrdinary,
			forecast_net: fundamentals.forecastNet,
			forecast_dividend: fundamentals.forecastDividend,
			forecast_announced_at: fundamentals.forecastAnnouncedAt,
		})
		.from(fundamentals)
		.where(eq(fundamentals.ticker, code))
		.orderBy(desc(fundamentals.date))
		.limit(DAILY_LONG)
		.all()) as (FundamentalsSnapshot & ForecastSnapshot)[];

	// 同一セクタのピアの最新予想 PER (valuation の比較用)。
	const selfMeta = WATCHLIST_META.find((t) => t.code === code);
	const peerPers: { code: string; name: string; per: number | null }[] = [];
	for (const t of WATCHLIST_META) {
		if (t.code === code || !selfMeta?.sector || t.sector !== selfMeta.sector)
			continue;
		const row = await db(env.DB)
			.select({ per: fundamentals.per })
			.from(fundamentals)
			.where(eq(fundamentals.ticker, t.code))
			.orderBy(desc(fundamentals.date))
			.limit(1)
			.get();
		peerPers.push({ code: t.code, name: t.name, per: row?.per ?? null });
	}

	const dailyLong = (await db(env.DB)
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
		.limit(DAILY_LONG)
		.all()) as DailyRow[];
	const dailyRows = dailyLong.slice(0, DAILY_SHORT);
	const topixRows = await db(env.DB)
		.select({ date: daily.date, close: daily.close })
		.from(daily)
		.where(eq(daily.ticker, BENCHMARK_CODE))
		.orderBy(desc(daily.date))
		.limit(DAILY_LONG)
		.all();

	// 適時開示・公式 IR の見出し (材料の超過リターンと供給イベント用)。
	const articleSince = new Date(`${today}T00:00:00Z`);
	articleSince.setUTCDate(articleSince.getUTCDate() - ARTICLE_LOOKBACK_DAYS);
	const officialArticles = (
		await db(env.DB)
			.select({ date: articles.publishedAt, title: articles.title })
			.from(articles)
			.where(
				and(
					eq(articles.ticker, code),
					or(like(articles.source, "tdnet:%"), like(articles.source, "ir:%")),
					gte(articles.publishedAt, articleSince.toISOString().slice(0, 10)),
				),
			)
			.all()
	).flatMap((a) =>
		a.date && /^\d{4}-\d{2}-\d{2}$/.test(a.date)
			? [{ date: a.date, title: a.title }]
			: [],
	);

	const [shortInterest, largeHoldingRows] = await Promise.all([
		readShortInterest(env.DB, code),
		readLargeHoldings(env, code, today),
	]);

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
			fetched_at: prices.fetchedAt,
		})
		.from(prices)
		.where(eq(prices.ticker, code))
		.orderBy(desc(prices.fetchedAt))
		.limit(20)
		.all()) as PriceRow[];

	const premarketRow = (await db(env.DB)
		.select(PREMARKET_COLUMNS)
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
	const selfSector = selfMeta?.sector ?? null;
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

	return c.json(
		compactJudgeContext({
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
			revisions: buildRevisions(fundamentalsRows, today),
			valuation: buildValuation(fundamentalsRows, peerPers),
			premarket: premarketBlock,
			sector: sectorForTicker(sectorReports[0], code),
			daily: buildDaily(dailyRows, intradayVol, today),
			trend: buildTrend(dailyLong),
			relative: buildRelative(dailyLong, topixRows),
			event_reactions: buildEventReactions(
				officialArticles,
				dailyLong,
				topixRows,
				today,
			),
			prices: buildPrices(priceRows, epochNow),
			margin: buildMargin(marginRows),
			short_interest: {
				lending: buildLending(shortInterest.lending),
				positions: buildShortPositions(shortInterest.positions, today),
			},
			supply: buildSupply(officialArticles, today, largeHoldingRows),
			forced: buildForced(forcedRow ?? null),
		}),
	);
});
