// 既存の data/{prices,daily,fundamentals}/<code>.jsonl を D1 テーブルへ移行する。
//
// ローカルの append-only jsonl を、Worker と同じスキーマ・同じ冪等規則 (prices の
// 5分枠 slot、daily/fundamentals の date キー) で SQL に変換し、生成した .sql を
// 標準出力に吐く。実際の流し込みは wrangler に任せる:
//
//   # 確認 (SQLを眺める)
//   node migrate-jsonl.ts > /tmp/migrate.sql && less /tmp/migrate.sql
//   # ローカルD1へ
//   node migrate-jsonl.ts | npx wrangler d1 execute stock-signals --local  --file=/dev/stdin
//   # 本番D1へ (デプロイ後)
//   node migrate-jsonl.ts | npx wrangler d1 execute stock-signals --remote --file=/dev/stdin
//
// INSERT OR IGNORE/REPLACE なので、ローカル収集 → D1 の二重取り込みでも冪等。
// Node 26+ ネイティブTS実行。実行: `node worker/migrate-jsonl.ts`

import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "..", "data");

// SQL 文字列リテラルのエスケープ。null はそのまま NULL に。
function sql(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

// timeseries.ts の slot5min と同じ規則 (ISO8601 を5分枠に丸めた "YYYY-MM-DDTHH:MM")。
function slot5min(iso: string): string {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (!m) return iso;
  const floored = Math.floor(parseInt(m[3], 10) / 5) * 5;
  return `${m[1]}T${m[2]}:${String(floored).padStart(2, "0")}`;
}

async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(path, "utf8");
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      process.stderr.write(`-- skip broken line in ${path}\n`);
    }
  }
  return out;
}

// data/<kind>/ 配下の *.jsonl を列挙。ディレクトリ無しは空配列。
async function listJsonl(kind: string): Promise<string[]> {
  try {
    const files = await readdir(join(DATA, kind));
    return files.filter((f) => f.endsWith(".jsonl")).map((f) => join(DATA, kind, f));
  } catch {
    return [];
  }
}

function priceRow(r: Record<string, unknown>): string {
  const quote_time = (r.quote_time as string) || null;
  const fetched_at = r.fetched_at as string;
  const slot = slot5min(quote_time || fetched_at);
  const cols = [
    r.ticker, slot, r.source, r.price, r.change, r.change_pct,
    r.volume, quote_time, r.pts_price ?? null, r.pts_time ?? null, fetched_at,
  ];
  return `INSERT OR IGNORE INTO prices (ticker, slot, source, price, change, change_pct, volume, quote_time, pts_price, pts_time, fetched_at) VALUES (${cols.map(sql).join(", ")});`;
}

function dailyRow(r: Record<string, unknown>): string {
  const cols = [
    r.ticker, r.date, r.source, r.open, r.high, r.low, r.close,
    r.change, r.change_pct, r.volume, r.fetched_at,
  ];
  return `INSERT OR IGNORE INTO daily (ticker, date, source, open, high, low, close, change, change_pct, volume, fetched_at) VALUES (${cols.map(sql).join(", ")});`;
}

function fundamentalsRow(r: Record<string, unknown>): string {
  // jsonl は date を持たないので fetched_at の日付部分を date にする (収集ロジックと同じ)。
  const date = (r.fetched_at as string).slice(0, 10);
  const cols = [
    r.ticker, date, r.source, r.per, r.pbr, r.dividend_yield,
    r.forecast_eps, r.forecast_period, r.actual_eps, r.actual_period, r.fetched_at,
  ];
  return `INSERT OR REPLACE INTO fundamentals (ticker, date, source, per, pbr, dividend_yield, forecast_eps, forecast_period, actual_eps, actual_period, fetched_at) VALUES (${cols.map(sql).join(", ")});`;
}

async function emit(kind: string, toSql: (r: Record<string, unknown>) => string): Promise<number> {
  const files = await listJsonl(kind);
  let n = 0;
  for (const f of files) {
    const rows = await readJsonl(f);
    for (const r of rows) {
      process.stdout.write(toSql(r) + "\n");
      n++;
    }
  }
  process.stderr.write(`-- ${kind}: ${n} rows from ${files.length} files\n`);
  return n;
}

async function main() {
  // SQL文のみを stdout に出す (集計は stderr へ)。wrangler の SQL パーサは先頭コメントや
  // BEGIN/COMMIT を嫌うので付けない (wrangler が自前で1ステートメントずつ実行する)。
  const p = await emit("prices", priceRow);
  const d = await emit("daily", dailyRow);
  const f = await emit("fundamentals", fundamentalsRow);
  process.stderr.write(`-- total: prices=${p} daily=${d} fundamentals=${f}\n`);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
