// 「今が JST で東証のどのフェーズか」を 1 フィールドで返す純粋関数。
//
// 設計:
//   - quote_status (prices の鮮度) は「ライブか引け値か」しか分からず寄り前と引け後を区別できないため、
//     JST の現在時刻と曜日から東証の場立てフェーズを 1 フィールドで返す。
//   - Worker は UTC で動くので、与えられた時刻を JST の暦日・時刻フィールドに正規化してから判定する。
//
// フェーズ定義:
//   premarket          平日 〜09:00      (寄り前。前夜 NY を消化中)
//   morning_session    平日 09:00-11:30  (前場ザラ場)
//   lunch_break        平日 11:30-12:30  (昼休み)
//   afternoon_session  平日 12:30-15:30  (後場ザラ場)
//   closed             平日 15:30〜 / 土日 (引け後・休場)

export type MarketPhase =
	| "premarket"
	| "morning_session"
	| "lunch_break"
	| "afternoon_session"
	| "closed";

// JST に正規化した「暦日 (YYYY-MM-DD)」「時:分を 4 桁数値にした hm (例 0900)」「曜日 (1=月..7=日)」。
interface JstNow {
	date: string; // YYYY-MM-DD (JST)
	hm: number; // HHMM を 10進数にした値 (例 0930 → 930)
	dow: number; // 1=月 .. 7=日 (ISO)
}

// now 文字列を JST の暦日・時刻フィールドに正規化する。
//   - 省略時はサーバ実時刻 (UTC) を JST に直す。
//   - タイムゾーン付き ISO8601 (...Z / ...+09:00) は絶対時刻としてパースし JST へ変換する。
//   - オフセットなしの "YYYY-MM-DD HH:MM" や "YYYY-MM-DDTHH:MM" は **JST のローカル時刻**として
//     そのまま読む。
function toJstNow(now?: string | null, epochNow?: number): JstNow {
	const hasTz = now != null && /([zZ]|[+-]\d{2}:?\d{2})\s*$/.test(now.trim());
	// オフセットなしのローカル文字列はフィールドを直接読む (UTC 換算を挟まない)。
	if (now != null && now.trim() !== "" && !hasTz) {
		const m = now.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
		if (m) {
			const [, y, mo, d, h, mi] = m;
			return {
				date: `${y}-${mo}-${d}`,
				hm: parseInt(h, 10) * 100 + parseInt(mi, 10),
				dow: isoDow(`${y}-${mo}-${d}`),
			};
		}
		// 時刻なしの日付だけ ("YYYY-MM-DD") は 00:00 JST 扱い。
		const dm = now.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
		if (dm) {
			const [, y, mo, d] = dm;
			return { date: `${y}-${mo}-${d}`, hm: 0, dow: isoDow(`${y}-${mo}-${d}`) };
		}
	}
	// 絶対時刻 (TZ 付き ISO8601) または省略時 (サーバ UTC) → JST(+9h) のフィールドを読む。
	const baseMs =
		now != null && now.trim() !== "" && hasTz
			? Date.parse(now)
			: (epochNow ?? Date.now());
	const jst = new Date(baseMs + 9 * 3600_000);
	const date = jst.toISOString().slice(0, 10);
	const hm = jst.getUTCHours() * 100 + jst.getUTCMinutes();
	// getUTCDay: 0=日..6=土 → ISO の 1=月..7=日 に直す。
	const day = jst.getUTCDay();
	const dow = day === 0 ? 7 : day;
	return { date, hm, dow };
}

// YYYY-MM-DD の ISO 曜日 (1=月..7=日)。正午 UTC でパースして DST/端数の影響を避ける。
function isoDow(ymd: string): number {
	const day = new Date(`${ymd}T12:00:00Z`).getUTCDay();
	return day === 0 ? 7 : day;
}

// JST の {hm, dow} から東証フェーズを返す。境界は 09:00 は morning、
// 11:30 は lunch、12:30 は afternoon、15:30 は closed。土日は常に closed。
function marketPhaseFrom(jst: JstNow): MarketPhase {
	if (jst.dow >= 6) return "closed";
	if (jst.hm < 900) return "premarket";
	if (jst.hm < 1130) return "morning_session";
	if (jst.hm < 1230) return "lunch_break";
	if (jst.hm < 1530) return "afternoon_session";
	return "closed";
}

// now 文字列 (任意) から market_phase と today (JST 暦日) を返す入口。
export function resolveMarketPhase(
	now?: string | null,
	epochNow?: number,
): { today: string; marketPhase: MarketPhase } {
	const jst = toJstNow(now, epochNow);
	return { today: jst.date, marketPhase: marketPhaseFrom(jst) };
}

// 東証の1日の立会時間 (前場 09:00-11:30 = 150分 + 後場 12:30-15:30 = 180分)。
const MORNING_MIN = 150; // 09:00-11:30
const AFTERNOON_MIN = 180; // 12:30-15:30
const SESSION_MIN = MORNING_MIN + AFTERNOON_MIN; // 330

// hm (HHMM) を「09:00 を 0 とした前場の経過分」に直す (0..150 にクランプ)。
function morningElapsed(hm: number): number {
	const cur = Math.floor(hm / 100) * 60 + (hm % 100);
	const open = 9 * 60; // 09:00
	return Math.max(0, Math.min(MORNING_MIN, cur - open));
}

// hm (HHMM) を「12:30 を 0 とした後場の経過分」に直す (0..180 にクランプ)。
function afternoonElapsed(hm: number): number {
	const cur = Math.floor(hm / 100) * 60 + (hm % 100);
	const open = 12 * 60 + 30; // 12:30
	return Math.max(0, Math.min(AFTERNOON_MIN, cur - open));
}

// now が当日ザラ場のどこまで進んだか = 経過立会分 / 330。寄り前 0、引け後 1。
// 当日累積出来高を「1日フル換算」する分母として使う (intraday の vol_x_20d 補正)。
// 土日や寄り前は 0 を返す (= フル換算できない)。
export function sessionElapsedFrac(
	now?: string | null,
	epochNow?: number,
): number {
	const jst = toJstNow(now, epochNow);
	if (jst.dow >= 6) return 0; // 土日は立会なし
	const elapsed = morningElapsed(jst.hm) + afternoonElapsed(jst.hm);
	return elapsed / SESSION_MIN;
}

// in-source tests。
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("toJstNow", () => {
		it("オフセットなしのローカル文字列は JST フィールドをそのまま読む", () => {
			// 2026-06-22 は月曜。
			expect(toJstNow("2026-06-22 08:30")).toEqual({
				date: "2026-06-22",
				hm: 830,
				dow: 1,
			});
			expect(toJstNow("2026-06-22T14:00")).toEqual({
				date: "2026-06-22",
				hm: 1400,
				dow: 1,
			});
		});

		it("TZ 付き ISO8601 は絶対時刻として JST へ変換する", () => {
			// 00:00Z = JST 09:00 (同日)。
			expect(toJstNow("2026-06-22T00:00:00Z")).toEqual({
				date: "2026-06-22",
				hm: 900,
				dow: 1,
			});
			// +09:00 明示はそのまま JST。
			expect(toJstNow("2026-06-22T08:30:00+09:00")).toEqual({
				date: "2026-06-22",
				hm: 830,
				dow: 1,
			});
			// UTC 18:00 (前日) = JST 翌日 03:00、日付が繰り上がる。
			expect(toJstNow("2026-06-21T18:00:00Z")).toEqual({
				date: "2026-06-22",
				hm: 300,
				dow: 1,
			});
		});

		it("省略時は epochNow(UTC) を JST に直す", () => {
			// 2026-06-22T00:00:00Z のエポック。
			const ms = Date.parse("2026-06-22T00:00:00Z");
			expect(toJstNow(undefined, ms)).toEqual({
				date: "2026-06-22",
				hm: 900,
				dow: 1,
			});
		});

		it("日付だけの文字列は 00:00 JST 扱い", () => {
			expect(toJstNow("2026-06-20")).toEqual({
				date: "2026-06-20",
				hm: 0,
				dow: 6, // 土曜
			});
		});
	});

	describe("marketPhaseFrom", () => {
		const at = (s: string) => marketPhaseFrom(toJstNow(s));
		it("平日 09:00 前は premarket", () => {
			expect(at("2026-06-22 08:30")).toBe("premarket");
		});
		it("平日 09:00-11:30 は morning_session (09:00 境界含む)", () => {
			expect(at("2026-06-22 10:00")).toBe("morning_session");
			expect(at("2026-06-22 09:00")).toBe("morning_session");
		});
		it("平日 11:30-12:30 は lunch_break (11:30 境界含む)", () => {
			expect(at("2026-06-22 12:00")).toBe("lunch_break");
			expect(at("2026-06-22 11:30")).toBe("lunch_break");
		});
		it("平日 12:30-15:30 は afternoon_session (12:30 境界含む)", () => {
			expect(at("2026-06-22 14:00")).toBe("afternoon_session");
			expect(at("2026-06-22 12:30")).toBe("afternoon_session");
		});
		it("平日 15:30 以降は closed (15:30 境界含む)", () => {
			expect(at("2026-06-22 16:00")).toBe("closed");
			expect(at("2026-06-22 15:30")).toBe("closed");
		});
		it("土日は常に closed", () => {
			expect(at("2026-06-20 10:00")).toBe("closed"); // 土
			expect(at("2026-06-21 10:00")).toBe("closed"); // 日
		});
	});

	describe("resolveMarketPhase", () => {
		it("today と marketPhase をまとめて返す", () => {
			expect(resolveMarketPhase("2026-06-22 08:30")).toEqual({
				today: "2026-06-22",
				marketPhase: "premarket",
			});
		});
	});

	describe("sessionElapsedFrac", () => {
		// 全立会 330分 (前場150 + 後場180) を 1 とする経過率。
		it("寄り前 (09:00 前) は 0", () => {
			expect(sessionElapsedFrac("2026-06-22 08:30")).toBe(0);
			expect(sessionElapsedFrac("2026-06-22 09:00")).toBe(0);
		});
		it("前場の途中は morning 経過分 / 330", () => {
			// 10:00 = 寄りから60分 → 60/330。
			expect(sessionElapsedFrac("2026-06-22 10:00")).toBeCloseTo(60 / 330, 5);
		});
		it("前場引け (11:30) は 150/330、昼休みも 150/330 で据え置き", () => {
			expect(sessionElapsedFrac("2026-06-22 11:30")).toBeCloseTo(150 / 330, 5);
			expect(sessionElapsedFrac("2026-06-22 12:00")).toBeCloseTo(150 / 330, 5);
		});
		it("後場 15:00 は (150 + 150)/330", () => {
			// 後場 12:30 から 150分経過。
			expect(sessionElapsedFrac("2026-06-22 15:00")).toBeCloseTo(300 / 330, 5);
		});
		it("大引け (15:30) 以降は 1", () => {
			expect(sessionElapsedFrac("2026-06-22 15:30")).toBe(1);
			expect(sessionElapsedFrac("2026-06-22 16:00")).toBe(1);
		});
		it("土日は 0 (立会なし)", () => {
			expect(sessionElapsedFrac("2026-06-20 14:00")).toBe(0); // 土
		});
	});
}
