// Cloudflare Worker: カーソル順で本文込みの未処理分を返すルート。
//   /pull?code=285A&since=<ISO8601>&limit=N[&token=...]      … IR だけ (source LIKE 'ir:%' 等)
//   /pull-news?code=285A&since=<ISO8601>&limit=N[&token=...]  … ニュースだけ (source LIKE 'kabutan:%')
//   「since より後に取得した未処理分だけ」を本文(R2)込みで、古い順 (fetched_at ASC) に返す。
//   GitHub Actions (signal-report) が Issue の 2カーソル (ir / news) をそれぞれ since に渡し、
//   新規 IR・新規ニュースを別々に引いて統合判定する。/latest はメタのみ・published_at 順
//   なのに対し、こちらは「判断に必要な本文」を同梱し「取りこぼさないカーソル順」で返す。
//   since 省略時は直近 limit 件 (= 初回 / カーソル未確立時のフォールバック)。
//   IR とニュースは同じ articles テーブルに同居するので source プレフィクスで振り分ける。

import { type Context, Hono } from "hono";
import { pullArticles } from "../lib/articles";
import type { Env } from "../lib/env";

export const pull = new Hono<{ Bindings: Env }>();

// ルートハンドラ: クエリを読んで pullArticles を呼び、従来の {ok, code, since, count, rows} で返す。
async function handlePull(c: Context<{ Bindings: Env }>, isNews: boolean) {
	const code = c.req.query("code") || "285A";
	const since = c.req.query("since") ?? null;
	const limit = parseInt(c.req.query("limit") || "20", 10);
	const rows = await pullArticles(c.env, code, since, limit, isNews);
	return { ok: true, code, since, count: rows.length, rows };
}

pull.get("/pull", async (c) => c.json(await handlePull(c, false)));
pull.get("/pull-news", async (c) => c.json(await handlePull(c, true)));
