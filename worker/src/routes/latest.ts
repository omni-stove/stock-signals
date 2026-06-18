// Cloudflare Worker: D1 から最新行を返す (動作確認/ローカル連携用)。
//   /latest?kind=ir|prices|daily|fundamentals|premarket|earnings&code=285A&n=10
//   kind 省略時は ir。

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../lib/env";

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
		// results は date DESC(新しい順)。各日について「その日を含む過去 w 日」の終値平均を出す。
		const asc = (results as Record<string, unknown>[]).slice().reverse(); // 古い順
		const closes = asc.map((r) => Number(r.close));
		const ma = (i: number, w: number): number | null => {
			if (i + 1 < w) return null; // 期間に満たない古い日は null
			const sum = closes.slice(i + 1 - w, i + 1).reduce((a, b) => a + b, 0);
			return Math.round((sum / w) * 100) / 100;
		};
		const withMa = asc.map((r, i) => ({
			...r,
			ma5: ma(i, 5),
			ma25: ma(i, 25),
		}));
		const rows = withMa.reverse().slice(0, n); // 新しい順に戻し、要求件数へ
		return c.json({ ok: true, kind, rows });
	}

	return c.json({ ok: true, kind, rows: results });
});
