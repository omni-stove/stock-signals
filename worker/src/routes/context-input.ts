// Cloudflare Worker: context-builder に渡す入力 (既存コンテキスト本文 + カーソル以降の新規 IR/ニュース)
// を 1 つの JSON にまとめて返すバンドルエンドポイント。
//
//   GET /context-input?code=285A
//
// 旧 scripts/context-input.sh (= /context + /pull + /pull-news の 3 call) を Worker 1 call に集約。
// 出力構造・status 値は旧 sh と完全一致させる (context-builder skill が読む):
//   status:"no-update" … 新規 IR/ニュースが両方 0 → skill は本文も dispatch も触らない
//   status:"ok"        … 新規あり → skill は items を読んで本文を再生成する
//
// カーソル未確立 (初回・行なし) は since 省略で backlog を引く。次カーソル = 引いた行の max fetched_at、
// 0 件の kind は現行カーソルを据え置く (context-builder が POST /context する際にそのまま渡す)。

import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { db } from "../lib/db";
import type { Env } from "../lib/env";
import { contexts } from "../lib/schema";
import { type PullRow, pullArticles } from "./pull";

export const contextInput = new Hono<{ Bindings: Env }>();

const LIMIT = 20;

// rows (fetched_at ASC) の最大 fetched_at。0 件なら現行カーソルを据え置く。
function nextCursor(rows: PullRow[], current: string | null): string | null {
	if (rows.length === 0) return current;
	return rows.reduce(
		(max, r) => (r.fetched_at > max ? r.fetched_at : max),
		rows[0].fetched_at,
	);
}

contextInput.get("/context-input", async (c: Context<{ Bindings: Env }>) => {
	const env = c.env;
	const code = c.req.query("code") || "285A";

	// 既存コンテキスト本文 + 2カーソル。行が無ければ初回扱い (body 空・カーソル null)。
	const row = await db(env.DB)
		.select({
			body: contexts.body,
			irLastFetchedAt: contexts.irLastFetchedAt,
			newsLastFetchedAt: contexts.newsLastFetchedAt,
		})
		.from(contexts)
		.where(eq(contexts.ticker, code))
		.limit(1)
		.get();

	const body = row?.body ?? "";
	const irCursor = row?.irLastFetchedAt ?? null;
	const newsCursor = row?.newsLastFetchedAt ?? null;

	// カーソル以降の新規を IR / ニュース別に引く (本文 R2 同梱)。
	const irRows = await pullArticles(env, code, irCursor, LIMIT, false);
	const newsRows = await pullArticles(env, code, newsCursor, LIMIT, true);

	// 両方 0 → no-update。skill は本文も dispatch も触らない。
	if (irRows.length === 0 && newsRows.length === 0) {
		return c.json({
			ticker: code,
			status: "no-update",
			ir_count: 0,
			news_count: 0,
		});
	}

	return c.json({
		ticker: code,
		status: "ok",
		context_body: body,
		cursors: {
			ir: { current: irCursor, next: nextCursor(irRows, irCursor) },
			news: { current: newsCursor, next: nextCursor(newsRows, newsCursor) },
		},
		ir_count: irRows.length,
		news_count: newsRows.length,
		ir_items: irRows,
		news_items: newsRows,
	});
});
