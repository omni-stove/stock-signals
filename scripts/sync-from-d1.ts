// scripts/sync-from-d1.ts
// クラウド (Cloudflare Worker + D1) が集めた時系列データを、ローカルの
// data/{prices,daily,fundamentals}/<code>.jsonl に引き戻す同期スクリプト。
//
// Mac の cron に依存せず Worker が prices/daily/fundamentals を D1 に蓄積している前提で、
// Mac 起動時 (または読みたい直前) にこれを1回叩けば、valuation.ts / sector.ts /
// analyze-ticker が読む jsonl が最新化される。読み手のロジックは一切変えない。
//
// Worker の /dump?kind=...&code=... は「ローカル jsonl と同じ列・古い順」で ndjson を返す。
// ここではそれを GET し、data/<kind>/<code>.jsonl を丸ごと置き換える (D1 が source of truth)。
//
// 環境変数:
//   WORKER_URL   … 例 https://stock-signals-collector.<sub>.workers.dev (dev は http://localhost:8800)
//   SYNC_TOKEN   … Worker 側 SYNC_TOKEN を設定している場合のみ必要 (dev は不要)
//
// 実行: `WORKER_URL=... node scripts/sync-from-d1.ts`
//       cron 例: 平日朝など `WORKER_URL=... node scripts/sync-from-d1.ts >> logs/sync.log 2>&1`

import { mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOG = join(ROOT, "logs/sync.log");

const KINDS = ["prices", "daily", "fundamentals"] as const;
type Kind = (typeof KINDS)[number];

type Watchlist = { tickers: { code: string }[] };

async function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  await appendFile(LOG, line).catch(() => {});
}

async function loadYaml<T>(path: string): Promise<T> {
  return parseYaml(await readFile(path, "utf8")) as T;
}

// Worker から1銘柄1種別の ndjson を取得して data/<kind>/<code>.jsonl を置き換える。
async function syncOne(base: string, token: string | null, kind: Kind, code: string): Promise<number> {
  const u = new URL(`${base}/dump`);
  u.searchParams.set("kind", kind);
  u.searchParams.set("code", code);
  if (token) u.searchParams.set("token", token);

  const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${kind}/${code}: ${await res.text()}`);
  const body = (await res.text()).trim();

  const outDir = join(ROOT, "data", kind);
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${code}.jsonl`);
  // D1 が source of truth なので丸ごと置き換える (末尾に改行を1つ足す)。
  await writeFile(outPath, body ? body + "\n" : "", "utf8");
  return body ? body.split("\n").length : 0;
}

async function main() {
  const base = (process.env.WORKER_URL || "").replace(/\/$/, "");
  if (!base) {
    console.error("WORKER_URL が未設定です。例: WORKER_URL=http://localhost:8800 node scripts/sync-from-d1.ts");
    process.exit(2);
  }
  const token = process.env.SYNC_TOKEN || null;

  await mkdir(dirname(LOG), { recursive: true });
  const watchlist = await loadYaml<Watchlist>(join(ROOT, "config/watchlist.yaml"));

  let totalRows = 0;
  let errors = 0;
  for (const kind of KINDS) {
    for (const t of watchlist.tickers) {
      try {
        const n = await syncOne(base, token, kind, t.code);
        totalRows += n;
        await log(`[${kind}/${t.code}] rows=${n}`);
      } catch (e) {
        errors++;
        await log(`[${kind}/${t.code}] error: ${(e as Error).message}`);
      }
    }
  }

  const summary = `sync done: rows=${totalRows} errors=${errors} from ${base}`;
  await log(summary);
  console.log(summary);
  if (errors > 0) process.exit(1);
}

main().catch(async (e) => {
  await log(`fatal: ${(e as Error).stack ?? e}`);
  console.error(e);
  process.exit(1);
});
