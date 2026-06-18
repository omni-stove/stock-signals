// scripts/fetch-prices.ts
// cron から平日5分毎に叩かれる単発スクリプト。
//
// watchlist.yaml の全銘柄について、kabutan の銘柄ページから
// 現値・前日比(円/%)・出来高を取り、 data/prices/<code>.jsonl に1行追記。
//
// LLM は使わない。スクレイピング・正規化のみ。
// 実行: `node scripts/fetch-prices.ts` (Node 26+ ネイティブTS実行)

import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PRICES_DIR = join(ROOT, "data/prices");
const LOG = join(ROOT, "logs/prices.log");

type HttpConfig = { user_agent: string; min_interval_ms: number; timeout_ms: number };

type SourcesConfig = {
  http: HttpConfig;
  prices?: { site: string; encoding: string; url_template: string }[];
};

type Watchlist = {
  tickers: { code: string; name: string }[];
};

type PriceSnapshot = {
  fetched_at: string;
  source: string;
  ticker: string;
  price: number | null;
  change: number | null;
  change_pct: number | null;
  volume: number | null;
  quote_time: string | null;
  pts_price: number | null;
  pts_time: string | null;
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
  const ctl = AbortSignal.timeout(http.timeout_ms);
  const res = await fetch(url, { headers: { "User-Agent": http.user_agent }, signal: ctl });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const enc = detectEncoding(res.headers.get("content-type"), encodingHint || "utf-8");
  if (enc === "utf-8" || enc === "utf8") return buf.toString("utf8");
  return iconv.decode(buf, enc);
}

function toNumber(raw: string | undefined | null): number | null {
  if (!raw) return null;
  // 「+335」「-1.32」「8,881,700」「25,625円」などを数値化
  const cleaned = raw.replace(/[,円株%]/g, "").trim();
  if (!cleaned || cleaned === "－" || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// kabutan 銘柄ページから現値ブロックを抽出。
// 想定HTML(2026-05時点):
//   <div class="si_i1_2">
//     <span class="kabuka">25,625円</span>       ← ザラ場終値/現在値
//     <dl class="si_i1_dl1">
//       <dt>前日比</dt>
//       <dd><span class="up">+335</span></dd>
//       <dd><span class="up">+1.32</span>%</dd>
//     </dl>
//   </div>
//   <div class="si_i1_3">                         ← PTSがあるときだけ存在
//     <div class="kabuka1">PTS</div>
//     <div class="kabuka2">26,450円</div>
//     <div class="kabuka3">23:58　05/20</div>
//   </div>
//   ... 後段のテーブルに <th>出来高</th><td>8,881,700&nbsp;株</td>
function parseKabutanPrice(html: string): Omit<PriceSnapshot, "fetched_at" | "source" | "ticker"> {
  const $ = cheerio.load(html);
  const block = $(".si_i1_2").first();

  const price = toNumber(block.find(".kabuka").first().text());

  const dds = block.find(".si_i1_dl1 dd");
  const change = toNumber(dds.eq(0).find("span").first().text());
  const change_pct = toNumber(dds.eq(1).find("span").first().text());

  // 出来高はページ内に複数の表があるため、先頭の「出来高」行を採用
  let volume: number | null = null;
  $("th").each((_, th) => {
    if (volume !== null) return;
    if ($(th).text().trim() === "出来高") {
      volume = toNumber($(th).next("td").text());
    }
  });

  // 時刻は #stockinfo_i1 内の time タグ先頭 (15:30 など)
  const quote_time = $("#stockinfo_i1 time").first().attr("datetime") || null;

  // PTS は .si_i1_3 ブロックがあるときだけ。kabuka1 が "PTS" であることを念のため確認。
  const ptsBlock = $(".si_i1_3").first();
  let pts_price: number | null = null;
  let pts_time: string | null = null;
  if (ptsBlock.length > 0 && ptsBlock.find(".kabuka1").text().trim().includes("PTS")) {
    pts_price = toNumber(ptsBlock.find(".kabuka2").text());
    pts_time = ptsBlock.find(".kabuka3").text().replace(/\s+/g, " ").trim() || null;
  }

  return { price, change, change_pct, volume, quote_time, pts_price, pts_time };
}

async function fetchOne(
  code: string,
  http: HttpConfig,
  source: { site: string; encoding: string; url_template: string },
): Promise<PriceSnapshot> {
  const url = source.url_template.replace("{code}", code);
  const html = await fetchHtml(url, http, source.encoding);
  const parsed = parseKabutanPrice(html);
  return {
    fetched_at: new Date().toISOString(),
    source: `${source.site}:${code}`,
    ticker: code,
    ...parsed,
  };
}

async function main() {
  await mkdir(PRICES_DIR, { recursive: true });
  await mkdir(dirname(LOG), { recursive: true });

  const sources = await loadYaml<SourcesConfig>(join(ROOT, "config/sources.yaml"));
  const watchlist = await loadYaml<Watchlist>(join(ROOT, "config/watchlist.yaml"));

  // 今は kabutan のみ対応
  const kabutan = (sources.prices ?? []).find((s) => s.site === "kabutan");
  if (!kabutan) {
    await log("no kabutan price source configured");
    return;
  }

  let written = 0;
  let errors = 0;
  for (const t of watchlist.tickers) {
    try {
      const snap = await fetchOne(t.code, sources.http, kabutan);
      const line = JSON.stringify(snap) + "\n";
      await appendFile(join(PRICES_DIR, `${t.code}.jsonl`), line, "utf8");
      written++;
      await log(`[${t.code}] price=${snap.price} change=${snap.change} vol=${snap.volume} pts=${snap.pts_price ?? "-"}`);
    } catch (e) {
      errors++;
      await log(`[${t.code}] error: ${(e as Error).message}`);
    }
    await sleep(sources.http.min_interval_ms);
  }

  await log(`fetch-prices done: written=${written} errors=${errors}`);
  console.log(`written=${written} errors=${errors}`);
}

main().catch(async (e) => {
  await log(`fatal: ${(e as Error).stack ?? e}`);
  console.error(e);
  process.exit(1);
});
