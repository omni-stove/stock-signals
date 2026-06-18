// Cloudflare Worker: per_ticker 適時開示 (TDnet) 収集 (kabutan 開示情報ページ)
//
// kabutan の銘柄ニュースには通常記事と別に「開示情報」ページがある:
//   https://kabutan.jp/stock/news?code=<code>&nmode=3
// これは TDnet 適時開示 (決算短信/業績修正/配当/自己株取得/大株主異動 等) の一覧で、
// 各社の公式IRを個別スクレイプする代わりに全 watchlist 銘柄ぶんを同じ構造で取れる。
// 全銘柄が worker/src/index.ts の IR_SOURCES でも公式サイトIRを取っているが、こちらの TDnet は
// 適時開示を別ソースとして二重に押さえる保険 (同一URLは articles.url PK + INSERT OR IGNORE で冪等)。
//
// 一覧の各行は table.s_news_list で news.ts の parseKabutanList と同一構造。
// ただしリンク先は実PDFのラッパーページ (本文テキストは取れない) なので、
// 本文は取りに行かず「一覧のタイトル」を body として保存する (適時開示はタイトルだけで
// 判定材料 = 何が起きたか が分かる)。PDF原本のURLは url 列に残るので必要なら人が辿れる。
//
//   source     = "tdnet:<code>"   (/pull の sourceLike 'ir:%' では拾えないため、index.ts 側で
//                                   適時開示も IR 扱いにするなら sourceLike を調整する。下記参照)
//   ir_category= "disclosure"
// 重複排除は articles.url の PRIMARY KEY + INSERT OR IGNORE (news.ts と同じ)。

import * as cheerio from "cheerio";
import { WATCHLIST } from "./timeseries";
import { fetchHtml, hash } from "./utils";

export interface DisclosureEnv {
	DB: D1Database;
	ARTICLES: R2Bucket;
	USER_AGENT: string;
	MIN_INTERVAL_MS: string;
}

// kabutan の開示情報ページ (nmode=3)。ニュース一覧 (news.ts) と同ドメイン・同テーブル構造。
const URL_DISCLOSURE = (code: string) =>
	`https://kabutan.jp/stock/news?code=${code}&nmode=3`;
const SITE = "tdnet";

// 1銘柄あたり記録する最大件数 (新しい順)。本文取得はしないので件数は多めでも軽い。
const DISCLOSURE_LIMIT = 20;

// 開示一覧 (table.s_news_list の各 tr) を抽出。news.ts の parseKabutanList と同構造だが
// time が "26/05/29 17:00" 形式 (年2桁・&nbsp;区切り) なので date はそのまま渡し normDate で正規化する。
function parseDisclosureList(
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

// 日付文字列を YYYY-MM-DD に正規化。kabutan 開示は "26/05/29 17:00" のように年2桁。
// 4桁年があればそれを使い、2桁年 (YY/MM/DD) は 2000+YY で補完する。取れなければ "unknown"。
function normDate(raw: string): string {
	const cleaned = raw.replace(/&nbsp;/g, " ");
	const full = cleaned.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
	if (full)
		return `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}`;
	const yy = cleaned.match(/(\d{2})[-/](\d{1,2})[-/](\d{1,2})/);
	if (yy)
		return `20${yy[1]}-${yy[2].padStart(2, "0")}-${yy[3].padStart(2, "0")}`;
	return "unknown";
}

async function isSeen(env: DisclosureEnv, url: string): Promise<boolean> {
	const row = await env.DB.prepare(
		"SELECT 1 FROM articles WHERE url = ? LIMIT 1",
	)
		.bind(url)
		.first();
	return row !== null;
}

// 適時開示1件を保存。本文は取得しないので body = title (適時開示は見出しが判定材料)。
async function saveDisclosure(
	env: DisclosureEnv,
	meta: { url: string; ticker: string; title: string; published_at: string },
): Promise<void> {
	const fetched_at = new Date().toISOString();
	const r2_key = `${meta.ticker}/${meta.published_at}-${hash(meta.url)}.json`;
	const payload = JSON.stringify(
		{
			...meta,
			body: meta.title, // 本文PDFは取らない。タイトルで何が起きたかは分かる。
			source: `${SITE}:${meta.ticker}`,
			ir_category: "disclosure",
			fetched_at,
		},
		null,
		2,
	);
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
			`${SITE}:${meta.ticker}`,
			meta.title,
			meta.published_at,
			"disclosure",
			r2_key,
			fetched_at,
		)
		.run();
}

// 1銘柄の適時開示一覧を取り、未取得分だけ保存。本文取得が無いので銘柄内では sleep 不要
// (一覧ページ1回の fetch のみ)。新規件数を返す。
async function collectDisclosureOne(
	env: DisclosureEnv,
	code: string,
): Promise<{ found: number; written: number; skipped: number }> {
	const listHtml = await fetchHtml(URL_DISCLOSURE(code), env);
	const items = parseDisclosureList(listHtml, URL_DISCLOSURE(code)).slice(
		0,
		DISCLOSURE_LIMIT,
	);
	let written = 0;
	let skipped = 0;
	for (const it of items) {
		if (await isSeen(env, it.url)) {
			skipped++;
			continue;
		}
		try {
			await saveDisclosure(env, {
				url: it.url,
				ticker: code,
				title: it.title,
				published_at: normDate(it.date),
			});
			written++;
		} catch (e) {
			console.error(`disclosure save error ${it.url}: ${(e as Error).message}`);
		}
	}
	return { found: items.length, written, skipped };
}

// watchlist 全銘柄 (codeFilter 指定時はその1銘柄) の適時開示を収集。
// 戻り値の freshTickers は今回新規があった銘柄 (= signal 判定を起動すべき対象)。
// 銘柄間は本文取得が無いぶん軽いが、kabutan への負荷を揃えるため min_interval を空ける。
export async function collectDisclosures(
	env: DisclosureEnv,
	codeFilter: string | null,
): Promise<{ results: Record<string, unknown>; freshTickers: string[] }> {
	const codes = WATCHLIST.filter((c) => !codeFilter || c === codeFilter);
	const interval = parseInt(env.MIN_INTERVAL_MS, 10) || 5000;
	const results: Record<string, unknown> = {};
	const freshTickers: string[] = [];
	for (let i = 0; i < codes.length; i++) {
		if (i > 0) await new Promise((r) => setTimeout(r, interval));
		const code = codes[i];
		try {
			const r = await collectDisclosureOne(env, code);
			results[code] = r;
			if (r.written > 0) freshTickers.push(code);
		} catch (e) {
			results[code] = { error: (e as Error).message };
		}
	}
	return { results, freshTickers };
}
