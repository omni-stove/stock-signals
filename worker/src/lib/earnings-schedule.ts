// JPX「決算発表予定日」一覧から、指定銘柄の公表済み決算発表予定日を引く。
//
// 一覧ページ (URL_JPX_SCHEDULE) に決算期別の xlsx が並ぶ。各 xlsx の先頭シートで「コード」と
// 「…予定日」を見出しに持つ行を探し、その下の行から (コード, 予定日) を読む。予定日は文字列
// ("2026/11/05" 等) か Excel の日付シリアル値のどちらでも受ける。
// earnings.ts (watchlist) と peer-earnings.ts (国内ピア) が、載っていれば公表日、無ければ推定日を使う。

import { fetchHtml, sleep } from "./utils";
import { readXlsxFirstSheet, type SheetRows } from "./xlsx";

export interface EarningsScheduleEnv {
	USER_AGENT: string;
	MIN_INTERVAL_MS: string;
}

const URL_JPX_SCHEDULE =
	"https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html";
const XLSX_TIMEOUT_MS = 20_000;
// Excel の日付シリアル値 0 日目 (1900 年うるう年バグ込みで 1899-12-30)。
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

function parseScheduleLinks(html: string): string[] {
	const out: string[] = [];
	for (const m of html.matchAll(/href="([^"]+\.xlsx)"/gi)) {
		const url = new URL(m[1], URL_JPX_SCHEDULE).toString();
		if (!out.includes(url)) out.push(url);
	}
	return out;
}

// "6857" / "6857.0" / "68570" (末尾チェックディジット 0 付きの 5 桁) / "285A" → 4 桁コード。読めなければ null。
function normalizeCode(raw: string): string | null {
	const s = raw
		.replace(/\s+/g, "")
		.replace(/\.0+$/, "")
		.toUpperCase();
	if (/^[0-9][0-9A-Z]{3}$/.test(s)) return s;
	if (/^[0-9][0-9A-Z]{3}0$/.test(s)) return s.slice(0, 4);
	return null;
}

// "2026/11/05" / "2026-11-5" / "2026年11月5日" / Excel シリアル値 → "YYYY-MM-DD"。「未定」等は null。
function parseScheduleDate(raw: string): string | null {
	const s = raw.trim();
	const m = s.match(/^(\d{4})\s*[/\-年.]\s*(\d{1,2})\s*[/\-月.]\s*(\d{1,2})/);
	if (m) {
		const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
		if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
		return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
	}
	// 2000-01-01 (36526) .. 2099-12-31 (73050) の範囲だけ日付シリアルとして読む (コード等の数値と取り違えない)。
	if (/^\d+(\.\d+)?$/.test(s)) {
		const n = Math.floor(Number(s));
		if (n < 36526 || n > 73050) return null;
		return new Date(EXCEL_EPOCH_MS + n * 86_400_000).toISOString().slice(0, 10);
	}
	return null;
}

/**
 * 一覧シートから wanted のコードの予定日をすべて拾う (コード → 日付の配列)。
 * 見出し行 (「コード」と「予定日」を含むセルを持つ行) が無ければ null。
 */
function parseScheduleSheet(
	rows: SheetRows,
	wanted: ReadonlySet<string>,
): Map<string, string[]> | null {
	const rowNums = [...rows.keys()].sort((a, b) => a - b);
	let header: { row: number; codeCol: number; dateCol: number } | null = null;
	for (const r of rowNums) {
		const cells = [...(rows.get(r)?.entries() ?? [])];
		const codeCol = cells.find(([, v]) => v.includes("コード"))?.[0];
		const dateCol = cells.find(([, v]) => v.includes("予定日"))?.[0];
		if (codeCol !== undefined && dateCol !== undefined) {
			header = { row: r, codeCol, dateCol };
			break;
		}
	}
	if (!header) return null;
	const out = new Map<string, string[]>();
	for (const r of rowNums) {
		if (r <= header.row) continue;
		const cells = rows.get(r);
		const code = normalizeCode(cells?.get(header.codeCol) ?? "");
		if (!code || !wanted.has(code)) continue;
		const date = parseScheduleDate(cells?.get(header.dateCol) ?? "");
		if (!date) continue;
		out.set(code, [...(out.get(code) ?? []), date]);
	}
	return out;
}

// 1 銘柄の予定日のうち today 以降で最も近いもの。発表済みの期の行は次回ではないので捨てる。
function pickUpcoming(dates: string[], today: string): string | null {
	return dates.filter((d) => d >= today).sort()[0] ?? null;
}

export interface EarningsSchedule {
	// コード → today 以降で最も近い公表済みの決算発表予定日 (YYYY-MM-DD)。一覧に無い銘柄は入らない。
	dates: Map<string, string>;
	// 読んだ xlsx ごとの結果 (収集レスポンスの診断用)。
	files: { url: string; hits?: number; error?: string }[];
}

/**
 * JPX の決算発表予定日一覧から codes の次回予定日を引く。today (JST の YYYY-MM-DD) より前の日付は捨てる。
 * 一覧ページが取れない・xlsx リンクが 1 つも無いときは例外を投げる。個々の xlsx の失敗は files に残して続ける。
 */
export async function fetchEarningsSchedule(
	env: EarningsScheduleEnv,
	codes: readonly string[],
	today: string,
): Promise<EarningsSchedule> {
	const links = parseScheduleLinks(await fetchHtml(URL_JPX_SCHEDULE, env));
	if (links.length === 0)
		throw new Error("jpx schedule: xlsx リンクが無い (ページ構造変更の可能性)");
	const interval = Number.parseInt(env.MIN_INTERVAL_MS, 10) || 5000;
	const wanted = new Set(codes);
	const all = new Map<string, string[]>();
	const files: EarningsSchedule["files"] = [];
	for (const [i, url] of links.entries()) {
		if (i > 0) await sleep(interval);
		try {
			const res = await fetch(url, {
				headers: { "User-Agent": env.USER_AGENT },
				signal: AbortSignal.timeout(XLSX_TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const sheet = await readXlsxFirstSheet(
				new Uint8Array(await res.arrayBuffer()),
			);
			if (!sheet) throw new Error("xlsx を読めない");
			const hits = parseScheduleSheet(sheet, wanted);
			if (!hits) throw new Error("見出し行 (コード / 予定日) が無い");
			for (const [code, dates] of hits)
				all.set(code, [...(all.get(code) ?? []), ...dates]);
			files.push({ url, hits: hits.size });
		} catch (e) {
			files.push({ url, error: (e as Error).message });
		}
	}
	const dates = new Map<string, string>();
	for (const [code, ds] of all) {
		const next = pickUpcoming(ds, today);
		if (next) dates.set(code, next);
	}
	return { dates, files };
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("parseScheduleLinks", () => {
		it("xlsx リンクだけを絶対 URL にして重複を除く", () => {
			const html = `<a href="/listing/event-schedules/financial-announcement/tvdivq0000001ofb-att/kessan03_1120.xlsx">a</a>
				<a href="/listing/event-schedules/financial-announcement/tvdivq0000001ofb-att/kessan03_1120.pdf">p</a>
				<a href="/listing/event-schedules/financial-announcement/tvdivq0000001ofb-att/kessan03_1120.xlsx">dup</a>
				<a href="https://www.jpx.co.jp/x/kessan09_1120.XLSX">b</a>`;
			expect(parseScheduleLinks(html)).toEqual([
				"https://www.jpx.co.jp/listing/event-schedules/financial-announcement/tvdivq0000001ofb-att/kessan03_1120.xlsx",
				"https://www.jpx.co.jp/x/kessan09_1120.XLSX",
			]);
		});
	});

	describe("normalizeCode", () => {
		it("4 桁・英字入り・小数表記・5 桁コードを 4 桁にする", () => {
			expect(normalizeCode("6857")).toBe("6857");
			expect(normalizeCode(" 285a ")).toBe("285A");
			expect(normalizeCode("6857.0")).toBe("6857");
			expect(normalizeCode("68570")).toBe("6857");
		});
		it("コードでない値は null", () => {
			expect(normalizeCode("コード")).toBeNull();
			expect(normalizeCode("")).toBeNull();
			expect(normalizeCode("68571")).toBeNull();
		});
	});

	describe("parseScheduleDate", () => {
		it("区切り文字の違う日付文字列を読む", () => {
			expect(parseScheduleDate("2026/11/05")).toBe("2026-11-05");
			expect(parseScheduleDate("2026-1-5")).toBe("2026-01-05");
			expect(parseScheduleDate("2026年11月5日")).toBe("2026-11-05");
		});
		it("Excel 日付シリアル値を読む", () => {
			expect(parseScheduleDate("46331")).toBe("2026-11-05");
		});
		it("未定・範囲外の数値は null", () => {
			expect(parseScheduleDate("未定")).toBeNull();
			expect(parseScheduleDate("")).toBeNull();
			expect(parseScheduleDate("6857")).toBeNull();
		});
	});

	describe("parseScheduleSheet", () => {
		const sheet = (cells: Record<number, Record<number, string>>): SheetRows =>
			new Map(
				Object.entries(cells).map(([r, cs]) => [
					Number(r),
					new Map(Object.entries(cs).map(([c, v]) => [Number(c), v])),
				]),
			);
		it("見出し行の下から wanted のコードの予定日だけ拾う", () => {
			const rows = sheet({
				1: { 0: "決算発表予定日一覧" },
				4: { 0: "決算発表予定日", 1: "コード", 2: "会社名" },
				5: { 0: "46331", 1: "6857", 2: "アドバンテスト" },
				6: { 0: "2026/11/10", 1: "285A", 2: "キオクシア" },
				7: { 0: "2026/11/12", 1: "9999", 2: "対象外" },
				8: { 0: "未定", 1: "6920", 2: "レーザーテック" },
			});
			expect(
				parseScheduleSheet(rows, new Set(["6857", "285A", "6920"])),
			).toEqual(
				new Map([
					["6857", ["2026-11-05"]],
					["285A", ["2026-11-10"]],
				]),
			);
		});
		it("見出し行が無ければ null", () => {
			expect(
				parseScheduleSheet(sheet({ 1: { 0: "6857" } }), new Set(["6857"])),
			).toBeNull();
		});
	});

	describe("pickUpcoming", () => {
		it("today 以降で最も近い日を選び、過ぎた日は捨てる", () => {
			expect(
				pickUpcoming(["2027-02-05", "2026-11-05", "2026-08-01"], "2026-11-05"),
			).toBe("2026-11-05");
			expect(pickUpcoming(["2026-08-01"], "2026-11-05")).toBeNull();
		});
	});
}
