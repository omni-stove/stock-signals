// sq-brief 用: 日足から過去の日本SQ週の値動きと SQ連動度、今週の途中経過を決定論で組む。
//
// 1 回の SQ について見る値 (SQ日は暦上の第2金曜を、その週で実在する最後の足に解決する):
//   - pre_ret   : 前週末の終値 → SQ前日の終値 (SQ週の月〜SQ前日の建玉調整)
//   - week_ret  : 前週末の終値 → SQ日の終値
//   - sq_gap    : SQ前日の終値 → SQ日の始値 (SQ値は寄りで決まる)
//   - sq_vol_x  : SQ日の出来高 / SQ週前 20 日の平均出来高
//   - post_ret  : SQ日の終値 → 翌週 (SQ明け) 最終日の終値。翌週が終わっていなければ null
// 銘柄は同じ SQ の TOPIX の値を引いた超過分も持つ。
// SQ連動度は SQ のときの振れを平常時の振れで割った倍率 (1 = SQ でも平常どおり)。
// rows はすべて date 降順 (新しい順) で受け取る。

import { addDaysYmd, type JpSq, jpSqDates } from "./event-context";

export interface SqBar {
	date: string;
	open?: number | null;
	close?: number | null;
	volume?: number | null;
}

type Bar = SqBar & { close: number };

export interface SqEvent {
	sq_date: string;
	date: string;
	major: boolean;
	pre_ret_pct: number | null;
	week_ret_pct: number;
	sq_gap_pct: number | null;
	sq_vol_x: number | null;
	post_ret_pct: number | null;
}

const VOL_WINDOW = 20;

function round2(x: number): number {
	return Math.round(x * 100) / 100;
}

function retPct(to: number, from: number): number {
	return round2((to / from - 1) * 100);
}

function mean(xs: number[]): number | null {
	return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function median(xs: number[]): number | null {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mondayOf(date: string): string {
	const dow = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
	return addDaysYmd(date, -(dow - 1));
}

const ascClosed = (rowsDesc: SqBar[]): Bar[] =>
	rowsDesc.filter((r): r is Bar => r.close != null).reverse();

// 暦上の SQ を実在する足に解決し、その SQ の値を組む。前週末の足が無い SQ は出さない。
function buildEvent(bars: Bar[], sq: JpSq): SqEvent | null {
	const monday = mondayOf(sq.date);
	let k = -1;
	for (let i = 0; i < bars.length; i++) {
		if (bars[i].date > sq.date) break;
		if (bars[i].date >= monday) k = i;
	}
	if (k < 0) return null;
	const wk = bars.findIndex((b) => b.date >= monday);
	const p = wk - 1;
	if (p < 0) return null;
	const prevClose = bars[p].close;
	const sqBar = bars[k];
	const dayBefore = bars[k - 1];

	const volBase = bars
		.slice(Math.max(0, p - VOL_WINDOW + 1), p + 1)
		.map((b) => b.volume)
		.filter((v): v is number => v != null && v > 0);
	const avgVol = volBase.length === VOL_WINDOW ? mean(volBase) : null;

	const nextMonday = addDaysYmd(monday, 7);
	const nextFriday = addDaysYmd(monday, 11);
	const nextWeek = bars.filter(
		(b) => b.date >= nextMonday && b.date <= nextFriday,
	);
	const nextWeekDone = bars.some((b) => b.date > nextFriday);
	const postEnd = nextWeekDone ? nextWeek[nextWeek.length - 1] : undefined;

	return {
		sq_date: sq.date,
		date: sqBar.date,
		major: sq.major,
		pre_ret_pct: k > wk ? retPct(dayBefore.close, prevClose) : null,
		week_ret_pct: retPct(sqBar.close, prevClose),
		sq_gap_pct: sqBar.open != null ? retPct(sqBar.open, dayBefore.close) : null,
		sq_vol_x:
			avgVol && sqBar.volume != null ? round2(sqBar.volume / avgVol) : null,
		post_ret_pct: postEnd ? retPct(postEnd.close, sqBar.close) : null,
	};
}

// SQ日以外の寄りのギャップ絶対値の平均と、SQ週以外の週次リターン絶対値の平均。
function baseline(
	bars: Bar[],
	sqDays: Set<string>,
	sqWeeks: Set<string>,
): { gap_abs: number | null; week_abs: number | null } {
	const gaps: number[] = [];
	for (let i = 1; i < bars.length; i++) {
		const o = bars[i].open;
		if (o == null || sqDays.has(bars[i].date)) continue;
		gaps.push(Math.abs((o / bars[i - 1].close - 1) * 100));
	}
	// 週の最終足の終値を並べ、前週比の絶対値を取る。
	const weekEnd = new Map<string, number>();
	for (const b of bars) weekEnd.set(mondayOf(b.date), b.close);
	const weeks = [...weekEnd.entries()];
	const weekRets: number[] = [];
	for (let i = 1; i < weeks.length; i++) {
		if (sqWeeks.has(weeks[i][0])) continue;
		weekRets.push(Math.abs((weeks[i][1] / weeks[i - 1][1] - 1) * 100));
	}
	// 最初と最後の週は欠けている可能性があるので外す。
	weekRets.pop();
	return { gap_abs: mean(gaps), week_abs: mean(weekRets) };
}

function stat(xs: (number | null)[]): Record<string, number | null> {
	const v = xs.filter((x): x is number => x != null);
	const m = mean(v);
	const md = median(v);
	return {
		n: v.length,
		mean: m == null ? null : round2(m),
		median: md == null ? null : round2(md),
		up_ratio: v.length
			? round2(v.filter((x) => x > 0).length / v.length)
			: null,
	};
}

// 週の値動きと翌週の値動きの符号が逆だった割合 (SQ週の歪みが明けに剥落したか)。
function reversalRate(events: SqEvent[]): number | null {
	const pairs = events.filter(
		(e) =>
			e.post_ret_pct != null && e.week_ret_pct !== 0 && e.post_ret_pct !== 0,
	);
	if (!pairs.length) return null;
	const rev = pairs.filter(
		(e) => Math.sign(e.week_ret_pct) !== Math.sign(e.post_ret_pct as number),
	).length;
	return round2(rev / pairs.length);
}

function ratio(a: number | null, b: number | null): number | null {
	return a != null && b != null && b > 0 ? round2(a / b) : null;
}

// 超過分 (銘柄 - TOPIX) を同じ SQ 同士で引く。
function excess(
	events: SqEvent[],
	bench: SqEvent[] | null,
	key: "week_ret_pct" | "post_ret_pct" | "sq_gap_pct",
): (number | null)[] {
	if (!bench) return [];
	const byDate = new Map(bench.map((e) => [e.sq_date, e]));
	return events.map((e) => {
		const b = byDate.get(e.sq_date);
		const x = e[key];
		const y = b?.[key];
		return x != null && y != null ? round2(x - y) : null;
	});
}

function summarize(
	events: SqEvent[],
	bench: SqEvent[] | null,
): Record<string, unknown> {
	return {
		n: events.length,
		pre_ret: stat(events.map((e) => e.pre_ret_pct)),
		week_ret: stat(events.map((e) => e.week_ret_pct)),
		sq_gap: stat(events.map((e) => e.sq_gap_pct)),
		post_ret: stat(events.map((e) => e.post_ret_pct)),
		reversal_rate: reversalRate(events),
		...(bench
			? {
					week_excess: stat(excess(events, bench, "week_ret_pct")),
					sq_gap_excess: stat(excess(events, bench, "sq_gap_pct")),
					post_excess: stat(excess(events, bench, "post_ret_pct")),
				}
			: {}),
	};
}

// 過去の SQ週 (before より前に SQ日がある回) の値動きと SQ連動度を組む。
export function buildSqHistory(
	rowsDesc: SqBar[],
	before: string,
	benchDesc?: SqBar[],
): Record<string, unknown> & { events?: SqEvent[] } {
	const bars = ascClosed(rowsDesc);
	if (bars.length < VOL_WINDOW + 5)
		return { status: "insufficient", rows_n: bars.length };
	const sqs = jpSqDates(bars[0].date, addDaysYmd(before, -1));
	const events = sqs
		.map((sq) => buildEvent(bars, sq))
		.filter((e): e is SqEvent => e != null);
	if (!events.length) return { status: "insufficient", rows_n: bars.length };

	const benchBars = benchDesc ? ascClosed(benchDesc) : [];
	const bench =
		benchBars.length > 0
			? sqs
					.map((sq) => buildEvent(benchBars, sq))
					.filter((e): e is SqEvent => e != null)
			: null;

	const base = baseline(
		bars,
		new Set(events.map((e) => e.date)),
		new Set(events.map((e) => mondayOf(e.date))),
	);
	const gapAbs = mean(
		events
			.map((e) => e.sq_gap_pct)
			.filter((x) => x != null)
			.map(Math.abs),
	);
	const weekAbs = mean(events.map((e) => Math.abs(e.week_ret_pct)));
	const volX = mean(
		events.map((e) => e.sq_vol_x).filter((x): x is number => x != null),
	);
	const majors = events.filter((e) => e.major);

	return {
		status: "ok",
		window_start: bars[0].date,
		events,
		all: summarize(events, bench),
		major: majors.length ? summarize(majors, bench) : { n: 0 },
		sensitivity: {
			sq_gap_abs_x: ratio(gapAbs, base.gap_abs),
			sq_week_abs_x: ratio(weekAbs, base.week_abs),
			sq_vol_x: volX == null ? null : round2(volX),
			reversal_rate: reversalRate(events),
		},
	};
}

// NT倍率 (日経225 ÷ TOPIX) の最新値・前週末の値・20 日平均。SQ前後に日経225 側だけが買われて/売られて
// いるかを見る。両方に足がある日だけで組む。
export function buildNtRatio(
	nikkeiDesc: SqBar[],
	topixDesc: SqBar[],
	weekStart: string,
): Record<string, unknown> {
	const topix = new Map(ascClosed(topixDesc).map((b) => [b.date, b.close]));
	const nt = ascClosed(nikkeiDesc)
		.filter((b) => topix.has(b.date))
		.map((b) => ({
			date: b.date,
			nt: b.close / (topix.get(b.date) as number),
		}));
	if (nt.length < VOL_WINDOW)
		return { status: "insufficient", rows_n: nt.length };
	const last = nt[nt.length - 1];
	const prev = [...nt].reverse().find((r) => r.date < weekStart);
	const avg = mean(nt.slice(-VOL_WINDOW).map((r) => r.nt)) as number;
	return {
		status: "ok",
		latest_date: last.date,
		nt: round2(last.nt),
		prev_week_end: prev ? round2(prev.nt) : null,
		avg_20d: round2(avg),
	};
}

// 今週 (weekStart 以降) の途中経過: 前週末の終値からのリターンと TOPIX 比。
export function buildSqWeekToDate(
	rowsDesc: SqBar[],
	weekStart: string,
	benchDesc?: SqBar[],
): Record<string, unknown> {
	const wtd = (rows: SqBar[]) => {
		const bars = ascClosed(rows);
		const wk = bars.findIndex((b) => b.date >= weekStart);
		const p = wk < 0 ? bars.length - 1 : wk - 1;
		if (p < 0) return null;
		const last = bars[bars.length - 1];
		return {
			days: wk < 0 ? 0 : bars.length - wk,
			latest_date: last.date,
			ret_pct: retPct(last.close, bars[p].close),
		};
	};
	const own = wtd(rowsDesc);
	if (!own) return { status: "unavailable" };
	const bench = benchDesc ? wtd(benchDesc) : null;
	return {
		status: "ok",
		...own,
		...(bench && bench.latest_date === own.latest_date
			? { excess_pct: round2(own.ret_pct - bench.ret_pct) }
			: {}),
	};
}

// in-source tests。
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	// 平日だけの日足 (古い順に値を与え、降順で返す)。
	const weekdays = (from: string, n: number): string[] => {
		const out: string[] = [];
		let cur = from;
		while (out.length < n) {
			const dow = new Date(`${cur}T12:00:00Z`).getUTCDay();
			if (dow !== 0 && dow !== 6) out.push(cur);
			cur = addDaysYmd(cur, 1);
		}
		return out;
	};
	const series = (
		dates: string[],
		f: (date: string, i: number) => Partial<SqBar>,
	): SqBar[] =>
		dates
			.map((date, i) => ({
				date,
				open: 100,
				close: 100,
				volume: 1000,
				...f(date, i),
			}))
			.reverse();

	// 2026-05-04 (月) から 2026-07-31 まで。SQ = 06-12, 07-10。
	const dates = weekdays("2026-05-04", 65);

	describe("buildSqHistory", () => {
		it("SQ日の寄りギャップ・出来高倍率・週と翌週のリターン", () => {
			const rows = series(dates, (date) => {
				if (date === "2026-06-11") return { close: 102 };
				if (date === "2026-06-12")
					return { open: 104, close: 103, volume: 3000 };
				if (date >= "2026-06-15" && date <= "2026-06-19") return { close: 101 };
				return {};
			});
			const out = buildSqHistory(rows, "2026-07-06");
			expect(out.status).toBe("ok");
			const e = (out.events as SqEvent[])[0];
			expect(e).toEqual({
				sq_date: "2026-06-12",
				date: "2026-06-12",
				major: true,
				pre_ret_pct: 2,
				week_ret_pct: 3,
				sq_gap_pct: 1.96,
				sq_vol_x: 3,
				post_ret_pct: -1.94,
			});
			// before より後の SQ (07-10) は入れない。
			expect((out.events as SqEvent[]).length).toBe(1);
			expect((out.sensitivity as { reversal_rate: number }).reversal_rate).toBe(
				1,
			);
		});
		it("祝日で SQ が前倒しなら週内の最後の足に解決する", () => {
			const rows = series(
				dates.filter((d) => d !== "2026-06-12"),
				() => ({}),
			);
			const e = (buildSqHistory(rows, "2026-07-06").events as SqEvent[])[0];
			expect(e.date).toBe("2026-06-11");
		});
		it("翌週が終わっていなければ post は null", () => {
			const rows = series(
				dates.filter((d) => d <= "2026-06-17"),
				() => ({}),
			);
			const e = (buildSqHistory(rows, "2026-07-06").events as SqEvent[])[0];
			expect(e.post_ret_pct).toBeNull();
		});
		it("TOPIX を渡すと同じ SQ の超過分を出す", () => {
			const rows = series(dates, (date) =>
				date === "2026-06-12" ? { close: 103 } : {},
			);
			const topix = series(dates, (date) =>
				date === "2026-06-12" ? { close: 101 } : {},
			);
			const out = buildSqHistory(rows, "2026-07-06", topix);
			const all = out.all as { week_excess: { mean: number } };
			expect(all.week_excess.mean).toBe(2);
		});
		it("足が少なければ insufficient", () => {
			expect(
				buildSqHistory(
					series(dates.slice(0, 10), () => ({})),
					"2026-07-06",
				).status,
			).toBe("insufficient");
		});
	});

	describe("buildNtRatio", () => {
		it("最新値・前週末・20 日平均", () => {
			const d = dates.filter((x) => x <= "2026-06-10");
			const n225 = series(d, (date) =>
				date === "2026-06-10" ? { close: 1600 } : { close: 1500 },
			);
			const topix = series(d, () => ({ close: 100 }));
			expect(buildNtRatio(n225, topix, "2026-06-08")).toEqual({
				status: "ok",
				latest_date: "2026-06-10",
				nt: 16,
				prev_week_end: 15,
				avg_20d: 15.05,
			});
		});
		it("足が少なければ insufficient", () => {
			const d = dates.slice(0, 5);
			expect(
				buildNtRatio(
					series(d, () => ({})),
					series(d, () => ({})),
					"2026-05-11",
				).status,
			).toBe("insufficient");
		});
	});

	describe("buildSqWeekToDate", () => {
		it("前週末の終値からのリターンと TOPIX 比", () => {
			const d = dates.filter((x) => x <= "2026-06-10");
			const rows = series(d, (date) =>
				date === "2026-06-10" ? { close: 105 } : {},
			);
			const topix = series(d, (date) =>
				date === "2026-06-10" ? { close: 102 } : {},
			);
			expect(buildSqWeekToDate(rows, "2026-06-08", topix)).toEqual({
				status: "ok",
				days: 3,
				latest_date: "2026-06-10",
				ret_pct: 5,
				excess_pct: 3,
			});
		});
		it("週の足がまだ無ければ days=0・ret=0", () => {
			const d = dates.filter((x) => x <= "2026-06-05");
			expect(
				buildSqWeekToDate(
					series(d, () => ({})),
					"2026-06-08",
				),
			).toEqual({
				status: "ok",
				days: 0,
				latest_date: "2026-06-05",
				ret_pct: 0,
			});
		});
	});
}
