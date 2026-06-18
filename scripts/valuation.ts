// scripts/valuation.ts
// 現在株価・今期予想PER・予想EPS を並べ、fair_per から逆算して
// 「この株価を fair_per で正当化するのに必要なEPS」と
// 「会社予想EPS からの必要な決算修正率」を算出し、ターミナル表に出す。
//
// 読むだけ・計算するだけの確認用スクリプト。LLM 不使用。append もしない。
//   - data/prices/<code>.jsonl の最終行 → 現在株価
//   - data/fundamentals/<code>.jsonl の最終行 → 予想PER / 予想EPS / 実績EPS
//   - config/watchlist.yaml の fair_per → 適正PERの基準
//
// 逆算ロジック:
//   必要EPS         = 現在株価 / fair_per
//   必要な修正率(%) = (必要EPS - 会社予想EPS) / 会社予想EPS * 100
//     プラス  … 今の株価は fair_per を正当化するのに「上方修正」を織り込んでいる(=先行/割高寄り)
//     マイナス… 会社予想どおりでも fair_per まで上昇余地がある(=割安寄り)
//   参考: 適正株価 = 会社予想EPS * fair_per
//
// 実行: `node scripts/valuation.ts`
//       `node scripts/valuation.ts --json`  (機械可読なJSONで出す)

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

type Watchlist = {
  tickers: { code: string; name: string; fair_per?: number | null }[];
};

type PriceSnapshot = {
  price: number | null;
  quote_time: string | null;
  pts_price: number | null;
};

type Fundamentals = {
  per: number | null;
  forecast_eps: number | null;
  forecast_period: string | null;
  actual_eps: number | null;
  fetched_at: string;
};

type Row = {
  code: string;
  name: string;
  price: number | null;
  per: number | null;
  forecast_eps: number | null;
  forecast_period: string | null;
  fair_per: number | null;
  required_eps: number | null;
  required_revision_pct: number | null;
  fair_price: number | null;
  note: string;
};

async function loadYaml<T>(path: string): Promise<T> {
  return parseYaml(await readFile(path, "utf8")) as T;
}

// JSONL の最終行をパースして返す。ファイルなし/空なら null。
async function lastJsonl<T>(path: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1]) as T;
  } catch {
    return null;
  }
}

function round(n: number | null, digits = 1): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

async function buildRow(t: { code: string; name: string; fair_per?: number | null }): Promise<Row> {
  const price = await lastJsonl<PriceSnapshot>(join(ROOT, `data/prices/${t.code}.jsonl`));
  const fund = await lastJsonl<Fundamentals>(join(ROOT, `data/fundamentals/${t.code}.jsonl`));

  const p = price?.price ?? null;
  const fairPer = t.fair_per ?? null;
  const fEps = fund?.forecast_eps ?? null;

  let required_eps: number | null = null;
  let required_revision_pct: number | null = null;
  let fair_price: number | null = null;
  let note = "";

  if (p === null) note = "現在株価なし";
  else if (fairPer === null) note = "fair_per未設定";
  else {
    required_eps = round(p / fairPer, 1);
    if (fEps === null || fEps === 0) {
      note = fEps === null ? "予想EPS未開示" : "予想EPS=0";
    } else {
      required_revision_pct = round(((p / fairPer - fEps) / fEps) * 100, 1);
      fair_price = round(fEps * fairPer, 0);
    }
  }

  return {
    code: t.code,
    name: t.name,
    price: p,
    per: fund?.per ?? null,
    forecast_eps: fEps,
    forecast_period: fund?.forecast_period ?? null,
    fair_per: fairPer,
    required_eps,
    required_revision_pct,
    fair_price,
    note,
  };
}

function fmt(n: number | null, suffix = ""): string {
  if (n === null) return "－";
  return n.toLocaleString("ja-JP") + suffix;
}

function fmtPct(n: number | null): string {
  if (n === null) return "－";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString("ja-JP")}%`;
}

function pad(s: string, width: number): string {
  // 全角を2幅として概算で右パディング
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return s + " ".repeat(Math.max(0, width - w));
}

function printTable(rows: Row[]) {
  const header = [
    pad("コード", 8),
    pad("銘柄", 24),
    pad("現在株価", 12),
    pad("予想PER", 10),
    pad("予想EPS", 12),
    pad("fairPER", 9),
    pad("必要EPS", 12),
    pad("必要修正", 11),
    pad("適正株価", 12),
    "備考",
  ].join(" ");
  console.log(header);
  console.log("─".repeat(120));
  for (const r of rows) {
    console.log(
      [
        pad(r.code, 8),
        pad(r.name, 24),
        pad(fmt(r.price, "円"), 12),
        pad(fmt(r.per, "倍"), 10),
        pad(fmt(r.forecast_eps, "円"), 12),
        pad(fmt(r.fair_per, "倍"), 9),
        pad(fmt(r.required_eps, "円"), 12),
        pad(fmtPct(r.required_revision_pct), 11),
        pad(fmt(r.fair_price, "円"), 12),
        r.note,
      ].join(" "),
    );
  }
  console.log("─".repeat(120));
  console.log(
    "必要EPS = 現在株価 / fairPER。必要修正 = (必要EPS - 予想EPS) / 予想EPS。",
  );
  console.log(
    "  プラス = 株価が fairPER を正当化するのに上方修正を織り込み済み(先行/割高寄り)、マイナス = 会社予想でも上昇余地(割安寄り)。",
  );
}

async function main() {
  const asJson = process.argv.includes("--json");
  const watchlist = await loadYaml<Watchlist>(join(ROOT, "config/watchlist.yaml"));
  const rows: Row[] = [];
  for (const t of watchlist.tickers) {
    rows.push(await buildRow(t));
  }

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  printTable(rows);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
