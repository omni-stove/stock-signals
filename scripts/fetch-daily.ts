// scripts/fetch-daily.ts
// cron から平日16:00 (引け後) に1日1回叩かれる単発スクリプト。
//
// watchlist.yaml の全銘柄について kabutan の日々株価ページから直近~30営業日の
// OHLC + 出来高を取り、 data/daily/<code>.jsonl に追記する。
//
// 既に同じ date の行が末尾付近にある場合は重複として追記しない。これにより
// 同日に複数回走らせても安全 (idempotent)。
//
// LLM は使わない。スクレイピング・正規化のみ。
// 実行: `node scripts/fetch-daily.ts` (Node 26+ ネイティブTS実行)

import { readFile, mkdir, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DAILY_DIR = join(ROOT, "data/daily");
const LOG = join(ROOT, "logs/daily.log");

type HttpConfig = { user_agent: string; min_interval_ms: number; timeout_ms: number };

type SourcesConfig = {
  http: HttpConfig;
  daily?: { site: string; encoding: string; url_template: string }[];
};

type Watchlist = {
  tickers: { code: string; name: string }[];
};

type DailyBar = {
  date: string; // YYYY-MM-DD
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  change: number | null;
  change_pct: number | null;
  volume: number | null;
};

type DailyRow = DailyBar & {
  fetched_at: string;
  source: string;
  ticker: string;
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
  const cleaned = raw.replace(/[,円株%]/g, "").trim();
  if (!cleaned || cleaned === "－" || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// kabutan 時系列ページの「本日」表 (stock_kabuka0) と「過去」表 (stock_kabuka_dwm)
// の tbody tr を抽出。
//   <tr>
//     <th><time datetime="2026-05-20">26/05/20</time></th>
//     <td>始値</td><td>高値</td><td>安値</td><td>終値</td>
//     <td><span>前日比</span></td><td><span>前日比%</span></td>
//     <td>売買高</td>
//   </tr>
function parseKabutanDaily(html: string, ticker: string, source: string): DailyRow[] {
  const $ = cheerio.load(html);
  const rows: DailyRow[] = [];
  const fetched_at = new Date().toISOString();

  const harvest = (selector: string) => {
    $(`${selector} tbody tr`).each((_, tr) => {
      const $tr = $(tr);
      const date = $tr.find("th time").first().attr("datetime");
      if (!date) return;
      const tds = $tr.find("td");
      if (tds.length < 7) return;
      rows.push({
        fetched_at,
        source,
        ticker,
        date,
        open: toNumber(tds.eq(0).text()),
        high: toNumber(tds.eq(1).text()),
        low: toNumber(tds.eq(2).text()),
        close: toNumber(tds.eq(3).text()),
        change: toNumber(tds.eq(4).text()),
        change_pct: toNumber(tds.eq(5).text()),
        volume: toNumber(tds.eq(6).text()),
      });
    });
  };

  harvest("table.stock_kabuka0");
  harvest("table.stock_kabuka_dwm");

  return rows;
}

// 既存ファイルの末尾近くから、既知の日付の Set を作る (重複追記の防止用)
async function loadKnownDates(path: string): Promise<Set<string>> {
  const known = new Set<string>();
  try {
    const raw = await readFile(path, "utf8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (typeof obj.date === "string") known.add(obj.date);
      } catch {
        // 壊れた行はスキップ
      }
    }
  } catch {
    // ファイル無しは初回扱い
  }
  return known;
}

async function fetchOne(
  code: string,
  http: HttpConfig,
  source: { site: string; encoding: string; url_template: string },
): Promise<{ written: number; skipped: number }> {
  const url = source.url_template.replace("{code}", code);
  const html = await fetchHtml(url, http, source.encoding);
  const rows = parseKabutanDaily(html, code, `${source.site}:${code}`);
  if (rows.length === 0) {
    await log(`[${code}] no rows parsed`);
    return { written: 0, skipped: 0 };
  }

  const outPath = join(DAILY_DIR, `${code}.jsonl`);
  const known = await loadKnownDates(outPath);

  // 古い順に追記したいので date 昇順にソート
  rows.sort((a, b) => a.date.localeCompare(b.date));

  let written = 0;
  let skipped = 0;
  for (const row of rows) {
    if (known.has(row.date)) {
      skipped++;
      continue;
    }
    await appendFile(outPath, JSON.stringify(row) + "\n", "utf8");
    known.add(row.date);
    written++;
  }
  return { written, skipped };
}

async function main() {
  await mkdir(DAILY_DIR, { recursive: true });
  await mkdir(dirname(LOG), { recursive: true });

  const sources = await loadYaml<SourcesConfig>(join(ROOT, "config/sources.yaml"));
  const watchlist = await loadYaml<Watchlist>(join(ROOT, "config/watchlist.yaml"));

  const kabutan = (sources.daily ?? []).find((s) => s.site === "kabutan");
  if (!kabutan) {
    await log("no kabutan daily source configured");
    return;
  }

  let totalWritten = 0;
  let totalSkipped = 0;
  let errors = 0;
  for (const t of watchlist.tickers) {
    try {
      const { written, skipped } = await fetchOne(t.code, sources.http, kabutan);
      totalWritten += written;
      totalSkipped += skipped;
      await log(`[${t.code}] written=${written} skipped=${skipped}`);
    } catch (e) {
      errors++;
      await log(`[${t.code}] error: ${(e as Error).message}`);
    }
    await sleep(sources.http.min_interval_ms);
  }

  await log(`fetch-daily done: written=${totalWritten} skipped=${totalSkipped} errors=${errors}`);
  console.log(`written=${totalWritten} skipped=${totalSkipped} errors=${errors}`);
}

main().catch(async (e) => {
  await log(`fatal: ${(e as Error).stack ?? e}`);
  console.error(e);
  process.exit(1);
});
