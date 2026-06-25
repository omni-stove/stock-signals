// Cloudflare Worker: D1 から最新行を返す (動作確認/ローカル連携用)。
//   /latest?kind=ir|prices|daily|fundamentals|margin|forced|premarket|earnings|macro-events&code=285A&n=10
//   kind 省略時は ir。

import { desc, eq, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../lib/db";
import type { Env } from "../lib/env";
import { withMovingAverages } from "../lib/indicators";
import { expandPremarketRows } from "../lib/premarket";
import {
	articles,
	daily,
	earnings,
	forcedLiquidation,
	fundamentals,
	macroEvents,
	margin,
	premarketBackdrop,
	prices,
} from "../lib/schema";

export const latest = new Hono<{ Bindings: Env }>();

latest.get("/", async (c) => {
	const env = c.env;
	const code = c.req.query("code") || "285A";
	const n = parseInt(c.req.query("n") || "10", 10);
	const kind = c.req.query("kind") || "ir";

	// premarket は銘柄別ではなく時刻別 (ticker 列が無い) なので専用に扱う。
	//   最新 n 件を fetched_at (UTC) DESC で返し、us_indexes_json はパースして展開する。
	//   寄り前ブリーフは通常 n=1 (最新の地合い1件) で読む。暦日は持たない。
	if (kind === "premarket") {
		// 出力 JSON のキーは snake_case。
		const results = await db(env.DB)
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
			.limit(n)
			.all();
		const rows = expandPremarketRows(results as Record<string, unknown>[]);
		return c.json({ ok: true, kind, rows });
	}

	// macro-events は銘柄非依存 (FOMC/日銀の会合日程)。ticker 列が無いので専用に扱う。
	//   既定では「今日以降の未来イベント」を effect_date (= jst_effect_date があればそれ、なければ date)
	//   昇順で返す。event-context.sh が近接 (直近5日) を prompt に乗せる用途。?all=1 で過去含む全件。
	if (kind === "macro-events") {
		const all = c.req.query("all") === "1";
		const today = new Date().toISOString().slice(0, 10);
		// 効果日 = jst_effect_date があればそれ、なければ date。並び/絞り込みの基準。
		const effectDate = sql`COALESCE(${macroEvents.jstEffectDate}, ${macroEvents.date})`;
		let qb = db(env.DB)
			.select({
				date: macroEvents.date,
				kind: macroEvents.kind,
				label: macroEvents.label,
				impact: macroEvents.impact,
				jst_effect_date: macroEvents.jstEffectDate,
				note: macroEvents.note,
			})
			.from(macroEvents)
			.orderBy(sql`${effectDate} ASC`)
			.$dynamic();
		if (!all) qb = qb.where(sql`${effectDate} >= ${today}`).limit(n);
		const results = await qb.all();
		return c.json({ ok: true, kind, rows: results });
	}

	// earnings は銘柄ごと1行 (ticker PK)。code 指定なら1件、なければ全銘柄を返す。
	//   signal-report は当該銘柄の next_date を読み、決算が近ければ confidence をキャップする。
	if (kind === "earnings") {
		const codeParam = c.req.query("code");
		let qb = db(env.DB)
			.select({
				ticker: earnings.ticker,
				next_date: earnings.nextDate,
				detail: earnings.detail,
				fetched_at: earnings.fetchedAt,
			})
			.from(earnings)
			.$dynamic();
		qb = codeParam
			? qb.where(eq(earnings.ticker, codeParam))
			: qb.orderBy(earnings.ticker);
		const results = await qb.all();
		return c.json({ ok: true, kind, rows: results });
	}

	// 種別 → (Drizzle テーブル, 並び順カラム, 取得列セレクト)。出力キーは snake_case 維持。
	//   全 kind とも ticker 列で当該銘柄を絞り、order DESC の最新 fetchN 件を返す。
	const LATEST: Record<
		string,
		{
			ticker: SQLiteColumn;
			order: SQLiteColumn;
			select: Record<string, SQLiteColumn>;
		}
	> = {
		ir: {
			ticker: articles.ticker,
			order: articles.publishedAt,
			select: {
				url: articles.url,
				title: articles.title,
				published_at: articles.publishedAt,
				ir_category: articles.irCategory,
				r2_key: articles.r2Key,
				fetched_at: articles.fetchedAt,
			},
		},
		prices: {
			ticker: prices.ticker,
			order: prices.fetchedAt,
			select: {
				ticker: prices.ticker,
				slot: prices.slot,
				price: prices.price,
				change: prices.change,
				change_pct: prices.changePct,
				volume: prices.volume,
				quote_time: prices.quoteTime,
				pts_price: prices.ptsPrice,
				fetched_at: prices.fetchedAt,
			},
		},
		daily: {
			ticker: daily.ticker,
			order: daily.date,
			select: {
				ticker: daily.ticker,
				date: daily.date,
				open: daily.open,
				high: daily.high,
				low: daily.low,
				close: daily.close,
				change: daily.change,
				change_pct: daily.changePct,
				volume: daily.volume,
			},
		},
		fundamentals: {
			ticker: fundamentals.ticker,
			order: fundamentals.date,
			select: {
				ticker: fundamentals.ticker,
				date: fundamentals.date,
				per: fundamentals.per,
				pbr: fundamentals.pbr,
				forecast_eps: fundamentals.forecastEps,
				forecast_period: fundamentals.forecastPeriod,
				actual_eps: fundamentals.actualEps,
				actual_period: fundamentals.actualPeriod,
				fetched_at: fundamentals.fetchedAt,
			},
		},
		margin: {
			ticker: margin.ticker,
			order: margin.date,
			select: {
				ticker: margin.ticker,
				date: margin.date,
				short_qty: margin.shortQty,
				long_qty: margin.longQty,
				ratio: margin.ratio,
				fetched_at: margin.fetchedAt,
			},
		},
		// 強制決済スコア (eod cron 算出済み)。date DESC 最新1件が通常。
		forced: {
			ticker: forcedLiquidation.ticker,
			order: forcedLiquidation.date,
			select: {
				ticker: forcedLiquidation.ticker,
				date: forcedLiquidation.date,
				direction: forcedLiquidation.direction,
				stance: forcedLiquidation.stance,
				fuel: forcedLiquidation.fuel,
				fire: forcedLiquidation.fire,
				exhaust: forcedLiquidation.exhaust,
				settle_warning_in_days: forcedLiquidation.settleWarningInDays,
				summary: forcedLiquidation.summary,
				fetched_at: forcedLiquidation.fetchedAt,
			},
		},
	};
	const q = LATEST[kind];
	if (!q)
		throw new HTTPException(400, {
			res: Response.json(
				{ ok: false, error: `unknown kind: ${kind}` },
				{ status: 400 },
			),
		});

	// daily は移動平均(5MA/25MA)を各行に同梱して「線」として返す。25MA に必要な分まで
	// 余分に取得してから計算し、要求された最新 n 件に切り詰める。
	const fetchN = kind === "daily" ? Math.max(n, 25) : n;
	const results = await db(env.DB)
		.select(q.select)
		.from(q.ticker.table)
		.where(eq(q.ticker, code))
		.orderBy(desc(q.order))
		.limit(fetchN)
		.all();

	if (kind === "daily") {
		// MA 計算は withMovingAverages に集約 (in-source test 対象)。
		const rows = withMovingAverages(results as Record<string, unknown>[], n);
		return c.json({ ok: true, kind, rows });
	}

	return c.json({ ok: true, kind, rows: results });
});
