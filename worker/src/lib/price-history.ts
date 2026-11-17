// judge-context 用: 約1年分の日足から組む中期の位置 (MA75 / 52週高値・安値)、TOPIX に対する
// 相対強弱、材料が出た日の超過リターン。いずれも daily (銘柄と TOPIX) からの決定論計算。
// rows はすべて date 降順 (新しい順)。

import { maDevPct } from "./indicators";

export interface Bar {
	date: string;
	high?: number | null;
	low?: number | null;
	close?: number | null;
}

function round1(x: number): number {
	return Math.round(x * 10) / 10;
}

function pct(to: number, from: number): number {
	return round1((to / from - 1) * 100);
}

function daysBefore(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() - days);
	return d.toISOString().slice(0, 10);
}

const closed = (rows: Bar[]) =>
	rows.filter((r): r is Bar & { close: number } => r.close != null);

// --- trend: MA75 と 52週高値・安値 -------------------------------------------
// 52週は最新足から暦日 365 日の窓。保存が 1 年に満たないときは full_year=false で窓の起点を示す。
export function buildTrend(rowsDesc: Bar[]): Record<string, unknown> {
	const rows = closed(rowsDesc);
	if (rows.length < 25) return { status: "insufficient", rows_n: rows.length };
	const cur = rows[0];
	const ma75 =
		rows.length >= 75
			? Math.round(
					(rows.slice(0, 75).reduce((a, r) => a + r.close, 0) / 75) * 100,
				) / 100
			: null;
	const start = daysBefore(cur.date, 365);
	const win = rows.filter((r) => r.date > start);
	let hi = win[0];
	let lo = win[0];
	for (const r of win) {
		if ((r.high ?? r.close) > (hi.high ?? hi.close)) hi = r;
		if ((r.low ?? r.close) < (lo.low ?? lo.close)) lo = r;
	}
	const high = hi.high ?? hi.close;
	const low = lo.low ?? lo.close;
	const oldest = win[win.length - 1].date;
	return {
		status: "ok",
		latest_date: cur.date,
		close: cur.close,
		ma75,
		ma75_dev_pct: maDevPct(cur.close, ma75),
		high_52w: high,
		high_52w_date: hi.date,
		low_52w: low,
		low_52w_date: lo.date,
		from_high_52w_pct: pct(cur.close, high),
		from_low_52w_pct: pct(cur.close, low),
		window_start: oldest,
		full_year: oldest <= daysBefore(cur.date, 358),
	};
}

// --- relative: TOPIX に対する 5/20/60 日の超過リターン --------------------------
const REL_WINDOWS = [5, 20, 60];

export function buildRelative(
	rowsDesc: Bar[],
	topixDesc: Bar[],
): Record<string, unknown> {
	const rows = closed(rowsDesc);
	const topix = new Map(closed(topixDesc).map((r) => [r.date, r.close]));
	// 両方に足がある最新日を起点にする (TOPIX の取得が遅れた日に新しい足だけで比べない)。
	const i0 = rows.findIndex((r) => topix.has(r.date));
	if (i0 < 0) return { status: "unavailable" };
	const cur = rows[i0];
	const t0 = topix.get(cur.date) as number;
	const returns = REL_WINDOWS.flatMap((n) => {
		const past = rows[i0 + n];
		const tp = past ? topix.get(past.date) : undefined;
		if (!past || tp == null) return [];
		const ret = pct(cur.close, past.close);
		const tret = pct(t0, tp);
		return [
			{
				days: n,
				ret_pct: ret,
				topix_ret_pct: tret,
				excess_pct: round1(ret - tret),
			},
		];
	});
	if (returns.length === 0) return { status: "insufficient" };
	return { status: "ok", latest_date: cur.date, returns };
}

// --- event_reactions: 材料が出た日の超過リターン --------------------------------
// 適時開示・公式 IR の発表日ごとに、発表日前営業日の終値を起点に「発表日を含む 2 営業日」
// (場中発表は当日、引け後発表は翌日に反応が出るので両方を含める) と「現在まで」の、
// TOPIX に対する超過リターンを出す。2 営業日目の足がまだ無ければ partial。
export interface MaterialEvent {
	date: string; // 発表日 YYYY-MM-DD
	title: string;
}

const EVENT_LOOKBACK_DAYS = 90;
const EVENT_MAX = 6;
// 超過リターンが出た材料のうち、渡す件数 (新しい順)。
const EVENT_SHOWN = 3;
// 株価材料になりにくい定型の開示・広報は除く。
const ROUTINE_RE =
	/取得状況|定款|統合報告書|ガバナンス|株主総会|招集|役員|人事|組織|払込完了|譲渡制限|株式報酬|株式ユニット|説明会|資料|訂正|出展|受賞|募集/;

export function buildEventReactions(
	events: MaterialEvent[],
	rowsDesc: Bar[],
	topixDesc: Bar[],
	today: string,
): Record<string, unknown> {
	const asc = closed(rowsDesc).slice().reverse();
	const topix = new Map(closed(topixDesc).map((r) => [r.date, r.close]));
	if (asc.length === 0) return { status: "unavailable" };
	const since = daysBefore(today, EVENT_LOOKBACK_DAYS);
	const byDate = new Map<string, string[]>();
	for (const e of events) {
		if (e.date < since || e.date > today || ROUTINE_RE.test(e.title)) continue;
		// 英文の重複リリースは和文と同じ材料なので落とす。
		if (!/[^\x20-\x7e]/.test(e.title)) continue;
		const titles = byDate.get(e.date) ?? [];
		if (!titles.includes(e.title)) titles.push(e.title);
		byDate.set(e.date, titles);
	}
	const dates = [...byDate.keys()].sort().reverse().slice(0, EVENT_MAX);
	if (dates.length === 0) return { status: "none" };

	const excess = (
		from: Bar & { close: number },
		to: Bar & { close: number },
	) => {
		const tf = topix.get(from.date);
		const tt = topix.get(to.date);
		if (tf == null || tt == null) return null;
		return round1(pct(to.close, from.close) - pct(tt, tf));
	};
	const latest = asc[asc.length - 1];
	const items = dates.map((date) => {
		const titles = (byDate.get(date) ?? [])
			.slice(0, 2)
			.map((t) => t.slice(0, 60));
		const after = asc.findIndex((r) => r.date >= date);
		const base = after > 0 ? asc[after - 1] : after < 0 ? latest : null;
		if (!base || after < 0) {
			return {
				date,
				titles,
				excess_2d_pct: null,
				excess_to_date_pct: null,
				partial: true,
			};
		}
		const end = asc[after + 1] ?? asc[after];
		return {
			date,
			titles,
			excess_2d_pct: excess(base, end),
			excess_to_date_pct: excess(base, latest),
			partial: asc[after + 1] === undefined,
		};
	});
	// 超過リターンが 1 つも出せない材料は判断材料にならないので渡さない。
	const shown = items
		.filter((i) => i.excess_2d_pct != null || i.excess_to_date_pct != null)
		.slice(0, EVENT_SHOWN);
	if (shown.length === 0) return { status: "none" };
	return { status: "ok", items: shown };
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	// 平日だけの日付列 (古い順) を作り、close を割り当てて降順で返す。
	const series = (start: string, closes: number[]): Bar[] => {
		const out: Bar[] = [];
		const d = new Date(`${start}T00:00:00Z`);
		for (const c of closes) {
			while (d.getUTCDay() === 0 || d.getUTCDay() === 6)
				d.setUTCDate(d.getUTCDate() + 1);
			out.push({
				date: d.toISOString().slice(0, 10),
				high: c + 1,
				low: c - 1,
				close: c,
			});
			d.setUTCDate(d.getUTCDate() + 1);
		}
		return out.reverse();
	};

	describe("buildTrend", () => {
		it("MA75 と 52週高値・安値からの距離", () => {
			const closes = Array.from({ length: 100 }, (_, i) => 100 + i); // 100..199
			const out = buildTrend(series("2026-06-01", closes));
			expect(out.status).toBe("ok");
			expect(out.ma75).toBe(162); // 125..199 の平均
			expect(out.high_52w).toBe(200);
			expect(out.low_52w).toBe(99);
			expect(out.from_high_52w_pct).toBe(-0.5);
			expect(out.full_year).toBe(false);
		});
		it("75 本未満は ma75 null、25 本未満は insufficient", () => {
			expect(
				buildTrend(series("2026-06-01", Array(30).fill(100))).ma75,
			).toBeNull();
			expect(buildTrend(series("2026-06-01", Array(10).fill(100))).status).toBe(
				"insufficient",
			);
		});
		it("365 日より古い足は 52 週の窓に入れない", () => {
			const closes = [500, ...Array(270).fill(100)]; // 最古だけ高い
			const out = buildTrend(series("2025-08-01", closes));
			expect(out.high_52w).toBe(101);
			expect(out.full_year).toBe(true);
		});
	});

	describe("buildRelative", () => {
		it("TOPIX との 5/20/60 日リターン差", () => {
			const stock = series(
				"2026-06-01",
				Array.from({ length: 70 }, (_, i) => 100 + i),
			);
			const topix = series("2026-06-01", Array(70).fill(1000));
			const out = buildRelative(stock, topix);
			expect(out.status).toBe("ok");
			const r5 = (out.returns as { days: number; excess_pct: number }[])[0];
			expect(r5).toEqual({
				days: 5,
				ret_pct: 3,
				topix_ret_pct: 0,
				excess_pct: 3,
			});
		});
		it("TOPIX が無ければ unavailable", () => {
			expect(buildRelative(series("2026-06-01", [1, 2, 3]), []).status).toBe(
				"unavailable",
			);
		});
	});

	describe("buildEventReactions", () => {
		// 2026-06-01(月) 起点。06-03(水) に発表 → 起点は 06-02 の終値、2 営業日目は 06-04。
		const stock = series("2026-06-01", [100, 100, 110, 121, 121]);
		const topix = series("2026-06-01", [1000, 1000, 1010, 1010, 1010]);
		it("発表日前営業日の終値から 2 営業日と現在までの超過リターン", () => {
			const out = buildEventReactions(
				[
					{ date: "2026-06-03", title: "業績予想の修正に関するお知らせ" },
					{ date: "2026-06-03", title: "Notice of Forecast Revision" },
					{ date: "2026-06-03", title: "自己株式の取得状況に関するお知らせ" },
				],
				stock,
				topix,
				"2026-06-05",
			);
			expect(out).toEqual({
				status: "ok",
				items: [
					{
						date: "2026-06-03",
						titles: ["業績予想の修正に関するお知らせ"],
						excess_2d_pct: 20,
						excess_to_date_pct: 20,
						partial: false,
					},
				],
			});
		});
		it("2 営業日目の足がまだ無ければ partial", () => {
			const out = buildEventReactions(
				[{ date: "2026-06-05", title: "新製品の発表" }],
				stock,
				topix,
				"2026-06-05",
			);
			const item = (
				out.items as { partial: boolean; excess_2d_pct: number }[]
			)[0];
			expect(item.partial).toBe(true);
			expect(item.excess_2d_pct).toBe(0);
		});
		it("該当なしは none", () => {
			expect(buildEventReactions([], stock, topix, "2026-06-05").status).toBe(
				"none",
			);
		});
		it("出展・受賞などの広報は除く", () => {
			expect(
				buildEventReactions(
					[
						{ date: "2026-06-03", title: "「SEMICON West」に出展" },
						{ date: "2026-06-03", title: "IR優良企業賞を受賞" },
					],
					stock,
					topix,
					"2026-06-05",
				).status,
			).toBe("none");
		});
		it("TOPIX が無く超過リターンが出せない材料は渡さない", () => {
			expect(
				buildEventReactions(
					[{ date: "2026-06-03", title: "業績予想の修正に関するお知らせ" }],
					stock,
					[],
					"2026-06-05",
				).status,
			).toBe("none");
		});
		it("超過リターンが出た材料を新しい順に 3 件まで", () => {
			const long = series(
				"2026-06-01",
				Array.from({ length: 10 }, (_, i) => 100 + i),
			);
			const longTopix = series(
				"2026-06-01",
				Array.from({ length: 10 }, () => 1000),
			);
			const out = buildEventReactions(
				["02", "03", "04", "05", "08"].map((d) => ({
					date: `2026-06-${d}`,
					title: "新製品の発表",
				})),
				long,
				longTopix,
				"2026-06-12",
			);
			expect((out.items as { date: string }[]).map((i) => i.date)).toEqual([
				"2026-06-08",
				"2026-06-05",
				"2026-06-04",
			]);
		});
	});
}
