// scripts/sector.ts
// セクターの地合いと、セクター内での各銘柄の相対強弱をまとめて表示する確認用スクリプト。
//
// 「今日の値動き(寄り付き・値幅)を読む」ための土台を2軸で並べる:
//   ① 外部地合い … data/premarket/<最新>.jsonl から SOX 騰落率を読み、半導体セクターの
//        前夜の追い風/逆風を risk-on / risk-off / neutral で判定する。
//   ② セクター内相対強弱 … 同一 sector の銘柄について data/daily/<code>.jsonl から
//        直近の前日比%・5日リターン%・出来高比を計算し、セクター平均からの乖離で
//        「この銘柄がセクター内で相対的に強いか弱いか」を出す。
//        (セクター全体が上げている日に独り負けしている、等を捉えるのが目的)
//
// 読むだけ・計算するだけ。LLM 不使用。append もしない (valuation.ts と同じ流儀)。
//   - config/watchlist.yaml の sector / sector_role
//   - data/daily/<code>.jsonl     → 日足 (前日比・5日リターン・出来高)
//   - data/premarket/<最新>.jsonl → SOX 騰落率 (外部地合い)
//
// 実行:
//   node scripts/sector.ts                 (全 sector を表示)
//   node scripts/sector.ts semiconductor   (指定 sector のみ)
//   node scripts/sector.ts --json          (機械可読)
//   node scripts/sector.ts semiconductor --json

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

type Ticker = {
  code: string;
  name: string;
  sector?: string | null;
  sector_role?: string | null;
};
type Watchlist = { tickers: Ticker[] };

type DailyBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  change: number;
  change_pct: number;
  volume: number;
};

type PremarketLine = {
  date: string;
  sox_change_pct?: number;
  us_indexes?: { key: string; label: string; change_pct: number }[];
  nikkei_futures?: { price: number; contract?: string } | null;
};

type SectorRow = {
  code: string;
  name: string;
  sector_role: string | null;
  last_date: string | null;
  change_pct: number | null; // 直近営業日の前日比%
  ret_5d_pct: number | null; // 直近終値 / 5営業日前終値 - 1
  vol_ratio: number | null; // 直近出来高 / 直近5日平均出来高
  rel_strength_pct: number | null; // ret_5d_pct - セクター平均ret_5d_pct (相対強弱)
  note: string;
};

type SectorReport = {
  sector: string;
  backdrop: {
    sox_change_pct: number | null;
    nasdaq_change_pct: number | null;
    nikkei_futures: number | null;
    premarket_date: string | null;
    tone: "risk-on" | "risk-off" | "neutral" | "unknown";
  };
  avg_change_pct: number | null;
  avg_ret_5d_pct: number | null;
  rows: SectorRow[];
};

async function loadYaml<T>(path: string): Promise<T> {
  return parseYaml(await readFile(path, "utf8")) as T;
}

// JSONL を全行パースして配列で返す。ファイルなし/空なら []。
async function readJsonl<T>(path: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* 壊れた行は無視 */
    }
  }
  return out;
}

function round(n: number | null, digits = 2): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function avg(ns: (number | null)[]): number | null {
  const xs = ns.filter((n): n is number => n !== null && Number.isFinite(n));
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// data/premarket/ の最新日付ファイルから外部地合いを読む。
async function loadBackdrop(): Promise<SectorReport["backdrop"]> {
  const dir = join(ROOT, "data/premarket");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    files = [];
  }
  const empty: SectorReport["backdrop"] = {
    sox_change_pct: null,
    nasdaq_change_pct: null,
    nikkei_futures: null,
    premarket_date: null,
    tone: "unknown",
  };
  if (files.length === 0) return empty;
  files.sort(); // YYYY-MM-DD.jsonl なので辞書順 = 日付順
  const latest = files[files.length - 1];
  const lines = await readJsonl<PremarketLine>(join(dir, latest));
  // 米国指数を含む行 (kehai 行ではない方) を拾う。
  const idxLine = lines.find((l) => l.us_indexes && l.us_indexes.length > 0) ?? lines[0];
  if (!idxLine) return { ...empty, premarket_date: latest.replace(".jsonl", "") };

  const sox =
    idxLine.sox_change_pct ??
    idxLine.us_indexes?.find((i) => i.key === "sox")?.change_pct ??
    null;
  const ndx = idxLine.us_indexes?.find((i) => i.key === "ndx")?.change_pct ?? null;
  const fut = idxLine.nikkei_futures?.price ?? null;

  let tone: SectorReport["backdrop"]["tone"] = "unknown";
  if (sox !== null) {
    if (sox >= 1.5) tone = "risk-on";
    else if (sox <= -1.5) tone = "risk-off";
    else tone = "neutral";
  }

  return {
    sox_change_pct: round(sox),
    nasdaq_change_pct: round(ndx),
    nikkei_futures: fut,
    premarket_date: idxLine.date ?? latest.replace(".jsonl", ""),
    tone,
  };
}

// 1銘柄の日足から指標を計算 (相対強弱はまだ入れない。あとでセクター平均と突き合わせる)。
async function buildRowBase(t: Ticker): Promise<Omit<SectorRow, "rel_strength_pct">> {
  const bars = await readJsonl<DailyBar>(join(ROOT, `data/daily/${t.code}.jsonl`));
  const role = t.sector_role ?? null;
  if (bars.length === 0) {
    return {
      code: t.code,
      name: t.name,
      sector_role: role,
      last_date: null,
      change_pct: null,
      ret_5d_pct: null,
      vol_ratio: null,
      note: "日足データなし",
    };
  }
  // 日付昇順を保証 (append 順だが念のためソート)。
  bars.sort((a, b) => a.date.localeCompare(b.date));
  const last = bars[bars.length - 1];

  // 5日リターン: 直近終値 / 6本前(=5営業日前)の終値 - 1。本数不足なら最古比。
  let ret5d: number | null = null;
  if (bars.length >= 6) {
    const base = bars[bars.length - 6].close;
    if (base > 0) ret5d = (last.close / base - 1) * 100;
  } else if (bars.length >= 2) {
    const base = bars[0].close;
    if (base > 0) ret5d = (last.close / base - 1) * 100;
  }

  // 出来高比: 直近出来高 / 直近5本(直近日除く)の平均出来高。
  let volRatio: number | null = null;
  if (bars.length >= 2) {
    const window = bars.slice(Math.max(0, bars.length - 6), bars.length - 1);
    const v = avg(window.map((b) => b.volume));
    if (v && v > 0) volRatio = last.volume / v;
  }

  const note = bars.length < 6 ? `本数不足(${bars.length}本、概算)` : "";

  return {
    code: t.code,
    name: t.name,
    sector_role: role,
    last_date: last.date,
    change_pct: round(last.change_pct),
    ret_5d_pct: round(ret5d),
    vol_ratio: round(volRatio),
    note,
  };
}

async function buildSectorReport(
  sector: string,
  tickers: Ticker[],
  backdrop: SectorReport["backdrop"],
): Promise<SectorReport> {
  const bases = await Promise.all(tickers.map((t) => buildRowBase(t)));
  const avgChange = avg(bases.map((b) => b.change_pct));
  const avgRet5d = avg(bases.map((b) => b.ret_5d_pct));

  const rows: SectorRow[] = bases.map((b) => ({
    ...b,
    rel_strength_pct:
      b.ret_5d_pct !== null && avgRet5d !== null ? round(b.ret_5d_pct - avgRet5d) : null,
  }));
  // 相対強弱の強い順に並べる (上が relative-strong)。
  rows.sort((a, b) => (b.rel_strength_pct ?? -Infinity) - (a.rel_strength_pct ?? -Infinity));

  return {
    sector,
    backdrop,
    avg_change_pct: round(avgChange),
    avg_ret_5d_pct: round(avgRet5d),
    rows,
  };
}

// ---- 表示ヘルパー (valuation.ts と同様の全角2幅パディング) ----
function fmtPct(n: number | null): string {
  if (n === null) return "－";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}
function fmtRatio(n: number | null): string {
  if (n === null) return "－";
  return `${n.toFixed(2)}x`;
}
function pad(s: string, width: number): string {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return s + " ".repeat(Math.max(0, width - w));
}

function toneLabel(tone: SectorReport["backdrop"]["tone"]): string {
  switch (tone) {
    case "risk-on":
      return "リスクオン (前夜の半導体追い風)";
    case "risk-off":
      return "リスクオフ (前夜の半導体逆風)";
    case "neutral":
      return "中立 (SOX小動き)";
    default:
      return "不明 (premarketデータなし)";
  }
}

function printReport(rep: SectorReport) {
  const b = rep.backdrop;
  console.log(`\n■ セクター: ${rep.sector}`);
  console.log("─".repeat(108));
  console.log(
    `外部地合い [${b.premarket_date ?? "－"}]  SOX ${fmtPct(b.sox_change_pct)} / ` +
      `Nasdaq ${fmtPct(b.nasdaq_change_pct)} / 日経先物 ${b.nikkei_futures ?? "－"}  ` +
      `→ ${toneLabel(b.tone)}`,
  );
  console.log(
    `セクター平均  前日比 ${fmtPct(rep.avg_change_pct)} / 5日 ${fmtPct(rep.avg_ret_5d_pct)}`,
  );
  console.log("─".repeat(108));
  const header = [
    pad("コード", 7),
    pad("銘柄", 24),
    pad("役割", 12),
    pad("直近日", 12),
    pad("前日比", 10),
    pad("5日", 10),
    pad("出来高比", 10),
    pad("相対強弱", 11),
    "備考",
  ].join(" ");
  console.log(header);
  for (const r of rep.rows) {
    console.log(
      [
        pad(r.code, 7),
        pad(r.name, 24),
        pad(r.sector_role ?? "－", 12),
        pad(r.last_date ?? "－", 12),
        pad(fmtPct(r.change_pct), 10),
        pad(fmtPct(r.ret_5d_pct), 10),
        pad(fmtRatio(r.vol_ratio), 10),
        pad(fmtPct(r.rel_strength_pct), 11),
        r.note,
      ].join(" "),
    );
  }
  console.log("─".repeat(108));
  console.log(
    "相対強弱 = 各銘柄の5日リターン − セクター平均5日リターン。プラス=セクター内で相対的に強い、マイナス=独り負け寄り。",
  );
  console.log(
    "出来高比 = 直近出来高 / 直近5日平均。1.5x超は商いが膨らみ材料/転換の可能性。",
  );
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const sectorArg = args.find((a) => !a.startsWith("--")) ?? null;

  const watchlist = await loadYaml<Watchlist>(join(ROOT, "config/watchlist.yaml"));
  const backdrop = await loadBackdrop();

  // sector ごとにグループ化 (sector 未設定の銘柄は除外)。
  const groups = new Map<string, Ticker[]>();
  for (const t of watchlist.tickers) {
    const s = t.sector ?? null;
    if (!s) continue;
    if (sectorArg && s !== sectorArg) continue;
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s)!.push(t);
  }

  if (groups.size === 0) {
    const msg = sectorArg
      ? `sector "${sectorArg}" に該当する銘柄がありません (watchlist.yaml の sector を確認)`
      : "sector が設定された銘柄がありません (watchlist.yaml に sector を追加してください)";
    if (asJson) console.log(JSON.stringify({ error: msg }, null, 2));
    else console.error(msg);
    return;
  }

  const reports: SectorReport[] = [];
  for (const [sector, tickers] of groups) {
    reports.push(await buildSectorReport(sector, tickers, backdrop));
  }

  if (asJson) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }
  for (const rep of reports) printReport(rep);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
