// Cloudflare Worker: カーソル順で本文込みの未処理分を返すルート。
//   /pull?code=285A&since=<ISO8601>&limit=N[&token=...]      … IR だけ (source LIKE 'ir:%' 等)
//   /pull-news?code=285A&since=<ISO8601>&limit=N[&token=...]  … ニュースだけ (source LIKE 'kabutan:%')
//   「since より後に取得した未処理分だけ」を本文(R2)込みで、古い順 (fetched_at ASC) に返す。
//   GitHub Actions (signal-report) が Issue の 2カーソル (ir / news) をそれぞれ since に渡し、
//   新規 IR・新規ニュースを別々に引いて統合判定する。/latest はメタのみ・published_at 順
//   なのに対し、こちらは「判断に必要な本文」を同梱し「取りこぼさないカーソル順」で返す。
//   since 省略時は直近 limit 件 (= 初回 / カーソル未確立時のフォールバック)。
//   IR とニュースは同じ articles テーブルに同居するので source プレフィクスで振り分ける。

import { and, asc, eq, gt, gte, like, or } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { db } from "../lib/db";
import type { Env } from "../lib/env";
import { articles } from "../lib/schema";

export const pull = new Hono<{ Bindings: Env }>();

// isNews=true のとき /pull-news (kabutan:% のみ)、false で /pull (ir/tdnet/rating)。
async function handlePull(c: Context<{ Bindings: Env }>, isNews: boolean) {
	const env = c.env;
	const code = c.req.query("code") || "285A";
	const since = c.req.query("since") ?? null;
	const limit = parseInt(c.req.query("limit") || "20", 10);

	// /pull-news はニュース (kabutan:%) のみ。/pull は「IR一次情報」として
	// 公式IR (ir:%) と TDnet 適時開示 (tdnet:%) の両方を1本のカーソルで返す
	// (いずれも銘柄の材料で、context-builder は同じ ir カーソルで読むため)。
	// rating:% は証券会社レーティング (個社別 目標株価)。
	const sourceClause = isNews
		? like(articles.source, "kabutan:%")
		: or(
				like(articles.source, "ir:%"),
				like(articles.source, "tdnet:%"),
				like(articles.source, "rating:%"),
			);

	// スイング判断に古い記事は不要。published_at が30日より古いものは保管はするが返さない
	// (取得時に一覧の下まで遡れず back-dated 記事が新しい fetched_at で入ることがあるため、
	//  カーソル順とは別に published_at の鮮度で足切りする)。published_at は YYYY-MM-DD 文字列。
	const cutoff = new Date(Date.now() - 30 * 86400_000)
		.toISOString()
		.slice(0, 10);

	// since があれば fetched_at > since で絞る。無ければ直近 limit 件を ASC で返す。
	const results = await db(env.DB)
		.select({
			url: articles.url,
			title: articles.title,
			published_at: articles.publishedAt,
			ir_category: articles.irCategory,
			r2_key: articles.r2Key,
			fetched_at: articles.fetchedAt,
		})
		.from(articles)
		.where(
			and(
				eq(articles.ticker, code),
				sourceClause,
				gte(articles.publishedAt, cutoff),
				since ? gt(articles.fetchedAt, since) : undefined,
			),
		)
		.orderBy(asc(articles.fetchedAt))
		.limit(limit)
		.all();

	// 各メタに R2 本文を同梱する。本文は判断に必須。R2 欠損は body=null で返す。
	const rows = await Promise.all(
		(results as Record<string, unknown>[]).map(async (r) => {
			let body: string | null = null;
			try {
				const obj = await env.ARTICLES.get(r.r2_key as string);
				if (obj) {
					const json = JSON.parse(await obj.text()) as { body?: string };
					body = json.body ?? null;
				}
			} catch {
				/* R2 欠損/壊れは body=null のまま (取得自体は止めない) */
			}
			return {
				url: r.url,
				title: r.title,
				published_at: r.published_at,
				ir_category: r.ir_category,
				fetched_at: r.fetched_at,
				body,
			};
		}),
	);
	return { ok: true, code, since, count: rows.length, rows };
}

pull.get("/pull", async (c) => c.json(await handlePull(c, false)));
pull.get("/pull-news", async (c) => c.json(await handlePull(c, true)));
