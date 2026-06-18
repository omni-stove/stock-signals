// Cloudflare Worker: 公式IR (kioxia 等) の収集本体。index.ts から切り出し。
// watchlist 各銘柄の公式IRページを site ごとの専用パーサで取得し、メタ+重複排除キーを
// D1 (DB) に、本文(または見出し)を R2 (ARTICLES) に保存する。site ごとに一覧の構造が違うので
// parseList() で振り分ける (ir-sources.ts 参照):
//   - kioxia    (285A): https://www.kioxia.com/ja-jp/news.html
//                       <a class="cmp-button"> の href が記事URL、.cmp-button__text がタイトル。
//                       日付は URL の YYYYMMDD、カテゴリは URL パスから判別。事業会社(kioxia.com)と
//                       持株会社(kioxia-holdings.com=上場主体)の両方が並ぶ。記事本文HTMLが取れるので
//                       本文も取得する (唯一 fetchBody=true)。
//   - advantest (6857): li.m-list-news__item (time.datetime / p.m-text__item)。
//   - lasertec  (6920): article.news__article (time.datetime / h3.news__title)。当年ページのみ。
//   - murata    (6981): IRニュース RSS (item の link/title/pubDate)。
//   advantest/lasertec/murata は記事リンクが PDF/カレンダーで本文HTMLが取れないため、
//   一覧の見出しを本文として保存する (適時開示はタイトルで判定材料になる。disclosure.ts と同思想)。

import type { Env } from "./env";
import {
	DEFAULT_LIMIT,
	IR_SOURCES,
	type IrSource,
	parseKioxiaArticle,
	parseList,
} from "./ir-sources";
import { type NotifyItem, notifySlack } from "./slack";
import { fetchHtml, hash, sleep } from "./utils";

// 全ソース UTF-8 (調査済) なので TextDecoder で十分。iconv 不要。
// 既に D1 に存在する URL か (= seen.txt 相当の重複排除)。
async function isSeen(env: Env, url: string): Promise<boolean> {
	const row = await env.DB.prepare(
		"SELECT 1 FROM articles WHERE url = ? LIMIT 1",
	)
		.bind(url)
		.first();
	return row !== null;
}

async function saveArticle(
	env: Env,
	meta: {
		url: string;
		ticker: string;
		source: string;
		title: string;
		published_at: string;
		ir_category: string;
		body: string;
	},
): Promise<void> {
	const fetched_at = new Date().toISOString();
	// R2 キー: ticker/日付-ハッシュ.json (一覧しやすい構造)。
	const r2_key = `${meta.ticker}/${meta.published_at}-${hash(meta.url)}.json`;
	const payload = JSON.stringify({ ...meta, fetched_at }, null, 2);
	await env.ARTICLES.put(r2_key, payload, {
		httpMetadata: { contentType: "application/json" },
	});
	await env.DB.prepare(
		`INSERT OR IGNORE INTO articles
      (url, ticker, source, title, published_at, ir_category, r2_key, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			meta.url,
			meta.ticker,
			meta.source,
			meta.title,
			meta.published_at,
			meta.ir_category,
			r2_key,
			fetched_at,
		)
		.run();
}

// 1ソースを取得。新しい順に最大 limit 件、未取得のものだけ本文取得→保存。
async function collectOne(
	env: Env,
	src: IrSource,
	limit: number,
): Promise<{ found: number; written: number; skipped: number }> {
	const listHtml = await fetchHtml(src.list_url, env);
	let items = parseList(src.site, listHtml, src.list_url);
	items.sort((a, b) => b.date.localeCompare(a.date));
	const total = items.length;
	items = items.slice(0, limit);

	// kioxia は記事本文HTMLが安定して取れるので本文取得する。他社の記事リンクは
	// IRカレンダー/PDFラッパーで本文HTMLが取れないため、一覧のタイトルを本文として保存する
	// (適時開示はタイトルで判定材料になる。disclosure.ts と同思想)。
	const fetchBody = src.site === "kioxia";

	const interval = parseInt(env.MIN_INTERVAL_MS, 10) || 5000;
	let skipped = 0;
	const fresh: NotifyItem[] = []; // 今回新規に保存した記事 (Slack通知対象)
	for (const it of items) {
		if (await isSeen(env, it.url)) {
			skipped++;
			continue;
		}
		try {
			let title = it.title;
			let body = it.title; // 本文を取らない site は見出しを本文に充てる
			if (fetchBody) {
				await sleep(interval); // 本文取得する site だけ記事ごとに間隔を空ける
				const artHtml = await fetchHtml(it.url, env);
				const parsed = parseKioxiaArticle(artHtml);
				title = parsed.title || it.title;
				body = parsed.body;
			}
			await saveArticle(env, {
				url: it.url,
				ticker: src.code,
				source: `ir:${src.site}:${src.code}`,
				title,
				published_at: it.date,
				ir_category: it.category,
				body,
			});
			fresh.push({
				ticker: src.code,
				title,
				url: it.url,
				date: it.date,
				category: it.category,
			});
		} catch (e) {
			console.error(`article error ${it.url}: ${(e as Error).message}`);
		}
	}
	// 新規があればまとめてSlack通知 (Webhook未設定なら no-op)。
	await notifySlack(env, fresh);
	return { found: total, written: fresh.length, skipped };
}

export async function collectAll(
	env: Env,
	codeFilter: string | null,
	limit: number = DEFAULT_LIMIT,
): Promise<{ results: Record<string, unknown>; freshTickers: string[] }> {
	const sources = IR_SOURCES.filter(
		(s) => !codeFilter || s.code === codeFilter,
	);
	const results: Record<string, unknown> = {};
	const freshTickers: string[] = []; // 今回 written > 0 だった銘柄 (= signal-report を起動すべき対象)
	for (const src of sources) {
		try {
			const r = await collectOne(env, src, limit);
			results[src.code] = r;
			if (r.written > 0) freshTickers.push(src.code);
		} catch (e) {
			results[src.code] = { error: (e as Error).message };
		}
	}
	return { results, freshTickers };
}
