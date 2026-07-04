// articles テーブルの読み出しロジック (DB クエリ + R2 本文同梱)。HTTP には依存しない。
// routes/pull (GET /pull /pull-news) と routes/context-input が共有する。
//   「since より後に取得した未処理分だけ」を本文 (R2) 込みで古い順 (fetched_at ASC) に返す。
//   GitHub Actions (signal-report) が 2 カーソル (ir / news) を since に渡し、新規 IR・新規
//   ニュースを別々に引いて統合判定する。IR とニュースは同じ articles テーブルに同居するので
//   source プレフィクスで振り分ける。

import { and, asc, eq, gt, gte, inArray, like, or } from "drizzle-orm";
import { db } from "./db";
import type { Env } from "./env";
import { articles } from "./schema";

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

	// 各メタに R2 本文を同梱する。本文は判断に必須。R2 欠損は body=null で返す。
	const rows: PullRow[] = await Promise.all(
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
				url: r.url as string,
				title: r.title as string,
				published_at: r.published_at as string | null,
				ir_category: r.ir_category as string | null,
				fetched_at: r.fetched_at as string,
				body,
			};
		}),
	);
	return rows;
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
