// scripts/fetch-earnings-date.ts
// cron から1日1回(引け後)程度叩かれる単発スクリプト。
//
// watchlist.yaml の全銘柄について、kabutan の finance ページ
// (https://kabutan.jp/stock/finance?code={code}) の四半期業績テーブルから
// 次回決算発表予定日を推定し、watchlist.yaml の next_earnings_date を上書きする。
//
// 【なぜ推定なのか】
// kabutan には公式な「次回決算発表予定日」フィールドが安定して存在しない
// (予定行は発表直前にならないと出ない)。そこで従来 watchlist.yaml に手動で
// 入れていた「前年同期の発表日ベースの推定」を自動化する:
//   1. 四半期テーブルの実績行(YY.MM-MM)を暦順に並べ、最新の実績四半期を取る
//   2. その次の四半期(開始月 +3, 12超で翌年)を「次回」とみなす
//   3. 次回四半期の "前年同期" 実績行の発表日 +1年 を予定日とする
// 実測 (2026-06) で4銘柄とも手動値と一致 or より正確 (285A は手動の1日ズレを補正)。
//
// LLM は使わない。スクレイピング・正規化のみ。
// watchlist.yaml は値(next_earnings_date の右辺)だけ差し替え、コメントは保持する。
//
// 実行:
//   node scripts/fetch-earnings-date.ts            (推定して watchlist.yaml を更新)
//   node scripts/fetch-earnings-date.ts --dry-run  (推定結果を表示するだけ。書き換えない)

import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import * as cheerio from "cheerio";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WATCHLIST = join(ROOT, "config/watchlist.yaml");
const LOG = join(ROOT, "logs/earnings-date.log");

type HttpConfig = { user_agent: string; min_interval_ms: number; timeout_ms: number };
type SourcesConfig = { http: HttpConfig };
type Watchlist = { tickers: { code: string; name: string; next_earnings_date: string | null }[] };

// 四半期ラベル "25.04-06" -> { y: 2025, startM: 4, endM: 6, raw: "25.04-06" }
type Quarter = { y: number; startM: number; endM: number; raw: string };

function parseQLabel(label: string): Quarter | null {
  const m = label.match(/(\d{2})\.(\d{2})-(\d{2})/);
  if (!m) return null;
  return { y: 2000 + Number(m[1]), startM: Number(m[2]), endM: Number(m[3]), raw: m[0] };
}

// kabutan 発表日 "26/04/30" -> "2026-04-30"
function parseAnnounce(s: string | null | undefined): string | null {
  const m = (s ?? "").match(/(\d{2})\/(\d{2})\/(\d{2})/);
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : null;
}

async function loadYaml<T>(path: string): Promise<T> {
  return parseYaml(await readFile(path, "utf8")) as T;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function log(msg: string) {
  await appendFile(LOG, `${new Date().toISOString()} ${msg}\n`).catch(() => {});
}

async function fetchHtml(url: string, http: HttpConfig): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": http.user_agent },
    signal: AbortSignal.timeout(http.timeout_ms),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text(); // finance ページは utf-8
}

// finance ページから「四半期実績が最も多く並ぶテーブル」の行を抽出。
// 各行: 四半期(YY.MM-MM) + 発表日。「予」付き行(予想)・「前年同期比」行は除外する。
function extractQuarterRows(html: string): { q: Quarter; announce: string | null }[] {
  const $ = cheerio.load(html);
  let best: { rows: { q: Quarter; announce: string | null }[]; actuals: number } | null = null;

  $("table").each((_, table) => {
    const $t = $(table);
    const headers = $t
      .find("thead th")
      .map((_, th) => $(th).text().trim())
      .get();
    if (!(headers.includes("決算期") && headers.includes("発表日"))) return;

    const rows: { q: Quarter; announce: string | null }[] = [];
    $t.find("tbody tr").each((_, tr) => {
      const cells = $(tr).find("th, td");
      const label = cells.first().text().replace(/\s+/g, " ").trim();
      if (/予/.test(label)) return; // 予想行は推定の土台にしない
      const q = parseQLabel(label);
      if (!q) return; // 「前年同期比(%)」などの注記行はスキップ
      rows.push({ q, announce: parseAnnounce(cells.last().text()) });
    });

    if (!best || rows.length > best.actuals) best = { rows, actuals: rows.length };
  });

  return best ? best.rows : [];
}

// 四半期実績行から次回決算発表予定日 (YYYY-MM-DD) を推定する。
function estimateNextEarningsDate(html: string): { est: string | null; detail: string } {
  const rows = extractQuarterRows(html).filter((r) => r.announce);
  if (rows.length === 0) return { est: null, detail: "no quarterly rows" };

  // 暦順に並べ最新の実績四半期を取る
  rows.sort((a, b) => a.q.y - b.q.y || a.q.startM - b.q.startM);
  const last = rows[rows.length - 1];

  // 次の四半期の開始月 (+3、12超で翌年)
  let nextStartM = last.q.startM + 3;
  let nextStartY = last.q.y;
  if (nextStartM > 12) {
    nextStartM -= 12;
    nextStartY += 1;
  }

  // 次回四半期の "前年同期" 実績行を探す
  const prior = rows.find((r) => r.q.startM === nextStartM && r.q.y === nextStartY - 1);
  if (!prior || !prior.announce) {
    return {
      est: null,
      detail: `last=${last.q.raw}(${last.announce}) nextQ=${String(nextStartM).padStart(2, "0")}月 prior=none`,
    };
  }

  // 前年同期の発表日 +1年
  const d = new Date(`${prior.announce}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  const est = d.toISOString().slice(0, 10);

  return {
    est,
    detail: `last=${last.q.raw}(${last.announce}) prior=${prior.q.raw}(${prior.announce}) → ${est}`,
  };
}

// watchlist.yaml の対象 code ブロック内の next_earnings_date 行の値だけを置換する。
// コメント行はそのまま保持される (行単位置換のため)。
// code から次の code までの範囲に限定して 1 件だけ置き換える。
function replaceEarningsDate(yamlText: string, code: string, newDate: string): { text: string; changed: boolean } {
  const lines = yamlText.split("\n");
  // 対象銘柄ブロックの開始行 (- code: "XXXX")
  const codeRe = new RegExp(`^\\s*-\\s*code:\\s*["']?${code}["']?\\s*$`);
  const nextCodeRe = /^\s*-\s*code:\s*/;
  const dateRe = /^(\s*next_earnings_date:\s*)["']?[^"'\s#]*["']?(.*)$/;

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (codeRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return { text: yamlText, changed: false };

  for (let i = start + 1; i < lines.length; i++) {
    if (nextCodeRe.test(lines[i])) break; // 次の銘柄ブロックに入ったら打ち切り
    const m = lines[i].match(dateRe);
    if (m) {
      const rebuilt = `${m[1]}"${newDate}"${m[2]}`;
      if (rebuilt === lines[i]) return { text: yamlText, changed: false };
      lines[i] = rebuilt;
      return { text: lines.join("\n"), changed: true };
    }
  }
  return { text: yamlText, changed: false };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  await mkdir(dirname(LOG), { recursive: true });

  const sources = await loadYaml<SourcesConfig>(join(ROOT, "config/sources.yaml"));
  const watchlist = await loadYaml<Watchlist>(WATCHLIST);
  let yamlText = await readFile(WATCHLIST, "utf8");

  let updated = 0;
  let unchanged = 0;
  let errors = 0;

  for (const t of watchlist.tickers) {
    try {
      const url = `https://kabutan.jp/stock/finance?code=${t.code}`;
      const html = await fetchHtml(url, sources.http);
      const { est, detail } = estimateNextEarningsDate(html);

      if (!est) {
        errors++;
        await log(`[${t.code}] 推定不可: ${detail}`);
        console.log(`${t.code} ${t.name}: 推定不可 (${detail})`);
      } else if (est === t.next_earnings_date) {
        unchanged++;
        await log(`[${t.code}] 変更なし ${est}`);
        console.log(`${t.code} ${t.name}: ${est} (変更なし)`);
      } else {
        const res = replaceEarningsDate(yamlText, t.code, est);
        if (res.changed) {
          yamlText = res.text;
          updated++;
          await log(`[${t.code}] 更新 ${t.next_earnings_date ?? "null"} → ${est} | ${detail}`);
          console.log(`${t.code} ${t.name}: ${t.next_earnings_date ?? "null"} → ${est}${dryRun ? " (dry-run)" : ""}`);
        } else {
          errors++;
          await log(`[${t.code}] YAML行特定失敗 (est=${est})`);
          console.log(`${t.code} ${t.name}: YAML行特定失敗`);
        }
      }
    } catch (e) {
      errors++;
      await log(`[${t.code}] error: ${(e as Error).message}`);
      console.log(`${t.code} ${t.name}: error ${(e as Error).message}`);
    }
    await sleep(sources.http.min_interval_ms);
  }

  if (updated > 0 && !dryRun) {
    await writeFile(WATCHLIST, yamlText, "utf8");
  }

  const summary = `fetch-earnings-date done: updated=${updated} unchanged=${unchanged} errors=${errors}${dryRun ? " (dry-run, not written)" : ""}`;
  await log(summary);
  console.log(summary);
}

main().catch(async (e) => {
  await log(`fatal: ${(e as Error).stack ?? e}`);
  console.error(e);
  process.exit(1);
});
