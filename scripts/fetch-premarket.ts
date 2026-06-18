// scripts/fetch-premarket.ts
// cron から平日朝8時頃 (寄り付き前) に1日1回叩かれる単発スクリプト。
//
// 「今日の地合い」を機械可読で残すのが目的 (目的②: 寄り前の値動き予測の土台)。
// 日中の値動きは前夜の米国市場と日経先物でかなり方向が決まる。とくに半導体銘柄
// (285A/6857/6920) は SOX 指数との連動が強い。
//
// 取得元 (config/sources.yaml の premarket):
//   - us.kabutan.jp の米国指数ページ (SOX / ナスダック / NYダウ)。
//     各ページの .text-3xl 親ブロックに
//       "<現値> 前日比 <差> (<騰落率%>) NY時間 <日> <時刻> 日本時間 <日> <時刻>"
//     が1行で入る。
//   - s.kabutan.jp の CME日経225先物(ドル建て)。現値のみ (前日比は空欄のことが多い)。
//
// 出力: data/premarket/<YYYY-MM-DD>.jsonl に1行追記 (同日重複はスキップ、idempotent)。
//
// LLM は使わない。スクレイピング・正規化のみ。
// 実行: `node scripts/fetch-premarket.ts` (Node 26+ ネイティブTS実行)

import { readFile, mkdir, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PREMARKET_DIR = join(ROOT, "data/premarket");
const LOG = join(ROOT, "logs/premarket.log");

type HttpConfig = { user_agent: string; min_interval_ms: number; timeout_ms: number };

type UsIndex = { key: string; label: string; url: string; encoding: string };

type SourcesConfig = {
  http: HttpConfig;
  premarket?: {
    us_indexes?: UsIndex[];
    nikkei_futures?: { url: string; encoding: string };
    // 寄前【板状況】注文ランキング記事の取得元 (marketnews 一覧)。--kehai モードで使う。
    kehai?: { list_url: string; encoding: string };
  };
};

type Watchlist = { tickers: { code: string; name: string }[] };

// 寄前【板状況】注文ランキングから抽出した watchlist 銘柄1件分の気配。
type KehaiQuote = {
  code: string;
  side: "buy" | "sell"; // 買い注文ランキング(前日比+3%以上) / 売り注文ランキング(-3%以下)のどちらに載ったか
  kehai_price: number | null; // 寄前気配値 (≒予想始値)
  change: number | null;
  change_pct: number | null;
  sell_shares: number | null;
  buy_shares: number | null;
  // 買い株数 - 売り株数。正なら買い優勢=寄り高期待、負なら売り優勢。需給の傾き。
  imbalance: number | null;
};

type IndexQuote = {
  key: string;
  label: string;
  price: number | null;
  change: number | null;
  change_pct: number | null;
  // us.kabutan が出す参照時刻 (例: "27日 06:16") をそのまま保持。日付検証用ではなく監査用。
  ny_time: string | null;
  jst_time: string | null;
};

type PremarketSnapshot = {
  fetched_at: string;
  date: string; // JST の取得日 (YYYY-MM-DD)。当日の地合いとして使う。
  us_indexes: IndexQuote[];
  nikkei_futures: { price: number | null; contract: string | null } | null;
  // 半導体銘柄の地合い主指標を取り出した要約 (analyze 側が読みやすいように)。
  sox_change_pct: number | null;
};

// 気配モード(--kehai)が data/premarket/<date>.jsonl に追記する別レコード。
// 前夜マーケット(8:00)とは別の行として追記し、kind で区別する。
type KehaiSnapshot = {
  fetched_at: string;
  date: string;
  kind: "kehai";
  article_time: string | null; // 記事の "8時53分" など (寄り前のどの時点か)
  // watchlist 銘柄のうち±3%以上動いてランキングに載ったものだけ。
  // 空配列 = どの銘柄もランキング圏外 = 寄り前時点で大きな需給偏りなし。
  watchlist_kehai: KehaiQuote[];
};

async function loadYaml<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return parseYaml(raw) as T;
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

function toNumber(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[,円株%＋+()]/g, "").trim();
  if (!cleaned || cleaned === "－" || cleaned === "ー" || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// us.kabutan.jp の指数ページ。現値ブロック (.text-3xl) の親要素テキストは
//   "12,876.90 前日比 +674.36 (+5.53%) NY時間 26日 17:16 日本時間 27日 06:16"
// の形。正規表現で分解する。レイアウトが変わったら price だけでも返す。
function parseUsIndex(html: string, idx: UsIndex): IndexQuote {
  const $ = cheerio.load(html);
  const priceEl = $(".text-3xl").first();
  const block = priceEl.parent().text().replace(/\s+/g, " ").trim();

  const price = toNumber(priceEl.text());

  // 前日比 +674.36 (+5.53%)
  const chgMatch = block.match(/前日比\s*([+\-－ー]?[\d,]+(?:\.\d+)?)\s*\(\s*([+\-－ー]?[\d.]+)\s*%\s*\)/);
  const change = chgMatch ? toNumber(chgMatch[1]) : null;
  const change_pct = chgMatch ? toNumber(chgMatch[2]) : null;

  const nyMatch = block.match(/NY時間\s*([0-9]{1,2}日\s*[0-9:]{4,5})/);
  const jstMatch = block.match(/日本時間\s*([0-9]{1,2}日\s*[0-9:]{4,5})/);

  return {
    key: idx.key,
    label: idx.label,
    price,
    change,
    change_pct,
    ny_time: nyMatch ? nyMatch[1].replace(/\s+/g, " ") : null,
    jst_time: jstMatch ? jstMatch[1].replace(/\s+/g, " ") : null,
  };
}

// CME日経225先物(ドル建て)ページ。.text-3xl 親は
//   "65,560円 ー 円 ー 6月限"
// のように現値+限月。前日比は空欄のことが多いので現値と限月だけ取る。
function parseNikkeiFutures(html: string): { price: number | null; contract: string | null } {
  const $ = cheerio.load(html);
  const priceEl = $(".text-3xl").first();
  const block = priceEl.parent().text().replace(/\s+/g, " ").trim();
  const price = toNumber(priceEl.text());
  const contractMatch = block.match(/([0-9]{1,2}月限)/);
  return { price, contract: contractMatch ? contractMatch[1] : null };
}

function jstDate(): string {
  // JST(UTC+9)の暦日。cron が JST 環境でも、念のため明示的に +9h して算出。
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

// 前夜マーケットレコード (kind 無し) が既にあるか。気配レコード(kind:"kehai")とは区別する。
async function alreadyHasPremarket(path: string, date: string): Promise<boolean> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.split("\n").some((l) => {
      if (!l) return false;
      const o = JSON.parse(l);
      return o.date === date && !o.kind;
    });
  } catch {
    return false;
  }
}

// その日のファイルに、指定 kind のレコードが既にあるか (気配モードの idempotent 判定用)。
async function alreadyHasKind(path: string, date: string, kind: string): Promise<boolean> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.split("\n").some((l) => {
      if (!l) return false;
      const o = JSON.parse(l);
      return o.date === date && o.kind === kind;
    });
  } catch {
    return false;
  }
}

// marketnews 一覧から「寄前【板状況】注文ランキング」記事のURLを探す。
// 買いトップ/売りトップで2本(あるいは1本)出ることがあるので複数返す。
function findKehaiArticleUrls(listHtml: string, baseUrl: string): string[] {
  const $ = cheerio.load(listHtml);
  const urls: string[] = [];
  $("a").each((_, a) => {
    const t = $(a).text().trim();
    const href = $(a).attr("href");
    if (!href) return;
    if (/寄前.*板状況.*注文ランキング/.test(t)) {
      urls.push(new URL(href, baseUrl).toString());
    }
  });
  return [...new Set(urls)];
}

// 寄前【板状況】注文ランキング記事の本文から watchlist 銘柄の行を抽出。
// 行フォーマット (買い注文ランキングの例):
//   "レーザーテク <6920> 　39,410  +1,280 ( +3.4%)　 64,200 (253,012)　 64,200 (253,012)"
//   <名前> <コード> 気配値 前日比 (比率%) 売り株数 (金額) 買い株数 (金額)
// side は記事タイトル/本文の「買い注文金額ランキング」「売り注文金額ランキング」見出しで決まるが、
// 1記事に両方の節が含まれるため、行ごとに change_pct の符号で判定する方が堅い。
function parseKehaiArticle(body: string, watchCodes: Set<string>): { article_time: string | null; quotes: KehaiQuote[] } {
  const quotes: KehaiQuote[] = [];

  // 記事時刻 "8時53分" を拾う (監査用)
  const timeMatch = body.match(/([0-9]{1,2}時[0-9]{1,2}分)/);
  const article_time = timeMatch ? timeMatch[1] : null;

  // コードは <6920> の形。watchlist のコードを含む行だけ正規表現で分解する。
  // 数字カンマ・符号・%・括弧を許容。全角スペースが多いので \s で吸収。
  const lineRe =
    /<\s*([0-9A-Z]{4})\s*>\s*([\d,]+)\s*([+\-－ー][\d,]+)\s*\(\s*([+\-－ー][\d.]+)\s*%\s*\)\s*([\d,]+)\s*\(\s*[\d,]+\s*\)\s*([\d,]+)\s*\(\s*[\d,]+\s*\)/g;

  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(body)) !== null) {
    const code = m[1];
    if (!watchCodes.has(code)) continue;
    const kehai_price = toNumber(m[2]);
    const change = toNumber(m[3]);
    const change_pct = toNumber(m[4]);
    const sell_shares = toNumber(m[5]);
    const buy_shares = toNumber(m[6]);
    const imbalance = buy_shares !== null && sell_shares !== null ? buy_shares - sell_shares : null;
    quotes.push({
      code,
      side: (change_pct ?? 0) >= 0 ? "buy" : "sell",
      kehai_price,
      change,
      change_pct,
      sell_shares,
      buy_shares,
      imbalance,
    });
  }
  return { article_time, quotes };
}

function parseArticleBody(html: string): string {
  const $ = cheerio.load(html);
  return (
    $("#shijyo_news_text").text().trim() ||
    $(".news_body").text().trim() ||
    $("article").text().trim() ||
    $("main").text().trim()
  );
}

// 気配モード (--kehai): 寄前【板状況】記事から watchlist 銘柄の気配を抽出し、
// data/premarket/<date>.jsonl に kind:"kehai" レコードを1行追記する。
async function runKehai(sources: SourcesConfig, http: HttpConfig): Promise<void> {
  const kehaiCfg = sources.premarket?.kehai;
  if (!kehaiCfg) {
    await log("no kehai config");
    console.log("no kehai config");
    return;
  }

  const watchlist = await loadYaml<Watchlist>(join(ROOT, "config/watchlist.yaml"));
  const watchCodes = new Set(watchlist.tickers.map((t) => t.code));

  const date = jstDate();
  const outPath = join(PREMARKET_DIR, `${date}.jsonl`);
  if (await alreadyHasKind(outPath, date, "kehai")) {
    await log(`already have kehai ${date}, skip`);
    console.log(`skip kehai ${date}`);
    return;
  }

  const listHtml = await fetchHtml(kehaiCfg.list_url, http, kehaiCfg.encoding);
  const urls = findKehaiArticleUrls(listHtml, kehaiCfg.list_url);
  await log(`kehai articles found: ${urls.length}`);

  const all: KehaiQuote[] = [];
  let article_time: string | null = null;
  for (const url of urls) {
    await sleep(http.min_interval_ms);
    try {
      const html = await fetchHtml(url, http, kehaiCfg.encoding);
      const body = parseArticleBody(html);
      const { article_time: at, quotes } = parseKehaiArticle(body, watchCodes);
      if (at && !article_time) article_time = at;
      all.push(...quotes);
    } catch (e) {
      await log(`kehai article error ${url}: ${(e as Error).message}`);
    }
  }

  // 同一銘柄が複数記事/節で重複したら code 単位で1件に (最初の出現を採用)。
  const dedup = new Map<string, KehaiQuote>();
  for (const q of all) if (!dedup.has(q.code)) dedup.set(q.code, q);
  const watchlist_kehai = [...dedup.values()];

  const snap: KehaiSnapshot = {
    fetched_at: new Date().toISOString(),
    date,
    kind: "kehai",
    article_time,
    watchlist_kehai,
  };
  await mkdir(PREMARKET_DIR, { recursive: true });
  await appendFile(outPath, JSON.stringify(snap) + "\n", "utf8");

  const summary = watchlist_kehai.map((q) => `${q.code}${q.side === "buy" ? "買" : "売"}${q.change_pct}%`).join(" ") || "(圏外)";
  await log(`kehai done: date=${date} hits=${watchlist_kehai.length} ${summary}`);
  console.log(`kehai date=${date} hits=${watchlist_kehai.length} ${summary}`);
}

async function main() {
  await mkdir(PREMARKET_DIR, { recursive: true });
  await mkdir(dirname(LOG), { recursive: true });

  const sources = await loadYaml<SourcesConfig>(join(ROOT, "config/sources.yaml"));
  const http = sources.http;
  const pm = sources.premarket;
  if (!pm) {
    await log("no premarket config");
    console.log("no premarket config");
    return;
  }

  // --kehai: 寄前【板状況】モード (8:55 cron)。前夜マーケットとは別レコードを追記する。
  if (process.argv.includes("--kehai")) {
    await runKehai(sources, http);
    return;
  }

  const date = jstDate();
  const outPath = join(PREMARKET_DIR, `${date}.jsonl`);
  // 前夜マーケットレコード (kind 無し) の重複だけを見る。
  if (await alreadyHasPremarket(outPath, date)) {
    await log(`already have ${date}, skip`);
    console.log(`skip ${date}`);
    return;
  }

  const us_indexes: IndexQuote[] = [];
  for (const idx of pm.us_indexes ?? []) {
    try {
      const html = await fetchHtml(idx.url, http, idx.encoding);
      const q = parseUsIndex(html, idx);
      us_indexes.push(q);
      await log(`[${idx.key}] price=${q.price} chg%=${q.change_pct}`);
    } catch (e) {
      us_indexes.push({ key: idx.key, label: idx.label, price: null, change: null, change_pct: null, ny_time: null, jst_time: null });
      await log(`[${idx.key}] error: ${(e as Error).message}`);
    }
    await sleep(http.min_interval_ms);
  }

  let nikkei_futures: PremarketSnapshot["nikkei_futures"] = null;
  if (pm.nikkei_futures) {
    try {
      const html = await fetchHtml(pm.nikkei_futures.url, http, pm.nikkei_futures.encoding);
      nikkei_futures = parseNikkeiFutures(html);
      await log(`[fut] price=${nikkei_futures.price} ${nikkei_futures.contract ?? ""}`);
    } catch (e) {
      await log(`[fut] error: ${(e as Error).message}`);
    }
  }

  const sox = us_indexes.find((q) => q.key === "sox");
  const snap: PremarketSnapshot = {
    fetched_at: new Date().toISOString(),
    date,
    us_indexes,
    nikkei_futures,
    sox_change_pct: sox?.change_pct ?? null,
  };

  await appendFile(outPath, JSON.stringify(snap) + "\n", "utf8");
  await log(`premarket done: date=${date} sox%=${snap.sox_change_pct} fut=${nikkei_futures?.price ?? "-"}`);
  console.log(`date=${date} sox%=${snap.sox_change_pct} fut=${nikkei_futures?.price ?? "-"}`);
}

main().catch(async (e) => {
  await log(`fatal: ${(e as Error).stack ?? e}`);
  console.error(e);
  process.exit(1);
});
