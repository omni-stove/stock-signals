// articles / market_news テーブルの読み出しロジック (DB クエリ + R2 本文同梱)。HTTP には依存しない。
// routes/pull (GET /pull /pull-news) と routes/context-input が共有する。
//   「since より後に取得した未処理分だけ」を本文 (R2) 込みで古い順 (fetched_at ASC) に返す。
//   GitHub Actions (signal-report) が 2 カーソル (ir / news) を since に渡し、新規 IR・新規
//   ニュースを別々に引いて統合判定する。IR とニュースは同じ articles テーブルに同居するので
//   source プレフィクスで振り分ける。

import { and, asc, eq, gt, gte, inArray, like, or } from "drizzle-orm";
import { db } from "./db";
import type { Env } from "./env";
import { articles, marketNews } from "./schema";

// urls のうち既に articles に存在するものの集合を返す (収集側の重複排除用)。
// 1 URL 1 クエリではなく IN 句でまとめて引く (収集は一覧単位で最大20件をまとめて確認する)。
export async function seenArticleUrls(
	d1: D1Database,
	urls: string[],
): Promise<Set<string>> {
	if (urls.length === 0) return new Set();
	const rows = await db(d1)
		.select({ url: articles.url })
		.from(articles)
		.where(inArray(articles.url, urls))
		.all();
	return new Set(rows.map((r) => r.url));
}

// 1 記事行 (R2 本文同梱)。/pull /pull-news と context-input が共有する返却形。
export interface PullRow {
	url: string;
	title: string;
	published_at: string | null;
	ir_category: string | null;
	fetched_at: string;
	body: string | null;
}

// published_at の足切り日 (YYYY-MM-DD)。スイング判断に古い記事は不要なので、
// epochNow から 30 日より前の published_at は (保管はするが) 返さない。
// back-dated 記事が新しい fetched_at で入ることがあるため、カーソル順とは別に鮮度で足切りする。
function publishedCutoff(epochNow: number): string {
	return new Date(epochNow - 30 * 86400_000).toISOString().slice(0, 10);
}

// isNews による source 絞り込み句。
//   true  → ニュース (kabutan:%)
//   false → IR 一次情報。公式IR (ir:%) + TDnet 適時開示 (tdnet:%) + 証券会社レーティング (rating:%)
//           を 1 本の ir カーソルで返す (いずれも銘柄の材料で context-builder は同じカーソルで読む)。
function sourceClause(isNews: boolean) {
	return isNews
		? like(articles.source, "kabutan:%")
		: or(
				like(articles.source, "ir:%"),
				like(articles.source, "tdnet:%"),
				like(articles.source, "rating:%"),
			);
}

// articles から「since 以降の未処理分 (本文 R2 同梱)」を fetched_at ASC で引く。
//   since があれば fetched_at > since で絞る。無ければ直近 limit 件を ASC で返す
//   (= 初回 / カーソル未確立時のフォールバック)。
export async function pullArticles(
	env: Env,
	code: string,
	since: string | null,
	limit: number,
	isNews: boolean,
): Promise<PullRow[]> {
	const cutoff = publishedCutoff(Date.now());

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
				sourceClause(isNews),
				gte(articles.publishedAt, cutoff),
				since ? gt(articles.fetchedAt, since) : undefined,
			),
		)
		.orderBy(asc(articles.fetchedAt))
		.limit(limit)
		.all();

	return Promise.all(
		results.map(async ({ r2_key, ...r }) => ({
			...r,
			body: await readBody(env, r2_key),
		})),
	);
}

// market_news から「since 以降で、見出しが terms のどれかを含む行 (本文 R2 同梱)」を fetched_at ASC で引く。
//   terms は当該銘柄の照合語 (watchlist.tickerTerms)。LIKE は ASCII だけ大文字小文字を無視する粗い絞り込みで、
//   銘柄への当否の最終判定は呼び出し側が matchTickers で行う。terms が空なら D1 を引かず空配列。
//   since 無し・published_at 足切り・limit の扱いは pullArticles と同じ。ir_category は常に null。
export async function pullMarketNews(
	env: Env,
	terms: string[],
	since: string | null,
	limit: number,
): Promise<PullRow[]> {
	if (terms.length === 0) return [];
	const cutoff = publishedCutoff(Date.now());

	const results = await db(env.DB)
		.select({
			url: marketNews.url,
			title: marketNews.title,
			published_at: marketNews.publishedAt,
			r2_key: marketNews.r2Key,
			fetched_at: marketNews.fetchedAt,
		})
		.from(marketNews)
		.where(
			and(
				or(...terms.map((w) => like(marketNews.title, `%${w}%`))),
				gte(marketNews.publishedAt, cutoff),
				since ? gt(marketNews.fetchedAt, since) : undefined,
			),
		)
		.orderBy(asc(marketNews.fetchedAt))
		.limit(limit)
		.all();

	return Promise.all(
		results.map(async ({ r2_key, ...r }) => ({
			...r,
			ir_category: null,
			body: await readBody(env, r2_key),
		})),
	);
}

// R2 の記事 JSON から本文を取り出す。本文は判断に必須だが、R2 欠損/壊れは body=null で返し取得自体は止めない。
async function readBody(env: Env, r2Key: string): Promise<string | null> {
	try {
		const obj = await env.ARTICLES.get(r2Key);
		if (!obj) return null;
		const json = JSON.parse(await obj.text()) as { body?: string };
		return json.body ?? null;
	} catch {
		return null;
	}
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("publishedCutoff", () => {
		it("epochNow から 30 日前の YYYY-MM-DD を返す", () => {
			const now = new Date("2026-06-24T12:00:00Z").getTime();
			expect(publishedCutoff(now)).toBe("2026-05-25");
		});
		it("月またぎも暦どおりに遡る", () => {
			const now = new Date("2026-01-10T00:00:00Z").getTime();
			expect(publishedCutoff(now)).toBe("2025-12-11");
		});
	});
}
