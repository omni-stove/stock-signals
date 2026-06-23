// セクターの地合い (backdrop tone) と、セクター内での各銘柄の相対強弱を計算する純粋関数群。
//
// 設計 (旧 scripts/sector.ts の計算ロジックを Worker に移植):
//   - sector.ts は HTTP (/latest) を叩いて集計していたが、Worker 内では D1 を直読みできるので、
//     ここは「premarket 1行 + 各銘柄の daily 行配列 → SectorReport[]」の純粋関数に徹する。
//     取得 (D1 read) は routes/market-context.ts が行う。
//   - 出力構造 (SectorReport) は旧 sector.ts --json と同一。market-check skill が読む。
//   - 丸め/平均/tone 判定は sector.ts と同一にすること (sector.ts の in-source test を移植)。

import type { WatchlistMeta } from "./watchlist.gen";

export interface DailyBar {
	date: string;
	close: number;
	change_pct?: number | null;
	volume?: number | null;
	[key: string]: unknown;
}

export interface PremarketLine {
	date?: string | null;
	sox_change_pct?: number | null;
	nasdaq_change_pct?: number | null;
	dow_change_pct?: number | null;
	nikkei_futures_price?: number | null;
	us_indexes?: { key: string; label: string; change_pct: number }[] | null;
}

interface SectorRow {
	code: string;
	name: string;
	sector_role: string | null;
	last_date: string | null;
	change_pct: number | null;
	ret_5d_pct: number | null;
	vol_ratio: number | null;
	rel_strength_pct: number | null;
	note: string;
}

interface SectorBackdrop {
	sox_change_pct: number | null;
	nasdaq_change_pct: number | null;
	nikkei_futures: number | null;
	premarket_date: string | null;
	tone: "risk-on" | "risk-off" | "neutral" | "unknown";
}

export interface SectorReport {
	sector: string;
	backdrop: SectorBackdrop;
	avg_change_pct: number | null;
	avg_ret_5d_pct: number | null;
	rows: SectorRow[];
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

// premarket 1 行から外部地合いを読む。sox >= 1.5 risk-on / <= -1.5 risk-off / else neutral。
function loadBackdrop(line: PremarketLine | null): SectorBackdrop {
	const empty: SectorBackdrop = {
		sox_change_pct: null,
		nasdaq_change_pct: null,
		nikkei_futures: null,
		premarket_date: null,
		tone: "unknown",
	};
	if (!line) return empty;
	const sox =
		line.sox_change_pct ??
		line.us_indexes?.find((i) => i.key === "sox")?.change_pct ??
		null;
	const ndx =
		line.nasdaq_change_pct ??
		line.us_indexes?.find((i) => i.key === "ndx")?.change_pct ??
		null;
	const fut = line.nikkei_futures_price ?? null;
	let tone: SectorBackdrop["tone"] = "unknown";
	if (sox !== null) {
		if (sox >= 1.5) tone = "risk-on";
		else if (sox <= -1.5) tone = "risk-off";
		else tone = "neutral";
	}
	return {
		sox_change_pct: round(sox),
		nasdaq_change_pct: round(ndx),
		nikkei_futures: fut,
		premarket_date: line.date ?? null,
		tone,
	};
}

// 1 銘柄の daily 行 (date 昇順/降順どちらでも吸収) から指標を計算 (相対強弱はまだ入れない)。
function buildRowBase(
	meta: WatchlistMeta,
	barsIn: DailyBar[],
): Omit<SectorRow, "rel_strength_pct"> {
	const role = meta.sector_role ?? null;
	if (!barsIn || barsIn.length === 0) {
		return {
			code: meta.code,
			name: meta.name,
			sector_role: role,
			last_date: null,
			change_pct: null,
			ret_5d_pct: null,
			vol_ratio: null,
			note: "日足データなし",
		};
	}
	// 日付昇順に揃える (入力が DESC でも吸収)。
	const bars = barsIn
		.slice()
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
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
		const v = avg(window.map((b) => b.volume ?? null));
		if (v && v > 0 && last.volume != null) volRatio = last.volume / v;
	}

	const note = bars.length < 6 ? `本数不足(${bars.length}本、概算)` : "";
	return {
		code: meta.code,
		name: meta.name,
		sector_role: role,
		last_date: last.date,
		change_pct: round(last.change_pct ?? null),
		ret_5d_pct: round(ret5d),
		vol_ratio: round(volRatio),
		note,
	};
}

// sector ごとに集計し、各銘柄の相対強弱 (個別 ret_5d - セクター平均) を付ける。
function buildSectorReport(
	sector: string,
	tickers: WatchlistMeta[],
	barsByCode: Record<string, DailyBar[]>,
	backdrop: SectorBackdrop,
): SectorReport {
	const bases = tickers.map((t) => buildRowBase(t, barsByCode[t.code] ?? []));
	const avgChange = avg(bases.map((b) => b.change_pct));
	const avgRet5d = avg(bases.map((b) => b.ret_5d_pct));
	const rows: SectorRow[] = bases.map((b) => ({
		...b,
		rel_strength_pct:
			b.ret_5d_pct !== null && avgRet5d !== null
				? round(b.ret_5d_pct - avgRet5d)
				: null,
	}));
	// 相対強弱の強い順 (上が relative-strong)。
	rows.sort(
		(a, b) =>
			(b.rel_strength_pct ?? -Infinity) - (a.rel_strength_pct ?? -Infinity),
	);
	return {
		sector,
		backdrop,
		avg_change_pct: round(avgChange),
		avg_ret_5d_pct: round(avgRet5d),
		rows,
	};
}

// watchlist メタ + premarket + 各銘柄 daily から SectorReport[] を組む入口。
// sector 未設定の銘柄は除外。sector ごとにグループ化して集計する。
export function buildSectors(
	meta: WatchlistMeta[],
	premarket: PremarketLine | null,
	barsByCode: Record<string, DailyBar[]>,
): SectorReport[] {
	const backdrop = loadBackdrop(premarket);
	const groups = new Map<string, WatchlistMeta[]>();
	for (const t of meta) {
		if (!t.sector) continue;
		if (!groups.has(t.sector)) groups.set(t.sector, []);
		groups.get(t.sector)?.push(t);
	}
	const reports: SectorReport[] = [];
	for (const [sector, tickers] of groups) {
		reports.push(buildSectorReport(sector, tickers, barsByCode, backdrop));
	}
	return reports;
}

// in-source tests (sector.ts の in-source test を移植 + 集計の振る舞い)。
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("round", () => {
		it("指定桁に丸め、null/非有限は null", () => {
			expect(round(1.23456, 2)).toBe(1.23);
			expect(round(null)).toBeNull();
			expect(round(Number.POSITIVE_INFINITY)).toBeNull();
		});
	});

	describe("avg", () => {
		it("null/非有限を除いて平均する", () => {
			expect(avg([1, 2, 3])).toBe(2);
			expect(avg([1, null, 3])).toBe(2);
			expect(avg([])).toBeNull();
		});
	});

	describe("loadBackdrop", () => {
		it("sox>=1.5 は risk-on / <=-1.5 は risk-off / その間は neutral", () => {
			expect(loadBackdrop({ sox_change_pct: 2 }).tone).toBe("risk-on");
			expect(loadBackdrop({ sox_change_pct: -2 }).tone).toBe("risk-off");
			expect(loadBackdrop({ sox_change_pct: 0.5 }).tone).toBe("neutral");
		});
		it("sox 無し (premarket なし) は unknown", () => {
			expect(loadBackdrop(null).tone).toBe("unknown");
			expect(loadBackdrop({}).tone).toBe("unknown");
		});
		it("us_indexes から sox/ndx をフォールバックで拾う", () => {
			const b = loadBackdrop({
				us_indexes: [
					{ key: "sox", label: "SOX", change_pct: 1.6 },
					{ key: "ndx", label: "NDX", change_pct: 0.4 },
				],
			});
			expect(b.tone).toBe("risk-on");
			expect(b.sox_change_pct).toBe(1.6);
			expect(b.nasdaq_change_pct).toBe(0.4);
		});
	});

	describe("buildSectors", () => {
		const meta: WatchlistMeta[] = [
			{ code: "A", name: "Alpha", sector: "semi", sector_role: "memory" },
			{ code: "B", name: "Beta", sector: "semi", sector_role: "tester" },
			{ code: "C", name: "Gamma", sector: null, sector_role: null },
		];
		// A: 6本で +20% (10→12), B: 6本で 横ばい (10→10)。
		const bars = (closes: number[], chg: number): DailyBar[] =>
			closes.map((c, i) => ({
				date: `2026-06-${String(i + 1).padStart(2, "0")}`,
				close: c,
				change_pct: i === closes.length - 1 ? chg : 0,
				volume: 1000,
			}));

		it("sector 未設定 (C) は除外され、相対強弱が付く", () => {
			const reports = buildSectors(
				meta,
				{ sox_change_pct: 0.2 },
				{
					A: bars([10, 10, 10, 10, 10, 12], 2),
					B: bars([10, 10, 10, 10, 10, 10], 0),
				},
			);
			expect(reports).toHaveLength(1);
			const r = reports[0];
			expect(r.sector).toBe("semi");
			expect(r.rows.map((x) => x.code).sort()).toEqual(["A", "B"]);
			// A のリターン(+20) > B(0)。相対強弱で A が上 (rows は強い順)。
			expect(r.rows[0].code).toBe("A");
			expect((r.rows[0].rel_strength_pct ?? 0) > 0).toBe(true);
			expect((r.rows[1].rel_strength_pct ?? 0) < 0).toBe(true);
		});

		it("daily 行なしの銘柄は note を付け null 値で出る", () => {
			const reports = buildSectors(
				meta,
				null,
				{ A: bars([10, 10, 10, 10, 10, 12], 2) }, // B は行なし
			);
			const b = reports[0].rows.find((x) => x.code === "B");
			expect(b?.last_date).toBeNull();
			expect(b?.note).toBe("日足データなし");
		});
	});
}
