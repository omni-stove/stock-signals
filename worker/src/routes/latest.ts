// Cloudflare Worker: D1 から最新行を返す (動作確認/ローカル連携用)。
//   /latest?kind=ir|prices|daily|fundamentals|margin|premarket|earnings|macro-events&code=285A&n=10
//   kind 省略時は ir。

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../lib/env";

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
		const { results } = await env.DB.prepare(
			`SELECT fetched_at, sox_change_pct, nasdaq_change_pct, dow_change_pct,
              nikkei_futures_price, nikkei_contract, us_indexes_json
         FROM premarket_backdrop ORDER BY fetched_at DESC LIMIT ?`,
		)
			.bind(n)
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
		const stmt = all
			? env.DB.prepare(
					`SELECT date, kind, label, impact, jst_effect_date, note FROM macro_events
             ORDER BY COALESCE(jst_effect_date, date) ASC`,
				)
			: env.DB.prepare(
					`SELECT date, kind, label, impact, jst_effect_date, note FROM macro_events
             WHERE COALESCE(jst_effect_date, date) >= ?
             ORDER BY COALESCE(jst_effect_date, date) ASC LIMIT ?`,
				).bind(today, n);
		const { results } = await stmt.all();
		return c.json({ ok: true, kind, rows: results });
	}

	// earnings は銘柄ごと1行 (ticker PK)。code 指定なら1件、なければ全銘柄を返す。
	//   signal-report は当該銘柄の next_date を読み、決算が近ければ confidence をキャップする。
	if (kind === "earnings") {
		const codeParam = c.req.query("code");
		const stmt = codeParam
			? env.DB.prepare(
					"SELECT ticker, next_date, detail, fetched_at FROM earnings WHERE ticker = ?",
				).bind(codeParam)
			: env.DB.prepare(
					"SELECT ticker, next_date, detail, fetched_at FROM earnings ORDER BY ticker",
				);
		const { results } = await stmt.all();
		return c.json({ ok: true, kind, rows: results });
	}

	// 種別 → (テーブル, 並び順カラム, 取得カラム)。SQL 識別子はホワイトリストのみ。
	const LATEST: Record<string, { table: string; order: string; cols: string }> =
		{
			ir: {
				table: "articles",
				order: "published_at",
				cols: "url, title, published_at, ir_category, r2_key, fetched_at",
			},
			prices: {
				table: "prices",
				order: "fetched_at",
				cols: "ticker, slot, price, change, change_pct, volume, quote_time, pts_price, fetched_at",
			},
			daily: {
				table: "daily",
				order: "date",
				cols: "ticker, date, open, high, low, close, change, change_pct, volume",
			},
			fundamentals: {
				table: "fundamentals",
				order: "date",
				cols: "ticker, date, per, pbr, forecast_eps, forecast_period, actual_eps, actual_period, fetched_at",
			},
			margin: {
				table: "margin",
				order: "date",
				cols: "ticker, date, short_qty, long_qty, ratio, fetched_at",
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
	const { results } = await env.DB.prepare(
		`SELECT ${q.cols} FROM ${q.table} WHERE ticker = ? ORDER BY ${q.order} DESC LIMIT ?`,
	)
		.bind(code, fetchN)
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
