// Cloudflare Worker: per_ticker ニュース収集 (kabutan 銘柄ニュース)
//
// ローカルの scripts/fetch-news.ts の per_ticker 系統を Worker に移植したもの。
// macro 系統 (marketnews 横断ニュース) は廃止した。地合いは premarket(SOX/日経先物)
// とマクロイベント(macro_events: FOMC/日銀)で足り、銘柄に紐付かない macro ニュースは判定に使わないため。
//
// watchlist の各銘柄ニュース一覧 (https://kabutan.jp/stock/news?code=<code>) を取り、
// 銘柄が確定しているので IR と同じ articles テーブル + R2 に保存する。
//   source     = "kabutan:<code>"   (IR は "ir:<site>:<code>" なので /pull-news が source で振り分け可)
//   ir_category= NULL                (ニュースにカテゴリは無い)
// 重複排除は articles.url の PRIMARY KEY + INSERT OR IGNORE (ローカルの seen.txt 相当)。
//
// 全ソース UTF-8 (調査済) なので TextDecoder で十分。iconv 不要。

import * as cheerio from "cheerio";
import { db } from "./db";
import { articles } from "./schema";
import { WATCHLIST } from "./timeseries";
import { fetchHtml, hash, sleep } from "./utils";

export interface NewsEnv {
	DB: D1Database;
	ARTICLES: R2Bucket;
	USER_AGENT: string;
	MIN_INTERVAL_MS: string;
}

// ローカル config/watchlist.yaml の news_url と対応。
const URL_NEWS = (code: string) => `https://kabutan.jp/stock/news?code=${code}`;
const SITE = "kabutan";

// 1ソースあたり本文取得する最大件数 (新しい順)。場中の連投を避けるため控えめに。
const NEWS_LIMIT = 20;

// 株探の銘柄ニュース一覧 (table.s_news_list の各 tr) を抽出。
// scripts/fetch-news.ts の parseKabutanList と同じ。
function parseKabutanList(
	html: string,
	baseUrl: string,
): { url: string; title: string; date: string }[] {
	const $ = cheerio.load(html);
	const out: { url: string; title: string; date: string }[] = [];
	$("table.s_news_list tr").each((_, tr) => {
		const $tr = $(tr);
		const a = $tr.find("a").first();
		const href = a.attr("href");
		if (!href) return;
		const url = new URL(href, baseUrl).toString();
		const title = a.text().trim();
		const date =
			$tr.find("time").first().text().trim() ||
			$tr.find("td").first().text().trim();
		if (title) out.push({ url, title, date });
	});
	return out;
}

// 株探の記事本文ページから本文を抽出。
// scripts/fetch-news.ts の parseKabutanArticle と同じ。
function parseKabutanArticle(html: string): {
	title: string;
	body: string;
	published_at: string;
} {
	const $ = cheerio.load(html);
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

// 日付文字列を YYYY-MM-DD に正規化 (R2キー用)。取れなければ "unknown"。
function normDate(raw: string): string {
	const m = raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
	if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
	// "06/18" 形式 (年なし) は当年補完しないでそのまま日付部分だけ拾う
	const md = raw.match(/(\d{1,2})[-/](\d{1,2})/);
	if (md) return `${md[1].padStart(2, "0")}-${md[2].padStart(2, "0")}`;
	return "unknown";
}

async function isSeen(env: NewsEnv, url: string): Promise<boolean> {
	const row = await env.DB.prepare(
		"SELECT 1 FROM articles WHERE url = ? LIMIT 1",
	)
		.bind(url)
		.first();
	return row !== null;
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

// 1銘柄のニュース一覧を取り、未取得分だけ本文取得→保存。新規件数を返す。
async function collectNewsOne(
	env: NewsEnv,
	code: string,
): Promise<{ found: number; written: number; skipped: number }> {
	const listHtml = await fetchHtml(URL_NEWS(code), env);
	const items = parseKabutanList(listHtml, URL_NEWS(code)).slice(0, NEWS_LIMIT);
	const interval = parseInt(env.MIN_INTERVAL_MS, 10) || 5000;
	let written = 0;
	let skipped = 0;
	for (const it of items) {
		if (await isSeen(env, it.url)) {
			skipped++;
			continue;
		}
		await sleep(interval);
		try {
			const artHtml = await fetchHtml(it.url, env);
			const parsed = parseKabutanArticle(artHtml);
			await saveArticle(env, {
				url: it.url,
				ticker: code,
				title: parsed.title || it.title,
				published_at: normDate(parsed.published_at || it.date),
				body: parsed.body,
			});
			written++;
		} catch (e) {
			console.error(`news article error ${it.url}: ${(e as Error).message}`);
		}
	}
	return { found: items.length, written, skipped };
}

// watchlist 全銘柄 (codeFilter 指定時はその1銘柄) のニュースを収集。
// 戻り値の freshTickers は今回新規があった銘柄 (= signal-report を起動すべき対象)。
export async function collectNews(
	env: NewsEnv,
	codeFilter: string | null,
): Promise<{ results: Record<string, unknown>; freshTickers: string[] }> {
	const codes = WATCHLIST.filter((c) => !codeFilter || c === codeFilter);
	const results: Record<string, unknown> = {};
	const freshTickers: string[] = [];
	for (const code of codes) {
		try {
			const r = await collectNewsOne(env, code);
			results[code] = r;
			if (r.written > 0) freshTickers.push(code);
		} catch (e) {
			results[code] = { error: (e as Error).message };
		}
	}
	return { results, freshTickers };
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;
	const BASE = "https://kabutan.jp/stock/news?code=285A";

	describe("parseKabutanList", () => {
		const html = [
			"<table class='s_news_list'>",
			"<tr><td><time>06/18</time></td><td><a href='/news/marketnews/?b=n1'>業績上方修正</a></td></tr>",
			"<tr><td><time>06/17</time></td><td><a href='https://kabutan.jp/news/?b=n2'>新製品発表</a></td></tr>",
			"<tr><td>ヘッダ行 (aなし)</td></tr>",
			"</table>",
		].join("");

		it("相対hrefを絶対URLに解決しタイトル・日付を拾う", () => {
			const rows = parseKabutanList(html, BASE);
			expect(rows).toEqual([
				{
					url: "https://kabutan.jp/news/marketnews/?b=n1",
					title: "業績上方修正",
					date: "06/18",
				},
				{
					url: "https://kabutan.jp/news/?b=n2",
					title: "新製品発表",
					date: "06/17",
				},
			]);
		});
		it("aリンクの無い行 (ヘッダ等) は除外する", () => {
			expect(parseKabutanList(html, BASE)).toHaveLength(2);
		});
	});

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
			// 旧実装は h2 と time.first() を拾って「銘柄名」「現在日」に化けていた (回帰防止)。
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
			expect(normDate(r.published_at)).toBe("2026-06-19");
			expect(r.body).toContain("記事本文ここ");
		});
	});

	describe("normDate", () => {
		it("4桁年は YYYY-MM-DD に正規化する", () => {
			expect(normDate("2026/6/8")).toBe("2026-06-08");
			expect(normDate("2026-06-08 17:00")).toBe("2026-06-08");
		});
		it("年なし MM/DD は当年補完せず MM-DD だけ拾う", () => {
			expect(normDate("06/18")).toBe("06-18");
		});
		it("日付が取れなければ unknown", () => {
			expect(normDate("日付不明")).toBe("unknown");
		});
	});
}
