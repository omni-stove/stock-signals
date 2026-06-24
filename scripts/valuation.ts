// scripts/valuation.ts
// 現在株価・今期予想PER・予想EPS を並べ、fair_per から逆算して
// 「この株価を fair_per で正当化するのに必要なEPS」と
// 「会社予想EPS からの必要な決算修正率」を算出し、ターミナル表に出す。
//
// 読むだけ・計算するだけの確認用スクリプト。LLM 不使用。append もしない。
//   - Worker /latest?kind=prices&code=<code>&n=1 の rows[0] → 現在株価
//   - Worker /latest?kind=fundamentals&code=<code>&n=1 の rows[0] → 予想PER / 予想EPS / 実績EPS
//   - worker/src/lib/watchlist.ts の fair_per → 適正PERの基準
//
// データ取得元は Cloudflare Worker。環境変数 WORKER_URL が必須 (未設定なら exit 1)。
// SYNC_TOKEN があれば Authorization: Bearer で付ける (未設定なら無害)。
//
// 逆算ロジック:
//   必要EPS         = 現在株価 / fair_per
//   必要な修正率(%) = (必要EPS - 会社予想EPS) / 会社予想EPS * 100
//     プラス  … 今の株価は fair_per を正当化するのに「上方修正」を織り込んでいる(=先行/割高寄り)
//     マイナス… 会社予想どおりでも fair_per まで上昇余地がある(=割安寄り)
//   参考: 適正株価 = 会社予想EPS * fair_per
//
// 実行: `WORKER_URL=https://... node scripts/valuation.ts`
//       `WORKER_URL=https://... node scripts/valuation.ts --json`  (機械可読なJSONで出す)

import { TICKERS } from "../worker/src/lib/watchlist.ts";

const WORKER_URL = process.env.WORKER_URL;
// vitest (in-source test) は CLI ではないので環境変数ガードを通さない。
if (!WORKER_URL && !import.meta.vitest) {
	console.error(
		"環境変数 WORKER_URL が未設定です (例: WORKER_URL=https://xxx.workers.dev)",
	);
	process.exit(1);
}
const SYNC_TOKEN = process.env.SYNC_TOKEN;

// Worker /latest?kind=... を叩いて rows を返す。失敗時は [] (呼び出し側が握りつぶす)。
async function fetchLatest<T>(
	kind: string,
	code: string,
	n: number,
): Promise<T[]> {
	const url = `${WORKER_URL}/latest?kind=${encodeURIComponent(kind)}&code=${encodeURIComponent(code)}&n=${n}`;
	const headers: Record<string, string> = {};
	if (SYNC_TOKEN) headers.Authorization = `Bearer ${SYNC_TOKEN}`;
	try {
		const res = await fetch(url, { headers });
		if (!res.ok) return [];
		const json = (await res.json()) as { ok?: boolean; rows?: T[] };
		if (!json.ok || !Array.isArray(json.rows)) return [];
		return json.rows;
	} catch {
		return [];
	}
}

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

function round(n: number | null, digits = 1): number | null {
	if (n === null || !Number.isFinite(n)) return null;
	const f = 10 ** digits;
	return Math.round(n * f) / f;
}

async function buildRow(t: {
	code: string;
	name: string;
	fair_per?: number | null;
}): Promise<Row> {
	// 現値は /latest?kind=prices の rows[0] (fetched_at DESC で最新)。
	// 予想PER/EPS は /latest?kind=fundamentals の rows[0] (date DESC で最新)。
	const price =
		(await fetchLatest<PriceSnapshot>("prices", t.code, 1))[0] ?? null;
	const fund =
		(await fetchLatest<Fundamentals>("fundamentals", t.code, 1))[0] ?? null;

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
	const rows: Row[] = [];
	for (const t of TICKERS) {
		rows.push(await buildRow(t));
	}

	if (asJson) {
		console.log(JSON.stringify(rows, null, 2));
		return;
	}
	printTable(rows);
}

// vitest 実行中 (in-source test) は CLI 本体を起動しない。
if (!import.meta.vitest) {
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}

// in-source tests (vitest.config.ts 参照)
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("round", () => {
		it("既定 1 桁で丸め、null/非有限は null", () => {
			expect(round(1.26)).toBe(1.3);
			expect(round(1.2345, 2)).toBe(1.23);
			expect(round(null)).toBeNull();
			expect(round(Number.NaN)).toBeNull();
		});
	});

	describe("fmt / fmtPct", () => {
		it("数値を千区切りで整形し、null は －", () => {
			expect(fmt(1234)).toBe("1,234");
			expect(fmt(1234, "円")).toBe("1,234円");
			expect(fmt(null)).toBe("－");
		});
		it("% は符号付き、null は －", () => {
			expect(fmtPct(2.5)).toBe("+2.5%");
			expect(fmtPct(-1)).toBe("-1%");
			expect(fmtPct(null)).toBe("－");
		});
	});
}
