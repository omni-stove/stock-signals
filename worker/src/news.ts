// Cloudflare Worker: per_ticker ニュース収集 (kabutan 銘柄ニュース)
//
// ローカルの scripts/fetch-news.ts の per_ticker 系統を Worker に移植したもの。
// macro 系統 (marketnews 横断ニュース) は廃止した。地合いは premarket(SOX/日経先物)
// と config/events.yaml で足り、銘柄に紐付かない macro ニュースは判定に使わないため。
//
// watchlist の各銘柄ニュース一覧 (https://kabutan.jp/stock/news?code=<code>) を取り、
// 銘柄が確定しているので IR と同じ articles テーブル + R2 に保存する。
//   source     = "kabutan:<code>"   (IR は "ir:<site>:<code>" なので /pull-news が source で振り分け可)
//   ir_category= NULL                (ニュースにカテゴリは無い)
// 重複排除は articles.url の PRIMARY KEY + INSERT OR IGNORE (ローカルの seen.txt 相当)。
//
// 全ソース UTF-8 (調査済) なので TextDecoder で十分。iconv 不要。

import * as cheerio from "cheerio";

export interface NewsEnv {
  DB: D1Database;
  ARTICLES: R2Bucket;
  USER_AGENT: string;
  MIN_INTERVAL_MS: string;
}

// ローカル config/watchlist.yaml の tickers と対応。
const WATCHLIST: string[] = ["285A", "6857", "6920", "6981"];

// ローカル config/watchlist.yaml の news_url と対応。
const URL_NEWS = (code: string) => `https://kabutan.jp/stock/news?code=${code}`;
const SITE = "kabutan";

// 1ソースあたり本文取得する最大件数 (新しい順)。場中の連投を避けるため控えめに。
const NEWS_LIMIT = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchHtml(url: string, env: NewsEnv): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": env.USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const buf = await res.arrayBuffer();
  return new TextDecoder("utf-8").decode(buf);
}

// URL → 短いハッシュ (R2キー用)。index.ts の hash() と同じ規則。
function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// 株探の銘柄ニュース一覧 (table.s_news_list の各 tr) を抽出。
// scripts/fetch-news.ts の parseKabutanList と同じ。
function parseKabutanList(html: string, baseUrl: string): { url: string; title: string; date: string }[] {
  const $ = cheerio.load(html);
  const out: { url: string; title: string; date: string }[] = [];
  $("table.s_news_list tr").each((_, tr) => {
    const $tr = $(tr);
    const a = $tr.find("a").first();
    const href = a.attr("href");
    if (!href) return;
    const url = new URL(href, baseUrl).toString();
    const title = a.text().trim();
    const date = $tr.find("time").first().text().trim() || $tr.find("td").first().text().trim();
    if (title) out.push({ url, title, date });
  });
  return out;
}

// 株探の記事本文ページから本文を抽出。
// scripts/fetch-news.ts の parseKabutanArticle と同じ。
function parseKabutanArticle(html: string): { title: string; body: string; published_at: string } {
  const $ = cheerio.load(html);
  const title = $("h2").first().text().trim() || $("title").text().trim();
  const body =
    $("#shijyo_news_text").text().trim() ||
    $(".news_body").text().trim() ||
    $("article").text().trim() ||
    $("main").text().trim();
  const published_at = $("time").first().attr("datetime") || $("time").first().text().trim();
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
  const row = await env.DB.prepare("SELECT 1 FROM articles WHERE url = ? LIMIT 1").bind(url).first();
  return row !== null;
}

async function saveArticle(
  env: NewsEnv,
  meta: { url: string; ticker: string; title: string; published_at: string; body: string },
): Promise<void> {
  const fetched_at = new Date().toISOString();
  const r2_key = `${meta.ticker}/${meta.published_at}-${hash(meta.url)}.json`;
  const payload = JSON.stringify(
    { ...meta, source: `${SITE}:${meta.ticker}`, ir_category: null, fetched_at },
    null,
    2,
  );
  await env.ARTICLES.put(r2_key, payload, { httpMetadata: { contentType: "application/json" } });
  await env.DB.prepare(
    `INSERT OR IGNORE INTO articles
      (url, ticker, source, title, published_at, ir_category, r2_key, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(meta.url, meta.ticker, `${SITE}:${meta.ticker}`, meta.title, meta.published_at, null, r2_key, fetched_at)
    .run();
}

// 1銘柄のニュース一覧を取り、未取得分だけ本文取得→保存。新規件数を返す。
async function collectNewsOne(env: NewsEnv, code: string): Promise<{ found: number; written: number; skipped: number }> {
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
