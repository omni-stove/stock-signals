// sq-brief 用: 日足から過去の日本SQ週の値動きと SQ連動度、今週の途中経過を決定論で組む。
//
// 1 回の SQ について見る値 (SQ日は暦上の第2金曜を、その週で実在する最後の足に解決する):
//   - pre_ret   : 前週末の終値 → SQ前日の終値 (SQ週の月〜SQ前日の建玉調整)
//   - week_ret  : 前週末の終値 → SQ日の終値
//   - sq_gap    : SQ前日の終値 → SQ日の始値 (SQ値は寄りで決まる)
//   - sq_vol_x  : SQ日の出来高 / SQ週前 20 日の平均出来高
//   - post_ret  : SQ日の終値 → 翌週 (SQ明け) 最終日の終値。翌週が終わっていなければ null
//   - sq_day_share : SQ週の月〜SQ日の日次値幅 (終値の前日比の絶対値) の合計のうち SQ日が占める割合
//   - pre_day_abs  : 月〜SQ前日の日次値幅の平均
// 銘柄は同じ SQ の TOPIX の値を引いた超過分も持つ。
// SQ連動度は SQ のときの振れを平常時 (SQ週以外) の振れで割った倍率 (1 = SQ でも平常どおり)。
// SQ日の寄りギャップと SQ日の割合は、曜日の癖 (週末をまたぐ金曜の寄り等) を除くため平常週の同じ曜日と比べる。
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
	sq_day_share: number | null;
	pre_day_abs_pct: number | null;
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

function weekdayOf(date: string): number {
	return new Date(`${date}T12:00:00Z`).getUTCDay();
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

	// 月〜SQ日の日次値幅 (前週末からの各日の終値の前日比の絶対値)。
	const dayAbs = bars
		.slice(wk, k + 1)
		.map((b, i) => Math.abs((b.close / bars[wk + i - 1].close - 1) * 100));
	const weekAbsSum = dayAbs.reduce((a, b) => a + b, 0);
	const preAbs = mean(dayAbs.slice(0, -1));

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
		sq_day_share:
			weekAbsSum > 0 ? round2(dayAbs[dayAbs.length - 1] / weekAbsSum) : null,
		pre_day_abs_pct: preAbs == null ? null : round2(preAbs),
	};
}

// SQ週以外の平常時の振れ。gap_by_wd / share_by_wd は曜日 (0=日..6=土) ごと。
interface Baseline {
	gap_by_wd: Map<number, number>;
	share_by_wd: Map<number, number>;
	day_abs: number | null;
	week_abs: number | null;
}

function meanBy(groups: Map<number, number[]>): Map<number, number> {
	const out = new Map<number, number>();
	for (const [k, v] of groups) out.set(k, mean(v) as number);
	return out;
}

function push(groups: Map<number, number[]>, k: number, v: number): void {
	const g = groups.get(k);
	if (g) g.push(v);
	else groups.set(k, [v]);
}

function baseline(bars: Bar[], sqWeeks: Set<string>): Baseline {
	const gaps = new Map<number, number[]>();
	const dayAbs: number[] = [];
	// 週ごとの日次値幅 (曜日付き)。週の最初の足が前週末の終値を持てる週だけ。
	const weekDays = new Map<string, { wd: number; abs: number }[]>();
	for (let i = 1; i < bars.length; i++) {
		const b = bars[i];
		const monday = mondayOf(b.date);
		if (sqWeeks.has(monday)) continue;
		const wd = weekdayOf(b.date);
		if (b.open != null)
			push(gaps, wd, Math.abs((b.open / bars[i - 1].close - 1) * 100));
		const abs = Math.abs((b.close / bars[i - 1].close - 1) * 100);
		dayAbs.push(abs);
		const w = weekDays.get(monday);
		if (w) w.push({ wd, abs });
		else weekDays.set(monday, [{ wd, abs }]);
	}
	// 週の中で各曜日が占める割合。最初と最後の週は欠けている可能性があるので外す。
	const shares = new Map<number, number[]>();
	const weeks = [...weekDays.values()].slice(1, -1);
	for (const days of weeks) {
		const sum = days.reduce((a, d) => a + d.abs, 0);
		if (sum <= 0) continue;
		// SQ日は月〜SQ日で割るので、平常週も月〜その曜日までの合計で割る。
		let acc = 0;
		for (const d of days) {
			acc += d.abs;
			if (acc > 0) push(shares, d.wd, d.abs / acc);
		}
	}
	// 週の最終足の終値を並べ、前週比の絶対値を取る。
	const weekEnd = new Map<string, number>();
	for (const b of bars) weekEnd.set(mondayOf(b.date), b.close);
	const ends = [...weekEnd.entries()];
	const weekRets: number[] = [];
	for (let i = 1; i < ends.length; i++) {
		if (sqWeeks.has(ends[i][0])) continue;
		weekRets.push(Math.abs((ends[i][1] / ends[i - 1][1] - 1) * 100));
	}
	weekRets.pop();
	return {
		gap_by_wd: meanBy(gaps),
		share_by_wd: meanBy(shares),
		day_abs: mean(dayAbs),
		week_abs: mean(weekRets),
	};
}

// 各 SQ の解決後の曜日に合わせた平常値の平均 (祝日で前倒しになった回は木曜と比べる)。
function sameWeekdayBase(
	events: SqEvent[],
	byWd: Map<number, number>,
): number | null {
	const v = events
		.map((e) => byWd.get(weekdayOf(e.date)))
		.filter((x): x is number => x != null);
	return v.length === events.length ? mean(v) : null;
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

	const base = baseline(bars, new Set(events.map((e) => mondayOf(e.date))));
	const gapEvents = events.filter((e) => e.sq_gap_pct != null);
	const gapAbs = mean(gapEvents.map((e) => Math.abs(e.sq_gap_pct as number)));
	const shareEvents = events.filter((e) => e.sq_day_share != null);
	const share = mean(shareEvents.map((e) => e.sq_day_share as number));
	const normalShare = sameWeekdayBase(shareEvents, base.share_by_wd);
	const preAbs = mean(
		events.map((e) => e.pre_day_abs_pct).filter((x): x is number => x != null),
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
			sq_gap_abs_x: ratio(gapAbs, sameWeekdayBase(gapEvents, base.gap_by_wd)),
			sq_day_share: share == null ? null : round2(share),
			normal_day_share: normalShare == null ? null : round2(normalShare),
			pre_day_abs_x: ratio(preAbs, base.day_abs),
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
				sq_day_share: 0.33,
				pre_day_abs_pct: 0.5,
			});
			// before より後の SQ (07-10) は入れない。
			expect((out.events as SqEvent[]).length).toBe(1);
			expect((out.sensitivity as { reversal_rate: number }).reversal_rate).toBe(
				1,
			);
		});
		it("寄りギャップと SQ日の割合は平常週の同じ曜日と比べる", () => {
			// 毎週金曜は 2% 高く寄って +1% で引け、月曜に戻す (SQ週も平常週も同じ)。
			const rows = series(dates, (date) => {
				const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
				return wd === 5 ? { open: 102, close: 101 } : {};
			});
			const s = buildSqHistory(rows, "2026-07-06").sensitivity as Record<
				string,
				number
			>;
			expect(s.sq_gap_abs_x).toBe(1);
			expect(s.sq_day_share).toBe(s.normal_day_share);
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
