// Cloudflare Worker: 重要イベントの事前リマインダー。
//
// 寄り前 intake (JST 8:30) に相乗りし、当日・1日前・3日前 (LEAD_DAYS) に当たるイベントだけを
// Slack に1本流す。judge 向けの event-context (窓で語る) とは別物で、こちらは人間向けの予告。
// LLM 不使用・日付計算と D1 読みだけで決まる。該当がない朝は何も出さない (毎朝連投しない)。
//
// 対象イベント:
//   - watchlist 銘柄の次回決算 (D1 earnings.next_date)
//   - FOMC/日銀 (D1 macro_events。日本市場に効く日 = jst_effect_date || date)
//   - 海外SOX系ピア決算 (D1 macro_events kind=peer_earnings:*。同じく波及日)
//   - 日本SQ/米メジャーSQ/指数リバランス (event-context の日付計算)
//
// リマインド日が JST 土日に当たる回は cron 自体がスキップされるが、3点 (3日前/1日前/当日) の
// うち少なくとも1点は平日に当たるので取り零しはない。

import { db } from "./db";
import type { Env } from "./env";
import {
	daysDiff,
	type MacroEventRow,
	upcomingCalendarEvents,
} from "./event-context";
import { earnings, macroEvents } from "./schema";
import { notifyEventReminder, type ReminderNotifyItem } from "./slack";
import { WATCHLIST_NAMES } from "./watchlist";

// リマインドを出す日 (イベント日までの暦日数)。当日・前日・3日前の朝。
const LEAD_DAYS = [0, 1, 3];

// today と D1 の行からリマインド対象を組み立てる純粋関数。daysUntil 昇順で返す。
function buildEventReminders(
	today: string,
	macroRows: MacroEventRow[],
	earningsRows: { ticker: string; next_date: string | null }[],
): ReminderNotifyItem[] {
	const out: ReminderNotifyItem[] = [];
	const add = (date: string | null | undefined, label: string) => {
		if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
		const daysUntil = daysDiff(today, date);
		if (LEAD_DAYS.includes(daysUntil)) out.push({ daysUntil, date, label });
	};
	for (const r of earningsRows) {
		const name = WATCHLIST_NAMES[r.ticker] ?? r.ticker;
		add(r.next_date, `決算発表: ${name} (${r.ticker})`);
	}
	// FOMC/日銀/ピア決算。リマインドは「日本市場に効く日」基準 (event-context と同じ)。
	for (const r of macroRows) add(r.jst_effect_date || r.date, r.label);
	for (const e of upcomingCalendarEvents(today, Math.max(...LEAD_DAYS)))
		add(e.date, e.label);
	out.sort(
		(a, b) => a.daysUntil - b.daysUntil || a.label.localeCompare(b.label),
	);
	return out;
}

// D1 から earnings / macro_events を読み、当たったイベントを Slack に通知する。
// scheduledTime (cron の発火予定時刻) を JST に直した日付を today とする。
// 通知件数を返す (ログ用)。
export async function remindUpcomingEvents(
	env: Env,
	scheduledTime: number,
): Promise<number> {
	const today = new Date(scheduledTime + 9 * 60 * 60 * 1000)
		.toISOString()
		.slice(0, 10);
	const macroRows = (await db(env.DB)
		.select({
			date: macroEvents.date,
			kind: macroEvents.kind,
			label: macroEvents.label,
			impact: macroEvents.impact,
			jst_effect_date: macroEvents.jstEffectDate,
		})
		.from(macroEvents)
		.all()) as MacroEventRow[];
	const earningsRows = await db(env.DB)
		.select({ ticker: earnings.ticker, next_date: earnings.nextDate })
		.from(earnings)
		.all();
	const items = buildEventReminders(today, macroRows, earningsRows);
	await notifyEventReminder(env, today, items);
	return items.length;
}

// in-source tests。
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("buildEventReminders", () => {
		it("watchlist 決算は 3日前/1日前/当日にだけ出る", () => {
			const rows = [{ ticker: "285A", next_date: "2026-07-09" }];
			// 3日前。
			expect(buildEventReminders("2026-07-06", [], rows)).toContainEqual({
				daysUntil: 3,
				date: "2026-07-09",
				label: "決算発表: キオクシアホールディングス (285A)",
			});
			// 1日前・当日。
			expect(buildEventReminders("2026-07-08", [], rows)[0].daysUntil).toBe(1);
			expect(buildEventReminders("2026-07-09", [], rows)[0].daysUntil).toBe(0);
			// 2日前・4日前・通過後は出ない。
			for (const day of ["2026-07-07", "2026-07-05", "2026-07-10"]) {
				expect(
					buildEventReminders(day, [], rows)
						.map((i) => i.label)
						.join(),
				).not.toContain("285A");
			}
		});

		it("watchlist 外のコードは名前が引けずコードのまま出す", () => {
			const out = buildEventReminders(
				"2026-07-09",
				[],
				[{ ticker: "9999", next_date: "2026-07-09" }],
			);
			expect(out[0].label).toBe("決算発表: 9999 (9999)");
		});

		it("next_date が null/不正な行はスキップする", () => {
			expect(
				buildEventReminders(
					"2026-04-20",
					[],
					[
						{ ticker: "285A", next_date: null },
						{ ticker: "6857", next_date: "04-20" },
					],
				),
			).toHaveLength(0);
		});

		it("FOMC は jst_effect_date (日本市場に効く日) 基準でリマインドする", () => {
			const fomc: MacroEventRow[] = [
				{
					date: "2026-07-29",
					kind: "fomc",
					label: "FOMC 政策金利発表 (7月会合)",
					impact: "high",
					jst_effect_date: "2026-07-30",
				},
			];
			const out = buildEventReminders("2026-07-27", fomc, []);
			expect(out).toContainEqual({
				daysUntil: 3,
				date: "2026-07-30",
				label: "FOMC 政策金利発表 (7月会合)",
			});
			// date (2026-07-29) 基準の 3日前 (07-26) では出ない。
			expect(buildEventReminders("2026-07-26", fomc, [])).toHaveLength(0);
		});

		it("日銀 (jst_effect_date=null) は date 基準", () => {
			const boj: MacroEventRow[] = [
				{
					date: "2026-07-31",
					kind: "boj",
					label: "日銀 金融政策決定会合 結果発表 (7月会合)",
					impact: "high",
					jst_effect_date: null,
				},
			];
			expect(buildEventReminders("2026-07-31", boj, [])[0]).toEqual({
				daysUntil: 0,
				date: "2026-07-31",
				label: "日銀 金融政策決定会合 結果発表 (7月会合)",
			});
		});

		it("ピア決算も波及日でリマインドする", () => {
			const mu: MacroEventRow[] = [
				{
					date: "2026-06-24",
					kind: "peer_earnings:MU",
					label: "マイクロン(MU) 決算",
					impact: "high",
					jst_effect_date: "2026-06-25",
				},
			];
			expect(buildEventReminders("2026-06-24", mu, [])[0].daysUntil).toBe(1);
		});

		it("SQ (日付計算) も合流する", () => {
			// 2026-06-12 = 日本メジャーSQ。3日前の朝。
			const out = buildEventReminders("2026-06-09", [], []);
			expect(out).toContainEqual({
				daysUntil: 3,
				date: "2026-06-12",
				label: "日本メジャーSQ (6月限)",
			});
		});

		it("daysUntil 昇順で返す (本日が先頭)", () => {
			const rows = [
				{ ticker: "285A", next_date: "2026-06-12" }, // 3日後 (SQと同日)
				{ ticker: "6857", next_date: "2026-06-09" }, // 本日
			];
			const out = buildEventReminders("2026-06-09", [], rows);
			expect(out[0].daysUntil).toBe(0);
			expect(out[out.length - 1].daysUntil).toBe(3);
		});

		it("該当ゼロの朝は空配列 (通知は no-op になる)", () => {
			expect(buildEventReminders("2026-04-20", [], [])).toHaveLength(0);
		});
	});
}
