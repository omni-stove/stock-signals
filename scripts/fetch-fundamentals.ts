// scripts/fetch-fundamentals.ts
// cron から1日1回(引け後)程度叩かれる単発スクリプト。
//
// watchlist.yaml の全銘柄について、kabutan の銘柄ページから
// 今期予想PER・今期予想EPS・直近実績EPS を取り、
// data/fundamentals/<code>.jsonl に1行追記する。
//
// LLM は使わない。スクレイピング・正規化のみ。
// 逆算(必要EPS・必要修正率)は valuation.ts 側で行う。ここは生値の蓄積だけ。
//
// 実行: `node scripts/fetch-fundamentals.ts` (Node 26+ ネイティブTS実行)

import { readFile, mkdir, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FUND_DIR = join(ROOT, "data/fundamentals");
const LOG = join(ROOT, "logs/fundamentals.log");

type HttpConfig = { user_agent: string; min_interval_ms: number; timeout_ms: number };

type SourcesConfig = {
  http: HttpConfig;
  fundamentals?: { site: string; encoding: string; url_template: string }[];
};

type Watchlist = {
  tickers: { code: string; name: string }[];
};

type Fundamentals = {
  fetched_at: string;
  source: string;
  ticker: string;
  // PERテーブル先頭(今期予想ベース)の PER / PBR / 配当利回り
  per: number | null;
  pbr: number | null;
  dividend_yield: number | null;
  // 業績推移テーブルの「予」行(今期予想)の1株益、およびその決算期
  forecast_eps: number | null;
  forecast_period: string | null;
  // 直近の実績行(「予」が付かない最後の行)の1株益
  actual_eps: number | null;
  actual_period: string | null;
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
  // 「40.6倍」「23.76倍」「0.79％」「642.1」「－」などを数値化
  const cleaned = raw.replace(/[,倍円株%％]/g, "").trim();
  if (!cleaned || cleaned === "－" || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// 決算期ラベルから期表記だけを取り出す。
//   "I　 予 2027.03  " → "2027.03"、"  予 2026.12  " → "2026.12"
function normalizePeriod(label: string): string | null {
  const m = label.match(/(\d{4}\.\d{2})/);
  return m ? m[1] : null;
}

// 決算期ラベルに「予」が含まれていれば今期予想行。
function isForecastRow(label: string): boolean {
  return /予/.test(label);
}

// kabutan 銘柄ページから PER テーブルと業績推移テーブルを抽出。
//
// PERテーブル(想定HTML, 2026-05時点):
//   <table><thead><tr><th>PER</th><th>PBR</th><th>利回り</th><th>信用倍率</th></tr></thead>
//     <tbody><tr><td>40.6倍</td><td>23.76倍</td><td>－％</td><td>6.82倍</td></tr>...</tbody></table>
//   ※ この PER は今期予想EPSベース(株価/予想EPS と整合)。
//
// 業績推移テーブル:
//   <table>...<th>決算期</th><th>売上高</th><th>経常益</th><th>最終益</th>
//             <th>１株益</th><th>１株配</th><th>発表日</th>...
//     行ラベルに「予」が付く行 = 今期予想。1株益(5列目)が予想EPS。
//     「予」の付かない最後の実績行 = 直近実績。
function parseKabutanFundamentals(html: string): Omit<Fundamentals, "fetched_at" | "source" | "ticker"> {
  const $ = cheerio.load(html);

  let per: number | null = null;
  let pbr: number | null = null;
  let dividend_yield: number | null = null;

  // PER/PBR/利回りを持つテーブルを特定し、tbody 先頭 tr の td を読む。
  $("table").each((_, table) => {
    if (per !== null) return; // 最初に見つかったものを採用
    const $t = $(table);
    const headers = $t
      .find("thead th")
      .map((_, th) => $(th).text().trim())
      .get();
    if (headers.includes("PER") && headers.includes("PBR")) {
      const firstRow = $t.find("tbody tr").first();
      const tds = firstRow.find("td");
      per = toNumber(tds.eq(0).text());
      pbr = toNumber(tds.eq(1).text());
      dividend_yield = toNumber(tds.eq(2).text());
    }
  });

  let forecast_eps: number | null = null;
  let forecast_period: string | null = null;
  let actual_eps: number | null = null;
  let actual_period: string | null = null;

  // 業績推移テーブル: 「決算期」かつ「１株益」を持つテーブルを特定。
  $("table").each((_, table) => {
    if (forecast_period !== null || actual_period !== null) return;
    const $t = $(table);
    const headers = $t
      .find("thead th")
      .map((_, th) => $(th).text().trim())
      .get();
    const epsCol = headers.findIndex((h) => h.includes("１株益") || h.includes("1株益"));
    if (!headers.includes("決算期") || epsCol < 0) return;

    $t.find("tbody tr").each((_, tr) => {
      const cells = $(tr).find("th, td");
      const label = cells.first().text().replace(/ /g, " ").replace(/　/g, " ").trim();
      const period = normalizePeriod(label);
      if (!period) return; // 「前期比(%)」などの注記行はスキップ
      const eps = toNumber(cells.eq(epsCol).text());
      if (isForecastRow(label)) {
        // 最も手前(=今期)の予想行を採用
        if (forecast_period === null) {
          forecast_eps = eps;
          forecast_period = period;
        }
      } else {
        // 実績行は下にいくほど新しい。最後に見たものが直近実績。
        actual_eps = eps;
        actual_period = period;
      }
    });
  });

  return {
    per,
    pbr,
    dividend_yield,
    forecast_eps,
    forecast_period,
    actual_eps,
    actual_period,
  };
}

async function fetchOne(
  code: string,
  http: HttpConfig,
  source: { site: string; encoding: string; url_template: string },
): Promise<Fundamentals> {
  const url = source.url_template.replace("{code}", code);
  const html = await fetchHtml(url, http, source.encoding);
  const parsed = parseKabutanFundamentals(html);
  return {
    fetched_at: new Date().toISOString(),
    source: `${source.site}:${code}`,
    ticker: code,
    ...parsed,
  };
}

async function main() {
  await mkdir(FUND_DIR, { recursive: true });
  await mkdir(dirname(LOG), { recursive: true });

  const sources = await loadYaml<SourcesConfig>(join(ROOT, "config/sources.yaml"));
  const watchlist = await loadYaml<Watchlist>(join(ROOT, "config/watchlist.yaml"));

  const kabutan = (sources.fundamentals ?? []).find((s) => s.site === "kabutan");
  if (!kabutan) {
    await log("no kabutan fundamentals source configured");
    return;
  }

  let written = 0;
  let errors = 0;
  for (const t of watchlist.tickers) {
    try {
      const f = await fetchOne(t.code, sources.http, kabutan);
      const line = JSON.stringify(f) + "\n";
      await appendFile(join(FUND_DIR, `${t.code}.jsonl`), line, "utf8");
      written++;
      await log(
        `[${t.code}] per=${f.per ?? "-"} fEPS=${f.forecast_eps ?? "-"}(${f.forecast_period ?? "-"}) aEPS=${f.actual_eps ?? "-"}(${f.actual_period ?? "-"})`,
      );
    } catch (e) {
      errors++;
      await log(`[${t.code}] error: ${(e as Error).message}`);
    }
    await sleep(sources.http.min_interval_ms);
  }

  await log(`fetch-fundamentals done: written=${written} errors=${errors}`);
  console.log(`written=${written} errors=${errors}`);
}

main().catch(async (e) => {
  await log(`fatal: ${(e as Error).stack ?? e}`);
  console.error(e);
  process.exit(1);
});
