// Cloudflare Worker: 銘柄コンテキスト (living document) の read/write ルート。
//   GET  /context?code=285A          … その銘柄の本文 + 2カーソル (IR / news) を返す
//   POST /context (JSON)             … 本文とカーソルを 1 行 upsert する (全面上書き)
//
// 銘柄の living document を D1 (contexts テーブル) に持つ。
// POST は本文の全面上書きとカーソル前進を 1 回の upsert で原子的に行う
// (本文だけ進む/カーソルだけ進む を構造的に排除)。
//
// カーソル未確立 (初回・行なし) は cursors を null で返す → /pull は since 省略で backlog を引く。

import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type ContextSection, sectionsToText } from "../lib/context-format";
import { db } from "../lib/db";
import type { Env } from "../lib/env";
import { contexts } from "../lib/schema";

export const context = new Hono<{ Bindings: Env }>();

// GET /context?code=285A
//   行が無ければ exists=false, body=null, カーソルも null (初回扱い)。
context.get("/context", async (c: Context<{ Bindings: Env }>) => {
	const env = c.env;
	const code = c.req.query("code") || "285A";

	const row = await db(env.DB)
		.select({
			body: contexts.body,
			irLastFetchedAt: contexts.irLastFetchedAt,
			newsLastFetchedAt: contexts.newsLastFetchedAt,
			updatedAt: contexts.updatedAt,
		})
		.from(contexts)
		.where(eq(contexts.ticker, code))
		.limit(1)
		.get();

	if (!row) {
		return c.json({
			ok: true,
			code,
			exists: false,
			body: null,
			cursors: { ir: null, news: null },
			updated_at: null,
		});
	}
	return c.json({
		ok: true,
		code,
		exists: true,
		body: row.body,
		cursors: { ir: row.irLastFetchedAt, news: row.newsLastFetchedAt },
		updated_at: row.updatedAt,
	});
});

// POST /context  body(JSON): { code, title, sections, ir_cursor?, news_cursor? }
//   title    … 見出しタイトル (例 "[285A キオクシア] 銘柄コンテキスト")。
//   sections … [{heading, lines[]}] (context-builder の構造化出力。Markdown 記号なし)。
//   body は保存しない: sections から sectionsToText で素テキストを組んで D1 に入れる
//     (judge-context / context-builder 再生入力が読む本文) のと同時に、sections JSON も控える
//     (Slack 通知の blocks 化用)。
//   ir_cursor / news_cursor は次回 /pull の since (= 今回引いた行の max fetched_at)。
//   0 件だった kind は現行値を据え置くため、呼び出し側が現行カーソルをそのまま渡すこと。
//   省略 (undefined) は null として保存される。
context.post("/context", async (c: Context<{ Bindings: Env }>) => {
	const env = c.env;
	const b = (await c.req.json().catch(() => ({}))) as {
		code?: string;
		title?: string;
		sections?: ContextSection[];
		ir_cursor?: string | null;
		news_cursor?: string | null;
	};
	if (
		!b.code ||
		typeof b.title !== "string" ||
		!Array.isArray(b.sections) ||
		b.sections.length === 0
	) {
		throw new HTTPException(400, {
			res: Response.json(
				{ ok: false, error: "code, title (string), sections (array) required" },
				{ status: 400 },
			),
		});
	}
	const updatedAt = new Date().toISOString();
	const irCursor = b.ir_cursor ?? null;
	const newsCursor = b.news_cursor ?? null;
	const body = sectionsToText(b.title, b.sections);
	const sectionsJson = JSON.stringify({ title: b.title, sections: b.sections });

	await db(env.DB)
		.insert(contexts)
		.values({
			ticker: b.code,
			body,
			sections: sectionsJson,
			irLastFetchedAt: irCursor,
			newsLastFetchedAt: newsCursor,
			updatedAt,
		})
		.onConflictDoUpdate({
			target: contexts.ticker,
			set: {
				body,
				sections: sectionsJson,
				irLastFetchedAt: irCursor,
				newsLastFetchedAt: newsCursor,
				updatedAt,
			},
		})
		.run();

	return c.json({ ok: true, code: b.code, updated_at: updatedAt });
});
