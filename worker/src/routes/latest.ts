// Cloudflare Worker: D1 から最新行を返す (動作確認/ローカル連携用)。
//   /latest?kind=ir|prices|daily|fundamentals|margin|premarket|earnings|macro-events&code=285A&n=10
//   kind 省略時は ir。

import { desc, eq, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../lib/db";
import type { Env } from "../lib/env";
import {
	articles,
	daily,
	earnings,
	fundamentals,
	macroEvents,
	margin,
	premarketBackdrop,
	prices,
} from "../lib/schema";

export const latest = new Hono<{ Bindings: Env }>();

// daily 行 (date DESC = 新しい順) に終値の移動平均 ma5/ma25 を付与し、新しい順の最新 n 件を返す。
// 各日について「その日を含む過去 w 日」の終値平均を出す。期間に満たない古い日は null。
// D1 から切り離した純粋関数 (in-source test 対象)。入力 rows は破壊しない。
function withMovingAverages(
	rows: Record<string, unknown>[],
	n: number,
): Record<string, unknown>[] {
	const asc = rows.slice().reverse(); // 古い順
	const closes = asc.map((r) => Number(r.close));
	const ma = (i: number, w: number): number | null => {
		if (i + 1 < w) return null; // 期間に満たない古い日は null
		const sum = closes.slice(i + 1 - w, i + 1).reduce((a, b) => a + b, 0);
		return Math.round((sum / w) * 100) / 100;
	};
	const withMa = asc.map((r, i) => ({ ...r, ma5: ma(i, 5), ma25: ma(i, 25) }));
	return withMa.reverse().slice(0, n); // 新しい順に戻し、要求件数へ
}

latest.get("/", async (c) => {
	const env = c.env;
	const code = c.req.query("code") || "285A";
	const n = parseInt(c.req.query("n") || "10", 10);
	const kind = c.req.query("kind") || "ir";

	// premarket は銘柄別ではなく時刻別 (ticker 列が無い) なので専用に扱う。
	//   最新 n 件を fetched_at (UTC) DESC で返し、us_indexes_json はパースして展開する。
	//   寄り前ブリーフは通常 n=1 (最新の地合い1件) で読む。暦日は持たない。
	if (kind === "premarket") {
		// 出力 JSON のキーは従来の snake_case を維持 (context-builder 等の読み手が依存)。
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
		const rows = (results as Record<string, unknown>[]).map((r) => {
			const { us_indexes_json, ...rest } = r;
			let us_indexes: unknown = [];
			try {
				us_indexes = JSON.parse((us_indexes_json as string) || "[]");
			} catch {
				us_indexes = [];
			}
			return { ...rest, us_indexes };
		});
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

// in-source tests (本番ビルドでは tree-shake される。vitest.config.ts 参照)。
// D1 を伴うハンドラ本体ではなく、切り出した MA 計算ロジックだけを検証する。
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("withMovingAverages", () => {
		// date DESC (新しい順) の終値列を作る。close=1..N で新しいものほど大きい。
		const rowsDesc = (n: number) =>
			Array.from({ length: n }, (_, i) => ({
				date: `d${n - i}`,
				close: n - i,
			}));

		it("ma5 は直近5日の終値平均、満たない最古日は null", () => {
			// close (古→新) = 1,2,3,4,5,6 → 新しい順 6,5,4,3,2,1
			const out = withMovingAverages(rowsDesc(6), 6);
			// 先頭 (最新, close=6) の ma5 = (2+3+4+5+6)/5 = 4
			expect(out[0].ma5).toBe(4);
			// close=5 の日 = (1+2+3+4+5)/5 = 3
			expect(out[1].ma5).toBe(3);
			// 最古 (close=1) は 5 日に満たないので null
			expect(out[out.length - 1].ma5).toBeNull();
		});

		it("25日に満たないと ma25 は全行 null", () => {
			const out = withMovingAverages(rowsDesc(10), 10);
			expect(out.every((r) => r.ma25 === null)).toBe(true);
		});

		it("ma25 は 25 日揃った日から算出される", () => {
			const out = withMovingAverages(rowsDesc(30), 30);
			expect(out[0].ma25).not.toBeNull(); // 最新日は揃っている
			expect(out[out.length - 1].ma25).toBeNull(); // 最古日は満たない
		});

		it("新しい順を保ち、要求件数 n に切り詰める", () => {
			const out = withMovingAverages(rowsDesc(30), 5);
			expect(out).toHaveLength(5);
			expect(out[0].close).toBe(30); // 先頭が最新
			expect(out[4].close).toBe(26);
		});

		it("入力配列を破壊しない", () => {
			const input = rowsDesc(3);
			const snapshot = JSON.stringify(input);
			withMovingAverages(input, 3);
			expect(JSON.stringify(input)).toBe(snapshot);
		});
	});
}
