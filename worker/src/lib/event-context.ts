// 需給イベント文脈を 1 行に組み立てる純粋関数。signal-judge / crash-scenario / market-check が読む。
//
// 設計:
//   - SQ は日付計算で出る: 日本SQ=各月 第2金曜 / 米SQ=各月 第3金曜 / 3・6・9・12月=メジャーSQ。
//     2 窓を出す: 「SQ週 (当日を含む月〜金)」= 建玉調整で歪む / 「SQ明け (翌週)」= 清算が抜け実勢。
//   - 指数リバランスも日付計算 (MSCI=2/5/8/11月末, FTSE=3/6/9/12月第3金曜, 日経=4/10月初, TOPIX=10月末)。
//   - FOMC/日銀/海外ピア決算は計算できないので D1 macro_events から渡す (呼び出し側が rows を注入)。
//   - 全て UTC 正午アンカーで日付計算する。

// macro_events の 1 行 (D1 macroEvents の select 結果と同じキー)。
export interface MacroEventRow {
	date: string;
	kind?: string | null;
	label: string;
	impact?: string | null;
	jst_effect_date?: string | null;
}

const DAYS = 5; // マクロ (FOMC/日銀) の近接窓 (today〜today+DAYS)
const IDX_LEAD = 5; // 指数リバランス: 実施前の窓 (これから歪む側。N 日前まで)
const IDX_AFTER = 2; // 指数リバランス: 実施後の窓 (反動取りの側のみ。歪み剥落後の「実勢に戻る」だけの日は出さない)
// ピア決算は「済んだ結果 (前夜 NY の実際の反応) が当日の地合いの正体」の側を厚く出す。
// 先読み (PEER_LEAD) は短く: まだ遠い次回決算に何日も前から身構えると、直近に出た決算の
// 消化より未来の予定が居座り judge が時系列を取り違えるため。余韻 (PEER_AFTER) は長め:
// 週明けや連休を跨いでも直近決算の反応を地合いの材料として残す。
const PEER_LEAD = 2; // ピア決算: SOX 波及前の窓 (これから織り込む側。当日〜N 日後まで)
const PEER_AFTER = 5; // ピア決算: SOX 波及後の窓 (直近に出た決算が当日の地合いの正体である可能性を出す)

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
// 2 つの YYYY-MM-DD の暦日差 (b - a)。event-reminder も使う。
export function daysDiff(a: string, b: string): number {
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
	if (diff > 0) {
		// 実施前: これから引けに歪む側。IDX_LEAD 日前まで出す。
		if (diff > IDX_LEAD) return null;
		return `${name}(実施=${date}/${diff}日後・パッシブ需給がクローズに集中, リバランス当日へ向けた歪みに注意)`;
	}
	if (diff === 0) {
		return `${name}(実施=本日${date}/引けにパッシブ売買集中・寄りと引けで需給が大きく振れうる)`;
	}
	// 実施後: 歪みは剥落するが直後は反動 (戻り/反落) が出やすい。その反動取りの窓 (IDX_AFTER 日) だけ
	// 出す。それ以降は「実勢に戻った」だけで方向判断の足しにならないので出さない。
	if (-diff > IDX_AFTER) return null;
	return `${name}(実施=${date}/${-diff}日前に通過・リバランス由来の振れが剥落する局面で反動 (戻り/反落) が出やすい)`;
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

// --- カレンダーイベントの日付列挙 (event-reminder 用) -------------------------
// buildEventContext が judge 向けに「窓」(SQ週/明け等) で語るのに対し、こちらは
// today〜today+horizonDays に入る実施日そのものを {date, label} で返す。
// 対象は日付計算で出せるもの (日本SQ/米メジャーSQ/指数リバランス) のみ。
// FOMC/日銀/ピア決算は macro_events を持つ呼び出し側が合流させる。
export function upcomingCalendarEvents(
	today: string,
	horizonDays: number,
): { date: string; label: string }[] {
	const out: { date: string; label: string }[] = [];
	const horizon = addDays(today, horizonDays);
	const add = (date: string, label: string) => {
		if (date >= today && date <= horizon) out.push({ date, label });
	};
	const thisYm = ymOf(today);
	for (const ym of [thisYm, nextYm(thisYm)]) {
		const m = Number(ym.slice(5, 7));
		const isMajor = [3, 6, 9, 12].includes(m);
		add(
			nthFriday(ym, 2),
			isMajor ? `日本メジャーSQ (${m}月限)` : `日本SQ (${m}月限オプションのみ)`,
		);
		if (isMajor) {
			add(nthFriday(ym, 3), `米メジャーSQ (${m}月)`);
			add(nthFriday(ym, 3), "FTSE/Russellリバランス");
		}
		if (m === 2 || m === 8) add(lastBusinessDay(ym), "MSCI四半期リバランス");
		if (m === 5 || m === 11) add(lastBusinessDay(ym), "MSCI半期リバランス");
		if (m === 4) add(nthBusinessDay(ym, 1), "日経225定期入替");
		if (m === 10) {
			add(lastBusinessDay(ym), "TOPIX定期見直し");
			add(nthBusinessDay(ym, 1), "日経225定期入替");
		}
	}
	return out;
}

// --- マクロイベント (FOMC/日銀) + 海外ピア決算 を近接で拾う -------------------
// peerResultOut: 波及日当日が「寄り後」(=前夜 NY でピア決算結果が既に出ている) なら true。
// 寄り前 (premarket) は前夜 NY 消化中で結果未着なので false。
function collectMacro(
	today: string,
	rows: MacroEventRow[],
	peerResultOut: boolean,
): { macro: string[]; peer: string[] } {
	const macro: string[] = [];
	const peer: string[] = [];
	const horizon = addDays(today, DAYS);
	for (const r of rows) {
		const eff = r.jst_effect_date || r.date;
		if (!eff) continue;
		// 日付パース不能はスキップ。
		if (!/^\d{4}-\d{2}-\d{2}$/.test(eff) || Number.isNaN(d(eff).getTime()))
			continue;
		const daysUntil = daysDiff(today, eff);
		const kind = r.kind || "";
		// ピア決算は [today-PEER_AFTER, today+PEER_LEAD]: 済んだ決算の余韻を厚く、先読みは短く。
		// それ以外 (FOMC/日銀) は近接窓 today〜horizon のみ。
		const isPeer = kind.startsWith("peer_earnings:");
		const lowerBound = isPeer ? addDays(today, -PEER_AFTER) : today;
		const upperBound = isPeer ? addDays(today, PEER_LEAD) : horizon;
		if (eff < lowerBound || eff > upperBound) continue;
		const when = daysUntil === 0 ? "本日" : `${daysUntil}日後`;
		if (isPeer) {
			// 波及日当日: 寄り前 (premarket) は「これから織り込む」、寄り後は前夜 NY で結果が
			// 出ているので「結果既出・地合いに織り込み中」と時制を分ける (未来扱いの誤読を防ぐ)。
			const todayPeer = peerResultOut
				? `本日${r.label}は結果既出→地合いに織り込み中(波及=${eff})`
				: `本日${r.label}→SOX変動リスク(波及=${eff})`;
			peer.push(
				daysUntil === 0
					? todayPeer
					: daysUntil > 0
						? `あと${daysUntil}日で${r.label}→SOX変動リスク(波及=${eff})`
						: `${r.label}は通過済み(波及=${eff}/${-daysUntil}日前)→当日の地合いの正体の可能性`,
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
// phase (省略可): 波及日当日のピア決算を「これから(寄り前)」/「結果既出(寄り後)」で出し分けるため
// の市場フェーズ。"premarket" / 省略 = 寄り前扱い (これから)、それ以外 = 寄り後 (結果既出)。
// 出力形式: "需給イベント(<today>): <...; 連結>" or "...: 特になし"。
export function buildEventContext(
	today: string,
	macroRows: MacroEventRow[] = [],
	phase?: string,
): string {
	const sq = checkSq(today);
	const idx = checkIndexRebalance(today);
	const peerResultOut = phase != null && phase !== "premarket";
	const { macro, peer } = collectMacro(today, macroRows, peerResultOut);
	const all = [...sq, ...idx, ...macro, ...peer];
	if (all.length === 0) return `需給イベント(${today}): 特になし`;
	return `需給イベント(${today}): ${all.join("; ")}`;
}

// in-source tests。
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
		it("通過直後 (実施2日後まで) は反動の窓を出す", () => {
			// MSCI半期 実施=2026-05-29。2日後=2026-05-31 は反動取りの窓。
			const out = buildEventContext("2026-05-31");
			expect(out).toContain("実施=2026-05-29/2日前に通過");
			expect(out).toContain("反動");
		});
		it("通過後 3日以上 (2026-06-01) は出さない", () => {
			// 実施 3日後。剥落しただけで方向判断の足しにならないので出さない。
			expect(buildEventContext("2026-06-01")).not.toContain(
				"MSCI半期リバランス",
			);
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

	describe("upcomingCalendarEvents", () => {
		it("日本メジャーSQ (2026-06-12) を3日前から拾う", () => {
			const out = upcomingCalendarEvents("2026-06-09", 3);
			expect(out).toContainEqual({
				date: "2026-06-12",
				label: "日本メジャーSQ (6月限)",
			});
		});
		it("窓の外 (4日前) は拾わない", () => {
			expect(upcomingCalendarEvents("2026-06-08", 3)).not.toContainEqual({
				date: "2026-06-12",
				label: "日本メジャーSQ (6月限)",
			});
		});
		it("過去の日付 (当月の通過済みSQ) は拾わない", () => {
			expect(
				upcomingCalendarEvents("2026-06-15", 3).map((e) => e.date),
			).not.toContain("2026-06-12");
		});
		it("メジャー月の第3金曜は米SQとFTSEの両方が出る", () => {
			const out = upcomingCalendarEvents("2026-06-19", 0);
			expect(out).toContainEqual({
				date: "2026-06-19",
				label: "米メジャーSQ (6月)",
			});
			expect(out).toContainEqual({
				date: "2026-06-19",
				label: "FTSE/Russellリバランス",
			});
		});
		it("非メジャー月はオプションのみのラベルで米SQは出ない", () => {
			const out = upcomingCalendarEvents("2026-07-07", 3);
			expect(out).toContainEqual({
				date: "2026-07-10",
				label: "日本SQ (7月限オプションのみ)",
			});
			expect(out.map((e) => e.label).join()).not.toContain("米メジャーSQ");
		});
		it("月跨ぎ: 翌月頭のイベント (10月の日経225定期入替) も拾う", () => {
			// 2026-10-01 は木曜 = 10月の第1営業日。
			const out = upcomingCalendarEvents("2026-09-29", 3);
			expect(out).toContainEqual({
				date: "2026-10-01",
				label: "日経225定期入替",
			});
		});
		it("MSCI半期 (2026-05-29 = 5月最終営業日) を拾う", () => {
			expect(upcomingCalendarEvents("2026-05-27", 3)).toContainEqual({
				date: "2026-05-29",
				label: "MSCI半期リバランス",
			});
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
		it("先読み窓内 (2日後=PEER_LEAD) は あとX日で<社名>→SOX変動リスク", () => {
			const out = buildEventContext("2026-06-23", mu);
			expect(out).toContain("あと2日でマイクロン(MU) 決算");
			expect(out).toContain("SOX変動リスク");
			expect(out).not.toContain("マイクロン(MU) 決算(2026");
		});
		it("先読み窓の外 (3日前=PEER_LEAD超) はまだ身構えない (出さない)", () => {
			// 波及=06-25 の 3日前。まだ遠い次回決算に前もって身構えると直近決算の消化が劣後するため出さない。
			expect(buildEventContext("2026-06-22", mu)).not.toContain(
				"マイクロン(MU) 決算",
			);
		});
		it("波及日当日・phase省略 (寄り前扱い) は 本日<社名>→SOX変動リスク", () => {
			expect(buildEventContext("2026-06-25", mu)).toContain(
				"本日マイクロン(MU) 決算→SOX変動リスク",
			);
		});
		it("波及日当日・premarket は これから (本日→SOX変動リスク)", () => {
			expect(buildEventContext("2026-06-25", mu, "premarket")).toContain(
				"本日マイクロン(MU) 決算→SOX変動リスク",
			);
		});
		it("波及日当日・寄り後 (afternoon_session) は 結果既出→地合いに織り込み中", () => {
			const out = buildEventContext("2026-06-25", mu, "afternoon_session");
			expect(out).toContain(
				"本日マイクロン(MU) 決算は結果既出→地合いに織り込み中",
			);
			expect(out).not.toContain("→SOX変動リスク(波及=2026-06-25)");
		});
		it("波及1日後は 通過済み (当日の地合いの正体の可能性)", () => {
			const out = buildEventContext("2026-06-26", mu);
			expect(out).toContain(
				"マイクロン(MU) 決算は通過済み(波及=2026-06-25/1日前)",
			);
			expect(out).toContain("当日の地合いの正体の可能性");
			expect(out).not.toContain("あと");
		});
		it("波及4日後もまだ通過済みで出る (余韻を厚く残す)", () => {
			// 波及=06-25 の 4日後。旧 PEER_AFTER=2 では消えていたが、直近決算の反応を
			// 地合いの正体として残すため出す。
			const out = buildEventContext("2026-06-29", mu);
			expect(out).toContain(
				"マイクロン(MU) 決算は通過済み(波及=2026-06-25/4日前)",
			);
			expect(out).toContain("当日の地合いの正体の可能性");
		});
		it("波及から PEER_AFTER (5日) を超えたら出さない", () => {
			// 波及=06-25 の 6日後。剥落して当日の地合いの説明にならないので出さない。
			expect(buildEventContext("2026-07-01", mu)).not.toContain(
				"マイクロン(MU) 決算",
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
