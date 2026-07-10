// Cloudflare Worker: per_ticker ニュース収集 (kabutan 銘柄ニュース)
//
// 扱うのは per_ticker 系統のみ。地合いは premarket(SOX/日経先物) とマクロイベント
// (macro_events: FOMC/日銀)で足り、銘柄に紐付かない macro ニュースは判定に使わない。
//
// watchlist の各銘柄ニュース一覧 (https://kabutan.jp/stock/news?code=<code>) を取り、
// 銘柄が確定しているので IR と同じ articles テーブル + R2 に保存する。
//   source     = "kabutan:<code>"   (IR は "ir:<site>:<code>" なので /pull-news が source で振り分け可)
//   ir_category= NULL                (ニュースにカテゴリは無い)
// 重複排除は articles.url の PRIMARY KEY + INSERT OR IGNORE。
//
// 全ソース UTF-8 (調査済) なので TextDecoder で十分。iconv 不要。

import * as cheerio from "cheerio";
import { seenArticleUrls } from "./articles";
import { db } from "./db";
import { parseKabutanNewsList, sliceArticle } from "./kabutan";
import { articles } from "./schema";
import { WATCHLIST } from "./timeseries";
import { fetchHtml, hash, normArticleDate, sleep } from "./utils";

export interface NewsEnv {
	DB: D1Database;
	ARTICLES: R2Bucket;
	USER_AGENT: string;
	MIN_INTERVAL_MS: string;
}

// 各銘柄のニュース一覧 URL。
const URL_NEWS = (code: string) => `https://kabutan.jp/stock/news?code=${code}`;
const SITE = "kabutan";

// 1ソースあたり本文取得する最大件数 (新しい順)。場中の連投を避けるため控えめに。
const NEWS_LIMIT = 20;

// 株探の記事本文ページから本文を抽出。
function parseKabutanArticle(html: string): {
	title: string;
	body: string;
	published_at: string;
} {
	// 本文抽出のセレクタが目印にする id/class が <article> 外にあるレイアウトでは
	// sliceArticle が全文を返すので、切り出しで欠測にはならない。
	const $ = cheerio.load(
		sliceArticle(html, [
			"shijyo_news_text",
			"news_contents",
			"pdbt0",
			"news_body",
			"s_news_date",
		]),
	);
	// 記事タイトルは本文ブロックの h1.pdbt0。ページ上部の h2 は銘柄名 (「6857 アドバンテスト」)
	// なので拾わない。見つからなければ h1 全般 → <title> の順にフォールバック。
	const title =
		$("h1.pdbt0").first().text().trim() ||
		$("#news_contents h1").first().text().trim() ||
		$("h1").first().text().trim() ||
		$("title").text().trim();
	const body =
		$("#shijyo_news_text").text().trim() ||
		$(".news_body").text().trim() ||
		$("#news_contents .body").text().trim() ||
		$("article").text().trim() ||
		$("main").text().trim();
	// 公開日は記事の datePublished (time.s_news_date[itemprop=datePublished])。
	// $("time").first() はページ上部の株価更新時刻 (class="close") を拾ってしまい、
	// 記事と無関係の「現在日」になるため使わない (これが publised_at 化けの原因だった)。
	const published_at =
		$("time.s_news_date").first().attr("datetime") ||
		$('time[itemprop="datePublished"]').first().attr("datetime") ||
		$("time.s_news_date").first().text().trim();
	return { title, body: body.replace(/\s+\n/g, "\n").trim(), published_at };
}

async function saveArticle(
	env: NewsEnv,
	meta: {
		url: string;
		ticker: string;
		title: string;
		published_at: string;
		body: string;
	},
): Promise<void> {
	const fetched_at = new Date().toISOString();
	const r2_key = `${meta.ticker}/${meta.published_at}-${hash(meta.url)}.json`;
	const payload = JSON.stringify(
		{
			...meta,
			source: `${SITE}:${meta.ticker}`,
			ir_category: null,
			fetched_at,
		},
		null,
		2,
	);
	await env.ARTICLES.put(r2_key, payload, {
		httpMetadata: { contentType: "application/json" },
	});
	await db(env.DB)
		.insert(articles)
		.values({
			url: meta.url,
			ticker: meta.ticker,
			source: `${SITE}:${meta.ticker}`,
			title: meta.title,
			publishedAt: meta.published_at,
			irCategory: null,
			r2Key: r2_key,
			fetchedAt: fetched_at,
		})
		.onConflictDoNothing()
		.run();
}

// 今回新規保存した1記事のメタ (Slack 通知用)。
export type FreshNews = {
	ticker: string;
	title: string;
	url: string;
	date: string;
};

// 1銘柄のニュース一覧を取り、未取得分だけ本文取得→保存。新規件数と新規記事メタを返す。
async function collectNewsOne(
	env: NewsEnv,
	code: string,
): Promise<{
	found: number;
	written: number;
	skipped: number;
	fresh: FreshNews[];
}> {
	const listHtml = await fetchHtml(URL_NEWS(code), env);
	const items = parseKabutanNewsList(listHtml, URL_NEWS(code)).slice(
		0,
		NEWS_LIMIT,
	);
	const seen = await seenArticleUrls(
		env.DB,
		items.map((it) => it.url),
	);
	const interval = parseInt(env.MIN_INTERVAL_MS, 10) || 5000;
	let written = 0;
	let skipped = 0;
	const fresh: FreshNews[] = [];
	for (const it of items) {
		if (seen.has(it.url)) {
			skipped++;
			continue;
		}
		await sleep(interval);
		try {
			const artHtml = await fetchHtml(it.url, env);
			const parsed = parseKabutanArticle(artHtml);
			const title = parsed.title || it.title;
			const date = normArticleDate(parsed.published_at || it.date, Date.now());
			await saveArticle(env, {
				url: it.url,
				ticker: code,
				title,
				published_at: date,
				body: parsed.body,
			});
			written++;
			fresh.push({ ticker: code, title, url: it.url, date });
		} catch (e) {
			console.error(`news article error ${it.url}: ${(e as Error).message}`);
		}
	}
	return { found: items.length, written, skipped, fresh };
}

// watchlist 全銘柄 (codeFilter 指定時はその1銘柄) のニュースを収集。
// 戻り値の freshTickers は今回新規があった銘柄 (= signal-report を起動すべき対象)。
// freshNews は今回新規保存した記事のメタ (= Slack 通知に流す対象)。
// emptyParses は「一覧が HTTP 200 なのにパース0件」だった銘柄 (= DOM 変更で収集が
// 静かに止まっている疑い。fetch 失敗は error として別に出る)。
export async function collectNews(
	env: NewsEnv,
	codeFilter: string | null,
): Promise<{
	results: Record<string, unknown>;
	freshTickers: string[];
	freshNews: FreshNews[];
	emptyParses: string[];
}> {
	const codes = WATCHLIST.filter((c) => !codeFilter || c === codeFilter);
	const results: Record<string, unknown> = {};
	const freshTickers: string[] = [];
	const freshNews: FreshNews[] = [];
	const emptyParses: string[] = [];
	for (const code of codes) {
		try {
			const r = await collectNewsOne(env, code);
			const { fresh, ...summary } = r;
			results[code] = summary;
			if (r.written > 0) freshTickers.push(code);
			if (r.found === 0) emptyParses.push(code);
			freshNews.push(...fresh);
		} catch (e) {
			results[code] = { error: (e as Error).message };
		}
	}
	return { results, freshTickers, freshNews, emptyParses };
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("parseKabutanArticle", () => {
		it("見出し (h1.pdbt0) と本文を抽出する", () => {
			const html =
				"<h1 class='pdbt0'>テスト見出し</h1><div id='shijyo_news_text'>  本文テキスト  </div>";
			const r = parseKabutanArticle(html);
			expect(r.title).toBe("テスト見出し");
			expect(r.body).toBe("本文テキスト");
		});
		it("本文の優先順 (#shijyo_news_text → .news_body → #news_contents .body → article → main)", () => {
			const html =
				"<h1 class='pdbt0'>T</h1><div class='news_body'>fallback本文</div>";
			expect(parseKabutanArticle(html).body).toBe("fallback本文");
		});
		it("ページ上部の銘柄名 h2 や株価更新時刻 time は拾わず、記事の datePublished を取る", () => {
			// kabutan の実構造: 上部に銘柄名 h2 と株価更新時刻 (time.close=現在日) があり、
			// その後に記事の time.s_news_date[itemprop=datePublished] と h1.pdbt0 が来る。
			// h2 と time.first() ではなく記事側の要素を拾う。
			const html = [
				"<h2>6857　アドバンテスト</h2>",
				'<time class="close" datetime="2026-06-23T09:08+09:00">09:08</time>',
				'<div id="news_contents">',
				'<time class="s_news_date" datetime="2026-06-19T09:06:00+09:00" itemprop="datePublished">26/06/19</time>',
				'<h1 class="pdbt0">アドバンテストが上値追い</h1>',
				'<div class="body">記事本文ここ</div>',
				"</div>",
			].join("");
			const r = parseKabutanArticle(html);
			expect(r.title).toBe("アドバンテストが上値追い");
			expect(r.published_at).toBe("2026-06-19T09:06:00+09:00");
			expect(
				normArticleDate(
					r.published_at,
					new Date("2026-06-23T00:00:00Z").getTime(),
				),
			).toBe("2026-06-19");
			expect(r.body).toContain("記事本文ここ");
		});
	});
}
