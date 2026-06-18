// scripts/fetch-news.ts
// cron から平日15分毎に叩かれる単発スクリプト。
//
// 2系統:
//   per_ticker: watchlist.yaml の news_url を順に取り、銘柄が確定しているので
//               data/queue/<code>/<id>.json に直接書き込む (route-news 不要)。
//   macro:      sources.yaml の macro_html を取り、銘柄横断の記事として
//               data/inbox/<id>.json に書き込む (route-news が振り分け)。
//
// LLM は使わない。スクレイピング・正規化・重複排除のみ。
// 実行: `node scripts/fetch-news.ts` (Node 26+ ネイティブTS実行)

import { readFile, writeFile, mkdir, appendFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INBOX = join(ROOT, "data/inbox");
const QUEUE = join(ROOT, "data/queue");
const SEEN_FILE = join(ROOT, "data/seen.txt");
const LOG = join(ROOT, "logs/fetch.log");

type HttpConfig = { user_agent: string; min_interval_ms: number; timeout_ms: number };

type SourcesConfig = {
  http: HttpConfig;
  per_ticker?: { site: string; encoding: string }[];
  macro_html?: { id: string; url: string; site: string; encoding: string }[];
};

type Watchlist = {
  tickers: {
    code: string;
    name: string;
    news_url?: string;
  }[];
};

type Article = {
  id: string;
  fetched_at: string;
  source: string;
  url: string;
  title: string;
  ticker?: string;
  published_at?: string;
  body: string;
};

async function loadYaml<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return parseYaml(raw) as T;
}

function articleHash(url: string): string {
  return createHash("sha1").update(url).digest("hex").slice(0, 10);
}

function articleId(source: string, url: string): string {
  const ts = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 12);
  return `${ts}-${source}-${articleHash(url)}`;
}

const seenCache = new Set<string>();

async function loadSeen(): Promise<void> {
  try {
    const raw = await readFile(SEEN_FILE, "utf8");
    for (const line of raw.split("\n")) if (line) seenCache.add(line.trim());
  } catch {
    // ファイル無しは初回扱い
  }
}

async function markSeen(hash: string): Promise<void> {
  if (seenCache.has(hash)) return;
  seenCache.add(hash);
  await appendFile(SEEN_FILE, hash + "\n");
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  await appendFile(LOG, line).catch(() => {});
}

function detectEncoding(contentType: string | null, fallback: string): string {
  if (!contentType) return fallback;
  const m = contentType.match(/charset=([^;]+)/i);
  return m ? m[1].trim().toLowerCase() : fallback;
}

async function fetchHtml(url: string, http: HttpConfig, encodingHint: string): Promise<string> {
  const ctl = AbortSignal.timeout(http.timeout_ms);
  const res = await fetch(url, { headers: { "User-Agent": http.user_agent }, signal: ctl });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // レスポンスヘッダの Content-Type を優先、なければ設定の encodingHint
  const enc = detectEncoding(res.headers.get("content-type"), encodingHint || "utf-8");
  if (enc === "utf-8" || enc === "utf8") return buf.toString("utf8");
  return iconv.decode(buf, enc);
}

// 株探の銘柄ニュース一覧 (table.s_news_list の各 tr) を抽出
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

// 株探の記事本文ページから本文を抽出
function parseKabutanArticle(html: string): { title: string; body: string; published_at: string } {
  const $ = cheerio.load(html);
  const title = $("h2").first().text().trim() || $("title").text().trim();
  // 本文は #shijyo_news_text または .news_body 等。フォールバック多めで。
  const body =
    $("#shijyo_news_text").text().trim() ||
    $(".news_body").text().trim() ||
    $("article").text().trim() ||
    $("main").text().trim();
  const published_at = $("time").first().attr("datetime") || $("time").first().text().trim();
  return { title, body: body.replace(/\s+\n/g, "\n").trim(), published_at };
}

async function fetchPerTicker(
  watchlist: Watchlist,
  http: HttpConfig,
  perTicker: NonNullable<SourcesConfig["per_ticker"]>,
): Promise<number> {
  let written = 0;
  // 今は kabutan のみ対応
  const kabutan = perTicker.find((s) => s.site === "kabutan");
  if (!kabutan) return 0;

  for (const t of watchlist.tickers) {
    if (!t.news_url) continue;
    try {
      const listHtml = await fetchHtml(t.news_url, http, kabutan.encoding);
      const items = parseKabutanList(listHtml, t.news_url);
      await log(`[ticker:${t.code}] list=${items.length}`);
      for (const it of items) {
        const hash = articleHash(it.url);
        if (seenCache.has(hash)) continue;
        await sleep(http.min_interval_ms);
        try {
          const artHtml = await fetchHtml(it.url, http, kabutan.encoding);
          const parsed = parseKabutanArticle(artHtml);
          const id = articleId(`kabutan-${t.code}`, it.url);
          const article: Article = {
            id,
            fetched_at: new Date().toISOString(),
            source: `kabutan:${t.code}`,
            url: it.url,
            title: parsed.title || it.title,
            ticker: t.code,
            published_at: parsed.published_at || it.date,
            body: parsed.body,
          };
          const dir = join(QUEUE, t.code);
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, `${id}.json`), JSON.stringify(article, null, 2), "utf8");
          await markSeen(hash);
          written++;
        } catch (e) {
          await log(`[ticker:${t.code}] article error ${it.url}: ${(e as Error).message}`);
        }
      }
      await sleep(http.min_interval_ms);
    } catch (e) {
      await log(`[ticker:${t.code}] list error: ${(e as Error).message}`);
    }
  }
  return written;
}

async function fetchMacro(
  http: HttpConfig,
  macroHtml: NonNullable<SourcesConfig["macro_html"]>,
): Promise<number> {
  let written = 0;
  for (const src of macroHtml) {
    if (src.site !== "kabutan") continue;
    try {
      const listHtml = await fetchHtml(src.url, http, src.encoding);
      const items = parseKabutanList(listHtml, src.url);
      await log(`[macro:${src.id}] list=${items.length}`);
      for (const it of items) {
        const hash = articleHash(it.url);
        if (seenCache.has(hash)) continue;
        await sleep(http.min_interval_ms);
        try {
          const artHtml = await fetchHtml(it.url, http, src.encoding);
          const parsed = parseKabutanArticle(artHtml);
          const id = articleId(src.id, it.url);
          const article: Article = {
            id,
            fetched_at: new Date().toISOString(),
            source: src.id,
            url: it.url,
            title: parsed.title || it.title,
            published_at: parsed.published_at || it.date,
            body: parsed.body,
          };
          await mkdir(INBOX, { recursive: true });
          await writeFile(join(INBOX, `${id}.json`), JSON.stringify(article, null, 2), "utf8");
          await markSeen(hash);
          written++;
        } catch (e) {
          await log(`[macro:${src.id}] article error ${it.url}: ${(e as Error).message}`);
        }
      }
      await sleep(http.min_interval_ms);
    } catch (e) {
      await log(`[macro:${src.id}] list error: ${(e as Error).message}`);
    }
  }
  return written;
}

async function main() {
  await mkdir(INBOX, { recursive: true });
  await mkdir(QUEUE, { recursive: true });
  await mkdir(dirname(LOG), { recursive: true });
  await loadSeen();

  const sources = await loadYaml<SourcesConfig>(join(ROOT, "config/sources.yaml"));
  const watchlist = await loadYaml<Watchlist>(join(ROOT, "config/watchlist.yaml"));

  const perTickerWritten = await fetchPerTicker(watchlist, sources.http, sources.per_ticker ?? []);
  const macroWritten = await fetchMacro(sources.http, sources.macro_html ?? []);

  await log(`fetch done: per_ticker=${perTickerWritten} macro=${macroWritten}`);
  console.log(`per_ticker=${perTickerWritten} macro=${macroWritten}`);
}

main().catch(async (e) => {
  await log(`fatal: ${(e as Error).stack ?? e}`);
  console.error(e);
  process.exit(1);
});
