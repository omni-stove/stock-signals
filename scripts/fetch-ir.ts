// scripts/fetch-ir.ts
// 銘柄の公式IR/プレスリリースを一次情報として取得する単発スクリプト。
//
// 株探ニュース (fetch-news.ts の per_ticker) は速報だが二次情報。決算・上方修正・
// 業務提携・自己株買い等の一次情報は公式IRに最初に出る。これをラグなく拾い、
// 既存の analyze-ticker フローに乗せる (data/queue/<code>/ に入れる) のが目的。
//
// IRページは企業ごとにHTML構造が違うので site ごとに専用パーサを持つ。
// 現状 site=kioxia (285A) のみ対応。他銘柄は config/sources.yaml の ir に追加し、
// 対応する parser を増やす。
//
// 出力: fetch-news.ts と同じ Article 形式で data/queue/<code>/<id>.json に保存。
//   重複排除も fetch-news.ts と共有の data/seen.txt (URL の sha1 先頭10桁) を使う。
//   → 株探ニュースと公式IRで同一URLが二重取得されることはない。
//
// ニュース一覧ページには過去数年分の記事 (数百件) が静的に並ぶことがあるため、
// 本文取得は新しい順に最大 --limit 件まで (デフォルト 20)。定期実行では直近の新規
// 開示さえ拾えればよく、seen.txt で既取得分はスキップされるので上限で十分。
// 過去全件を一度に取り込みたい場合だけ --limit を大きくする。
//
// LLM は使わない。スクレイピング・正規化・重複排除のみ。
// 実行:
//   node scripts/fetch-ir.ts             (ir 定義の全銘柄、新しい順に最大20件)
//   node scripts/fetch-ir.ts 285A        (指定銘柄のみ)
//   node scripts/fetch-ir.ts --limit 5   (新しい順に最大5件だけ本文取得)
//   node scripts/fetch-ir.ts --dry-run   (一覧のみ表示、本文取得も保存もしない)

import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const QUEUE = join(ROOT, "data/queue");
const SEEN_FILE = join(ROOT, "data/seen.txt");
const LOG = join(ROOT, "logs/ir.log");

type HttpConfig = { user_agent: string; min_interval_ms: number; timeout_ms: number };

type IrSource = {
  code: string;
  site: string;
  list_url: string;
  encoding: string;
  note?: string;
};

type SourcesConfig = {
  http: HttpConfig;
  ir?: IrSource[];
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
  ir_category?: string; // corporate / business / personal / holdings(=適時開示) など
};

type ListItem = {
  url: string;
  title: string;
  date: string; // YYYY-MM-DD
  category: string;
};

async function loadYaml<T>(path: string): Promise<T> {
  return parseYaml(await readFile(path, "utf8")) as T;
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
    /* 初回 */
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
  await appendFile(LOG, `${new Date().toISOString()} ${msg}\n`).catch(() => {});
}

function detectEncoding(contentType: string | null, fallback: string): string {
  if (!contentType) return fallback;
  const m = contentType.match(/charset=([^;]+)/i);
  return m ? m[1].trim().toLowerCase() : fallback;
}

async function fetchHtml(url: string, http: HttpConfig, encodingHint: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": http.user_agent },
    signal: AbortSignal.timeout(http.timeout_ms),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const enc = detectEncoding(res.headers.get("content-type"), encodingHint || "utf-8");
  if (enc === "utf-8" || enc === "utf8") return buf.toString("utf8");
  return iconv.decode(buf, enc);
}

// URL から YYYYMMDD を取り出して YYYY-MM-DD にする (例 .../2026/20260611-1.html)。
function dateFromUrl(url: string): string {
  const m = url.match(/\/(\d{4})(\d{2})(\d{2})-\d+\.html/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return "";
}

// URL パスから IR カテゴリを判別。持株会社発を holdings(=適時開示) として最優先扱い。
function categoryFromUrl(url: string): string {
  if (url.includes("kioxia-holdings.com")) return "holdings";
  if (url.includes("/about/news/")) return "corporate";
  if (url.includes("/business/news/")) return "business";
  if (url.includes("/personal/news/")) return "personal";
  return "other";
}

// ── site: kioxia 専用パーサ ──
// www.kioxia.com/ja-jp/news.html の <a class="cmp-button"> から
// 記事URL・タイトル・日付・カテゴリを抽出する。事業会社と持株会社の両方が並ぶ。
function parseKioxiaList(html: string, baseUrl: string): ListItem[] {
  const $ = cheerio.load(html);
  const out: ListItem[] = [];
  const seenUrl = new Set<string>();
  $("a.cmp-button").each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href");
    if (!href) return;
    const url = new URL(href, baseUrl).toString();
    // 記事URL (/news/YYYY/YYYYMMDD-n.html) のみ対象。ナビ等のリンクは弾く。
    const date = dateFromUrl(url);
    if (!date) return;
    if (seenUrl.has(url)) return;
    seenUrl.add(url);
    const title = $a.find(".cmp-button__text").text().trim() || $a.text().trim();
    if (!title) return;
    out.push({ url, title, date, category: categoryFromUrl(url) });
  });
  return out;
}

// 記事本文ページから本文を抽出 (kioxia / kioxia-holdings 共通のざっくり抽出)。
function parseKioxiaArticle(html: string): { title: string; body: string } {
  const $ = cheerio.load(html);
  const title = $("h1").first().text().trim() || $("title").text().trim();
  const body =
    $("main").text().trim() ||
    $("article").text().trim() ||
    $(".cmp-text").text().trim() ||
    $("body").text().trim();
  return { title, body: body.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() };
}

const PARSERS: Record<
  string,
  { list: (html: string, base: string) => ListItem[]; article: (html: string) => { title: string; body: string } }
> = {
  kioxia: { list: parseKioxiaList, article: parseKioxiaArticle },
};

async function fetchOne(
  src: IrSource,
  http: HttpConfig,
  dryRun: boolean,
  limit: number,
): Promise<{ found: number; written: number }> {
  const parser = PARSERS[src.site];
  if (!parser) {
    await log(`[ir:${src.code}] no parser for site=${src.site}`);
    return { found: 0, written: 0 };
  }
  let written = 0;
  let items: ListItem[] = [];
  try {
    const listHtml = await fetchHtml(src.list_url, http, src.encoding);
    items = parser.list(listHtml, src.list_url);
  } catch (e) {
    await log(`[ir:${src.code}] list error: ${(e as Error).message}`);
    return { found: 0, written: 0 };
  }
  // 新しい順に並べ、上位 limit 件だけを本文取得の対象にする (過去全件は取らない)。
  items.sort((a, b) => b.date.localeCompare(a.date));
  const total = items.length;
  items = items.slice(0, limit);
  await log(`[ir:${src.code}] list=${total} (site=${src.site}) → 対象上位${items.length}件`);

  for (const it of items) {
    const hash = articleHash(it.url);
    if (seenCache.has(hash)) continue;
    await sleep(http.min_interval_ms);
    try {
      const artHtml = await fetchHtml(it.url, http, src.encoding);
      const parsed = parser.article(artHtml);
      const id = articleId(`ir-${src.code}`, it.url);
      const article: Article = {
        id,
        fetched_at: new Date().toISOString(),
        source: `ir:${src.site}:${src.code}`,
        url: it.url,
        title: parsed.title || it.title,
        ticker: src.code,
        published_at: it.date,
        body: parsed.body,
        ir_category: it.category,
      };
      if (dryRun) {
        console.log(`[dry] ${it.date} (${it.category}) ${article.title}`);
        console.log(`      ${it.url}`);
      } else {
        const dir = join(QUEUE, src.code);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${id}.json`), JSON.stringify(article, null, 2), "utf8");
        await markSeen(hash);
      }
      written++;
    } catch (e) {
      await log(`[ir:${src.code}] article error ${it.url}: ${(e as Error).message}`);
    }
  }
  return { found: items.length, written };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : 20;
  // --limit の値部分は銘柄コードと誤認しないよう除外する。
  const codeArg = args.find((a, i) => !a.startsWith("--") && i !== limitIdx + 1) ?? null;

  const sources = await loadYaml<SourcesConfig>(join(ROOT, "config/sources.yaml"));
  const http = sources.http;
  const irSources = (sources.ir ?? []).filter((s) => !codeArg || s.code === codeArg);

  if (irSources.length === 0) {
    const msg = codeArg
      ? `ir に code=${codeArg} の定義がありません (config/sources.yaml の ir を確認)`
      : "ir 定義がありません (config/sources.yaml に ir を追加)";
    console.error(msg);
    return;
  }

  if (!dryRun) await loadSeen();

  let totalFound = 0;
  let totalWritten = 0;
  for (const src of irSources) {
    const { found, written } = await fetchOne(src, http, dryRun, limit);
    totalFound += found;
    totalWritten += written;
    await sleep(http.min_interval_ms);
  }

  const summary = `ir done: found=${totalFound} ${dryRun ? "would-write" : "written"}=${totalWritten}`;
  await log(summary);
  console.log(summary);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
