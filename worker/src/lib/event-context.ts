// 需給イベント文脈を 1 行に組み立てる純粋関数。signal-judge / crash-scenario / market-check が読む。
//
// 設計 (旧 scripts/event-context.sh を TS に移植):
//   - SQ は日付計算で出る: 日本SQ=各月 第2金曜 / 米SQ=各月 第3金曜 / 3・6・9・12月=メジャーSQ。
//     2 窓を出す: 「SQ週 (当日を含む月〜金)」= 建玉調整で歪む / 「SQ明け (翌週)」= 清算が抜け実勢。
//   - 指数リバランスも日付計算 (MSCI=2/5/8/11月末, FTSE=3/6/9/12月第3金曜, 日経=4/10月初, TOPIX=10月末)。
//   - FOMC/日銀/海外ピア決算は計算できないので D1 macro_events から渡す (呼び出し側が rows を注入)。
//   - GNU date 依存 (旧 sh の弱点。macOS で動かない) がここで消える。全て UTC 正午アンカーで日付計算する。
//
// 旧 event-context.sh / event-context.bats の出力文言と完全一致させること (skill の解釈が依存)。

// macro_events の 1 行 (D1 macroEvents の select 結果と同じキー)。
export interface MacroEventRow {
	date: string;
	kind?: string | null;
	label: string;
	impact?: string | null;
	jst_effect_date?: string | null;
}

const DAYS = 5; // マクロ/ピアの近接窓 (today〜today+DAYS)
const IDX_WINDOW = 5; // 指数リバランスの近接窓 (前後 IDX_WINDOW 暦日)

// --- 日付ヘルパー (全て UTC 正午アンカーで計算。DST/端数の影響を受けない) ---

// YYYY-MM-DD を UTC 正午の Date にする。
function d(ymd: string): Date {
	return new Date(`${ymd}T12:00:00Z`);
}
// Date を YYYY-MM-DD にする。
function ymd(date: Date): string {
	return date.toISOString().slice(0, 10);
}
// ISO 曜日 (1=月..7=日)。
function isoDow(date: Date): number {
	const w = date.getUTCDay();
	return w === 0 ? 7 : w;
}
// n 日加算した YYYY-MM-DD。
function addDays(ymdStr: string, n: number): string {
	return ymd(new Date(d(ymdStr).getTime() + n * 86400_000));
}
// 2 つの YYYY-MM-DD の暦日差 (b - a)。
function daysDiff(a: string, b: string): number {
	return Math.round((d(b).getTime() - d(a).getTime()) / 86400_000);
}
// "YYYY-MM" を返す (前月/翌月計算用)。
function ymOf(ymdStr: string): string {
	return ymdStr.slice(0, 7);
}
function prevYm(ym: string): string {
	const [y, m] = ym.split("-").map(Number);
	return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
function nextYm(ym: string): string {
	const [y, m] = ym.split("-").map(Number);
	return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

// 当該月 (YYYY-MM) の「第 N 金曜」。月初の曜日から最初の金曜(5)までのオフセットで求める。
function nthFriday(ym: string, n: number): string {
	const first = `${ym}-01`;
	const dow = isoDow(d(first)); // 月初の ISO 曜日
	const off = (5 - dow + 7) % 7; // 月初から最初の金曜までの日数
	return addDays(first, off + (n - 1) * 7);
}

// 当該月の「最終営業日 (土日を除く)」。祝日は非考慮の近似 (窓で見るので実用上問題ない)。
function lastBusinessDay(ym: string): string {
	// 翌月1日の前日 = 当月末日。
	const eom = addDays(`${nextYm(ym)}-01`, -1);
	const dow = isoDow(d(eom));
	if (dow === 6) return addDays(eom, -1); // 土 → 金
	if (dow === 7) return addDays(eom, -2); // 日 → 金
	return eom;
}

// 当該月の「第 N 営業日 (土日を除く, 月初から数える)」。祝日は非考慮の近似。
function nthBusinessDay(ym: string, n: number): string {
	let cur = `${ym}-01`;
	let count = 0;
	// 安全上限 (1ヶ月分回れば必ず見つかる)。
	for (let i = 0; i < 40; i++) {
		if (isoDow(d(cur)) <= 5) {
			count++;
			if (count >= n) return cur;
		}
		cur = addDays(cur, 1);
	}
	return cur;
}

// --- SQ 算出 ----------------------------------------------------------------
// SQ 日が today の属する週 (月〜金) なら "week"、その翌週なら "post"、それ以外 ""。
function sqPhase(
	sq: string,
	monday: string,
	friday: string,
): "week" | "post" | "" {
	// today の週 (月〜金) に SQ が入る → SQ週。
	if (sq >= monday && sq <= friday) return "week";
	// 先週 (= 今週月曜の3日前=先週金曜 / 7日前=先週月曜) が SQ週なら今週は明け。
	const lastFriday = addDays(monday, -3);
	const lastMonday = addDays(monday, -7);
	if (sq >= lastMonday && sq <= lastFriday) return "post";
	return "";
}

// today が属する週に SQ が入る/翌週かを判定し、文脈断片の配列を返す。
function checkSq(today: string): string[] {
	const notes: string[] = [];
	const dow = isoDow(d(today));
	const monday = addDays(today, -(dow - 1));
	const friday = addDays(monday, 4);

	const thisYm = ymOf(today);
	const prevM = prevYm(thisYm);

	// 当月・前月の 日本SQ(第2金) / 米SQ(第3金) を列挙。SQ 日の「月」でメジャー判定。
	const candidates: { sq: string; mkt: "jp" | "us" }[] = [
		{ sq: nthFriday(thisYm, 2), mkt: "jp" },
		{ sq: nthFriday(prevM, 2), mkt: "jp" },
		{ sq: nthFriday(thisYm, 3), mkt: "us" },
		{ sq: nthFriday(prevM, 3), mkt: "us" },
	];

	for (const { sq, mkt } of candidates) {
		const phase = sqPhase(sq, monday, friday);
		if (!phase) continue;
		const sqMonth = Number(sq.slice(5, 7)); // 1..12
		const isMajor = [3, 6, 9, 12].includes(sqMonth);

		if (mkt === "jp") {
			if (phase === "week") {
				notes.push(
					isMajor
						? `日本メジャーSQ週(${sqMonth}月限, SQ=${sq}/直接需給イベント・建玉清算で寄り値歪み)`
						: `日本SQ週(${sqMonth}月限オプションのみ, SQ=${sq}/需給やや歪み)`,
				);
			} else if (isMajor) {
				// 明け: メジャーのみ積む (マイナーSQ明けは波及無視)。
				notes.push(
					`日本メジャーSQ明け(${sqMonth}月限, SQ=${sq}/建玉清算が抜け実勢が見えやすい・歪み剥落の戻りに注意)`,
				);
			}
		} else {
			// 米SQ: メジャーのみ (SOX/米指数経由のマクロ要因)。
			if (!isMajor) continue;
			notes.push(
				phase === "week"
					? `米メジャーSQ週(${sqMonth}月, SQ=${sq}/SOX・米指数経由のマクロ要因・SQ清算由来の振れは持続性低い)`
					: `米メジャーSQ明け(${sqMonth}月, SQ=${sq}/SOX清算の歪みが抜けた後・地合いは素直に読んでよい)`,
			);
		}
	}
	return notes;
}

// --- 指数リバランス算出 ------------------------------------------------------
function emitIndex(today: string, date: string, name: string): string | null {
	if (!date) return null;
	const diff = daysDiff(today, date);
	if (Math.abs(diff) > IDX_WINDOW) return null;
	if (diff > 0) {
		return `${name}(実施=${date}/${diff}日後・パッシブ需給がクローズに集中, リバランス当日へ向けた歪みに注意)`;
	}
	if (diff === 0) {
		return `${name}(実施=本日${date}/引けにパッシブ売買集中・寄りと引けで需給が大きく振れうる)`;
	}
	return `${name}(実施=${date}/${-diff}日前に通過・リバランス由来の振れは剥落、実勢に戻る局面)`;
}

export function checkIndexRebalance(today: string): string[] {
	const notes: string[] = [];
	const thisYm = ymOf(today);
	const months = [prevYm(thisYm), thisYm, nextYm(thisYm)];
	for (const ym of months) {
		const m = Number(ym.slice(5, 7));
		if (m === 2 || m === 8)
			push(
				notes,
				emitIndex(today, lastBusinessDay(ym), "MSCI四半期リバランス"),
			);
		if (m === 5 || m === 11)
			push(notes, emitIndex(today, lastBusinessDay(ym), "MSCI半期リバランス"));
		if (m === 4)
			push(notes, emitIndex(today, nthBusinessDay(ym, 1), "日経225定期入替"));
		if (m === 10) {
			push(notes, emitIndex(today, lastBusinessDay(ym), "TOPIX定期見直し"));
			push(notes, emitIndex(today, nthBusinessDay(ym, 1), "日経225定期入替"));
		}
		if (m === 3 || m === 6 || m === 9 || m === 12)
			push(notes, emitIndex(today, nthFriday(ym, 3), "FTSE/Russellリバランス"));
	}
	return notes;
}

function push(arr: string[], v: string | null): void {
	if (v) arr.push(v);
}

// --- マクロイベント (FOMC/日銀) + 海外ピア決算 を近接で拾う -------------------
function collectMacro(
	today: string,
	rows: MacroEventRow[],
): { macro: string[]; peer: string[] } {
	const macro: string[] = [];
	const peer: string[] = [];
	const horizon = addDays(today, DAYS);
	for (const r of rows) {
		const eff = r.jst_effect_date || r.date;
		if (!eff) continue;
		// 日付パース不能はスキップ (旧 sh と同じく無視)。
		if (!/^\d{4}-\d{2}-\d{2}$/.test(eff) || Number.isNaN(d(eff).getTime()))
			continue;
		if (eff < today || eff > horizon) continue;
		const daysUntil = daysDiff(today, eff);
		const when = daysUntil === 0 ? "本日" : `${daysUntil}日後`;
		const kind = r.kind || "";
		if (kind.startsWith("peer_earnings:")) {
			peer.push(
				daysUntil === 0
					? `本日${r.label}→SOX変動リスク(波及=${eff})`
					: `あと${daysUntil}日で${r.label}→SOX変動リスク(波及=${eff})`,
			);
		} else {
			const imp =
				r.impact != null && r.impact !== "" && r.impact !== "null"
					? `[${r.impact}]`
					: "";
			macro.push(`${r.label}(${eff}/${when})${imp}`);
		}
	}
	return { macro, peer };
}

// today (基準日 JST) と macro_events 行から需給イベント1行を組み立てる。
// 旧 event-context.sh の最終出力と同一: "需給イベント(<today>): <...; 連結>" or "...: 特になし"。
export function buildEventContext(
	today: string,
	macroRows: MacroEventRow[] = [],
): string {
	const sq = checkSq(today);
	const idx = checkIndexRebalance(today);
	const { macro, peer } = collectMacro(today, macroRows);
	const all = [...sq, ...idx, ...macro, ...peer];
	if (all.length === 0) return `需給イベント(${today}): 特になし`;
	return `需給イベント(${today}): ${all.join("; ")}`;
}

// in-source tests (event-context.bats と一致させる)。
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("日付ヘルパー", () => {
		it("nthFriday: 2026-06 第2金=06-12 / 第3金=06-19", () => {
			expect(nthFriday("2026-06", 2)).toBe("2026-06-12");
			expect(nthFriday("2026-06", 3)).toBe("2026-06-19");
		});
		it("nthFriday: 月初が金曜の月 (2026-05 第1金=05-01)", () => {
			expect(nthFriday("2026-05", 1)).toBe("2026-05-01");
		});
		it("lastBusinessDay: 月末が金ならそのまま (2026-02=02-27)", () => {
			expect(lastBusinessDay("2026-02")).toBe("2026-02-27");
		});
		it("lastBusinessDay: 月末が日なら金へ寄せる (2026-05=05-29)", () => {
			expect(lastBusinessDay("2026-05")).toBe("2026-05-29");
		});
		it("nthBusinessDay: 2026-04 第1営業日=04-01", () => {
			expect(nthBusinessDay("2026-04", 1)).toBe("2026-04-01");
		});
		it("nthBusinessDay: 月初が日なら最初の平日 (2026-02=02-02)", () => {
			expect(nthBusinessDay("2026-02", 1)).toBe("2026-02-02");
		});
		it("daysDiff: 06-12 → 06-19 = 7", () => {
			expect(daysDiff("2026-06-12", "2026-06-19")).toBe(7);
		});
	});

	describe("buildEventContext (出力整形)", () => {
		it("日本メジャーSQ当日 (2026-06-12) はメジャーSQ週", () => {
			const out = buildEventContext("2026-06-12");
			expect(out).toContain("日本メジャーSQ週(6月限");
			expect(out).toContain("SQ=2026-06-12");
			expect(out.startsWith("需給イベント(2026-06-12):")).toBe(true);
			expect(out).not.toContain("\n");
		});
		it("SQ明け週 (2026-06-19) は JP明け/US週/FTSE", () => {
			const out = buildEventContext("2026-06-19");
			expect(out).toContain("日本メジャーSQ明け(6月限");
			expect(out).toContain("米メジャーSQ週(6月");
			expect(out).toContain("FTSE/Russellリバランス");
		});
		it("該当なしの静かな日 (2026-04-20) は特になし", () => {
			expect(buildEventContext("2026-04-20")).toContain("特になし");
		});
	});

	describe("指数リバランスの前/当日/後", () => {
		it("MSCI半期 (2026-05-29 実施) の2日前は N日後", () => {
			const out = buildEventContext("2026-05-27");
			expect(out).toContain("MSCI半期リバランス");
			expect(out).toContain("実施=2026-05-29/2日後");
			expect(out).toContain("当日へ向けた歪み");
		});
		it("通過後 (2026-06-01) は N日前に通過", () => {
			const out = buildEventContext("2026-06-01");
			expect(out).toContain("実施=2026-05-29/3日前に通過");
			expect(out).toContain("剥落");
		});
		it("FTSE (米SQ同日 6/19) 当日は本日", () => {
			const out = buildEventContext("2026-06-19");
			expect(out).toContain("FTSE/Russellリバランス(実施=本日2026-06-19");
		});
	});

	describe("マクロイベント", () => {
		const fomc: MacroEventRow[] = [
			{
				date: "2026-07-29",
				kind: "fomc",
				label: "FOMC 政策金利発表 (7月会合)",
				impact: "high",
				jst_effect_date: "2026-07-30",
			},
		];
		it("FOMC は jst_effect_date 当日 (07-30) に本日表示", () => {
			const out = buildEventContext("2026-07-30", fomc);
			expect(out).toContain("FOMC 政策金利発表 (7月会合)");
			expect(out).toContain("本日");
			expect(out).toContain("[high]");
		});
		it("FOMC は1日前 (07-29) でも拾う", () => {
			expect(buildEventContext("2026-07-29", fomc)).toContain(
				"2026-07-30/1日後",
			);
		});
		it("impact が null なら [..] を付けない", () => {
			const out = buildEventContext("2026-07-30", [
				{
					date: "2026-07-30",
					label: "日銀会合",
					impact: null,
					jst_effect_date: "2026-07-30",
				},
			]);
			expect(out).toContain("日銀会合(2026-07-30/本日)");
			expect(out).not.toContain("[null]");
			expect(out).not.toContain("[]");
		});
		it("パース不能な日付はスキップ、正常行は残る", () => {
			const out = buildEventContext("2026-07-30", [
				{ date: "not-a-date", label: "broken", impact: "high" },
				{
					date: "2026-07-30",
					label: "正常イベント",
					impact: "high",
					jst_effect_date: "2026-07-30",
				},
			]);
			expect(out).toContain("正常イベント(2026-07-30/本日)[high]");
			expect(out).not.toContain("broken(");
		});
		it("近接窓 (5日) 外は拾わない", () => {
			const out = buildEventContext("2026-07-30", [
				{
					date: "2026-08-09",
					label: "遠いイベント",
					impact: "high",
					jst_effect_date: "2026-08-09",
				},
			]);
			expect(out).not.toContain("遠いイベント");
		});
	});

	describe("海外SOX系ピア決算", () => {
		const mu: MacroEventRow[] = [
			{
				date: "2026-06-24",
				kind: "peer_earnings:MU",
				label: "マイクロン(MU) 決算",
				impact: "high",
				jst_effect_date: "2026-06-25",
			},
		];
		it("近接 (3日後) は あとX日で<社名>→SOX変動リスク", () => {
			const out = buildEventContext("2026-06-22", mu);
			expect(out).toContain("あと3日でマイクロン(MU) 決算");
			expect(out).toContain("SOX変動リスク");
			expect(out).not.toContain("マイクロン(MU) 決算(2026");
		});
		it("波及日当日は 本日<社名>→SOX変動リスク", () => {
			expect(buildEventContext("2026-06-25", mu)).toContain(
				"本日マイクロン(MU) 決算→SOX変動リスク",
			);
		});
		it("同日2社は両方出る", () => {
			const out = buildEventContext("2026-08-12", [
				{
					date: "2026-08-13",
					kind: "peer_earnings:NVDA",
					label: "エヌビディア(NVDA) 決算",
					impact: "high",
					jst_effect_date: "2026-08-14",
				},
				{
					date: "2026-08-13",
					kind: "peer_earnings:AMAT",
					label: "アプライド(AMAT) 決算",
					impact: "high",
					jst_effect_date: "2026-08-14",
				},
			]);
			expect(out).toContain("エヌビディア(NVDA) 決算");
			expect(out).toContain("アプライド(AMAT) 決算");
		});
		it("FOMC とピアが同時近接でも別枠で出る", () => {
			const out = buildEventContext("2026-07-30", [
				{
					date: "2026-07-29",
					kind: "fomc",
					label: "FOMC 政策金利発表 (7月会合)",
					impact: "high",
					jst_effect_date: "2026-07-30",
				},
				{
					date: "2026-07-31",
					kind: "peer_earnings:MU",
					label: "マイクロン(MU) 決算",
					impact: "high",
					jst_effect_date: "2026-08-01",
				},
			]);
			expect(out).toContain(
				"FOMC 政策金利発表 (7月会合)(2026-07-30/本日)[high]",
			);
			expect(out).toContain("あと2日でマイクロン(MU) 決算→SOX変動リスク");
		});
	});
}
