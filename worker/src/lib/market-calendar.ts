// Cloudflare Worker: 東証と NYSE の休場日カレンダー (日付は YYYY-MM-DD)。
//
// 東証: 土日・国民の祝日 (振替休日・国民の休日を含む)・年末年始 (12/31〜1/3)。春分・秋分は
// 天文計算の近似式 (1980〜2099 年で有効)。臨時の休場は扱わない。
// NYSE: 土日と NYSE の定休日 (New Year's Day / MLK / Presidents / Good Friday / Memorial /
// Juneteenth / Independence / Labor / Thanksgiving / Christmas、土曜は前日・日曜は翌日に振替。
// 元日が土曜のときは振替しない)。

import { addDays } from "./utils";

function parts(date: string): { y: number; m: number; d: number; dow: number } {
	const t = new Date(`${date}T12:00:00Z`);
	return {
		y: t.getUTCFullYear(),
		m: t.getUTCMonth() + 1,
		d: t.getUTCDate(),
		dow: t.getUTCDay(),
	};
}

function ymd(y: number, m: number, d: number): string {
	return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function isWeekend(date: string): boolean {
	const { dow } = parts(date);
	return dow === 0 || dow === 6;
}

// y 年 m 月の第 n weekday (0=日..6=土)。n = -1 は最終。
function nthWeekday(y: number, m: number, weekday: number, n: number): string {
	if (n > 0) {
		const first = parts(ymd(y, m, 1)).dow;
		return ymd(y, m, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
	}
	const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
	const last = parts(ymd(y, m, lastDay)).dow;
	return ymd(y, m, lastDay - ((last - weekday + 7) % 7));
}

// ── 東証 ─────────────────────────────────────────────────────────────────────

function equinoxDay(y: number, base: number): number {
	return Math.floor(base + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
}

// 振替休日・国民の休日を除いた、その年の国民の祝日。
function baseJpHolidays(y: number): Set<string> {
	return new Set([
		ymd(y, 1, 1),
		nthWeekday(y, 1, 1, 2), // 成人の日
		ymd(y, 2, 11),
		ymd(y, 2, 23),
		ymd(y, 3, equinoxDay(y, 20.8431)), // 春分の日
		ymd(y, 4, 29),
		ymd(y, 5, 3),
		ymd(y, 5, 4),
		ymd(y, 5, 5),
		nthWeekday(y, 7, 1, 3), // 海の日
		ymd(y, 8, 11),
		nthWeekday(y, 9, 1, 3), // 敬老の日
		ymd(y, 9, equinoxDay(y, 23.2488)), // 秋分の日
		nthWeekday(y, 10, 1, 2), // スポーツの日
		ymd(y, 11, 3),
		ymd(y, 11, 23),
	]);
}

const jpHolidayCache = new Map<number, Set<string>>();

function jpHolidays(y: number): Set<string> {
	const hit = jpHolidayCache.get(y);
	if (hit) return hit;
	const base = baseJpHolidays(y);
	const all = new Set(base);
	for (const h of base) {
		if (parts(h).dow !== 0) continue;
		let d = addDays(h, 1);
		while (all.has(d)) d = addDays(d, 1);
		all.add(d); // 振替休日
	}
	for (const h of base) {
		const mid = addDays(h, 1);
		if (base.has(addDays(h, 2)) && !all.has(mid) && parts(mid).dow !== 0)
			all.add(mid); // 国民の休日
	}
	jpHolidayCache.set(y, all);
	return all;
}

function isTseHoliday(date: string): boolean {
	const { y, m, d } = parts(date);
	if ((m === 12 && d === 31) || (m === 1 && d <= 3)) return true;
	return isWeekend(date) || jpHolidays(y).has(date);
}

// date 以前で最も近い東証の営業日。
export function latestTseBusinessDay(date: string): string {
	let d = date;
	while (isTseHoliday(d)) d = addDays(d, -1);
	return d;
}

// from の翌日から to までの東証の営業日数。from >= to なら 0。
export function tseBusinessDaysBetween(from: string, to: string): number {
	let n = 0;
	for (let d = addDays(from, 1); d <= to; d = addDays(d, 1))
		if (!isTseHoliday(d)) n++;
	return n;
}

// ── NYSE ─────────────────────────────────────────────────────────────────────

// グレゴリオ暦の復活祭 (Anonymous Gregorian algorithm)。
function easter(y: number): string {
	const a = y % 19;
	const b = Math.floor(y / 100);
	const c = y % 100;
	const d = Math.floor(b / 4);
	const e = b % 4;
	const f = Math.floor((b + 8) / 25);
	const g = Math.floor((b - f + 1) / 3);
	const h = (19 * a + b - d - g + 15) % 30;
	const i = Math.floor(c / 4);
	const k = c % 4;
	const l = (32 + 2 * e + 2 * i - h - k) % 7;
	const m = Math.floor((a + 11 * h + 22 * l) / 451);
	const month = Math.floor((h + l - 7 * m + 114) / 31);
	const day = ((h + l - 7 * m + 114) % 31) + 1;
	return ymd(y, month, day);
}

// 土曜は前日、日曜は翌日に振り替える。
function observed(date: string): string {
	const { dow } = parts(date);
	return dow === 6 ? addDays(date, -1) : dow === 0 ? addDays(date, 1) : date;
}

const nyseHolidayCache = new Map<number, Set<string>>();

function nyseHolidays(y: number): Set<string> {
	const hit = nyseHolidayCache.get(y);
	if (hit) return hit;
	const newYear = ymd(y, 1, 1);
	const set = new Set([
		...(parts(newYear).dow === 6 ? [] : [observed(newYear)]),
		nthWeekday(y, 1, 1, 3), // MLK
		nthWeekday(y, 2, 1, 3), // Presidents
		addDays(easter(y), -2), // Good Friday
		nthWeekday(y, 5, 1, -1), // Memorial
		observed(ymd(y, 6, 19)), // Juneteenth
		observed(ymd(y, 7, 4)),
		nthWeekday(y, 9, 1, 1), // Labor
		nthWeekday(y, 11, 4, 4), // Thanksgiving
		observed(ymd(y, 12, 25)),
	]);
	nyseHolidayCache.set(y, set);
	return set;
}

function isNyseHoliday(date: string): boolean {
	return isWeekend(date) || nyseHolidays(parts(date).y).has(date);
}

// date より前で最も近い NYSE の取引日。
export function prevNyseSession(date: string): string {
	let d = addDays(date, -1);
	while (isNyseHoliday(d)) d = addDays(d, -1);
	return d;
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("isTseHoliday", () => {
		it("祝日・振替休日・国民の休日・年末年始を休場にする", () => {
			for (const d of [
				"2026-01-02", // 年始
				"2026-01-12", // 成人の日
				"2026-03-20", // 春分の日
				"2026-05-06", // 憲法記念日 (日) の振替
				"2026-09-21", // 敬老の日
				"2026-09-22", // 国民の休日
				"2026-09-23", // 秋分の日
				"2026-11-03",
				"2026-11-23",
				"2026-12-31",
				"2027-03-22", // 春分の日 (日) の振替
			])
				expect(isTseHoliday(d), d).toBe(true);
		});
		it("平日の営業日は開場", () => {
			for (const d of ["2026-01-05", "2026-05-07", "2026-11-13", "2026-12-30"])
				expect(isTseHoliday(d), d).toBe(false);
		});
	});

	describe("tseBusinessDaysBetween / latestTseBusinessDay", () => {
		it("年末年始・GW の休場を数えない", () => {
			expect(tseBusinessDaysBetween("2026-12-30", "2027-01-04")).toBe(1);
			expect(tseBusinessDaysBetween("2026-05-01", "2026-05-07")).toBe(1);
			expect(tseBusinessDaysBetween("2026-11-12", "2026-11-13")).toBe(1);
			expect(tseBusinessDaysBetween("2026-11-13", "2026-11-13")).toBe(0);
		});
		it("休場日は直前の営業日に戻す", () => {
			expect(latestTseBusinessDay("2027-01-01")).toBe("2026-12-30");
			expect(latestTseBusinessDay("2026-11-23")).toBe("2026-11-20");
			expect(latestTseBusinessDay("2026-11-13")).toBe("2026-11-13");
		});
	});

	describe("isNyseHoliday / prevNyseSession", () => {
		it("NYSE の定休日と振替", () => {
			for (const d of [
				"2026-01-19", // MLK
				"2026-04-03", // Good Friday
				"2026-05-25", // Memorial
				"2026-06-19",
				"2026-07-03", // 7/4 (土) の振替
				"2026-11-26", // Thanksgiving
				"2026-12-25",
			])
				expect(isNyseHoliday(d), d).toBe(true);
			expect(isNyseHoliday("2027-12-31")).toBe(false); // 2028 元日 (土) は振替しない
		});
		it("祝日をまたいで直前の取引日を返す", () => {
			expect(prevNyseSession("2026-11-27")).toBe("2026-11-25");
			expect(prevNyseSession("2026-11-16")).toBe("2026-11-13");
			expect(prevNyseSession("2026-11-13")).toBe("2026-11-12");
		});
	});
}
