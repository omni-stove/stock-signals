// Cloudflare Worker: 次回決算発表予定日と四半期実績の収集
//
// kabutan finance ページ (https://kabutan.jp/stock/finance?code=<code>) の
//   - 3ヵ月決算表: 四半期ごとの売上・営業益・経常益・最終益 (百万円) と発表日
//   - 通期表の予想行: 今期会社予想 (百万円)
// を読む。次回決算日は JPX 決算発表予定日一覧 (earnings-schedule.ts) に載っていればその公表日、
// 無ければ「直近実績の次四半期 = 前年同期の発表日 +1年」の推定日とし、どちらかを earnings.estimated に残す。
// 次回決算日と通期予想は D1 の earnings に、四半期実績は earnings_quarters に保持する。
// judge-context はこれらから「決算が近い」(earnings) と「決算が出たばかり」(earnings_result) を組む。
//
// 全ソース UTF-8 なので TextDecoder で十分。

import { db } from "./db";
import {
	type EarningsScheduleEnv,
	fetchEarningsSchedule,
} from "./earnings-schedule";
import { type TableData as FinanceTable, scanTables } from "./html";
import { earnings, earningsQuarters } from "./schema";
import { toNumber, WATCHLIST } from "./timeseries";
import { fetchHtml, jstDate, sleep, sliceTables } from "./utils";

export interface EarningsEnv {
	DB: D1Database;
	USER_AGENT: string;
	MIN_INTERVAL_MS: string;
}

// peer-earnings.ts (国内ピア決算) も同じ kabutan finance ページから推定するため公開する。
export const URL_FINANCE = (code: string) =>
	`https://kabutan.jp/stock/finance?code=${code}`;

type Quarter = { y: number; startM: number; endM: number; raw: string };

// 四半期ラベル "25.04-06" -> { y: 2025, startM: 4, endM: 6, raw }。
// 上期・累計表の6ヵ月以上のラベル ("25.04-09") は3ヵ月でないので null。
function parseQLabel(label: string): Quarter | null {
	const m = label.match(/(\d{2})\.(\d{2})-(\d{2})/);
	if (!m) return null;
	const startM = Number(m[2]);
	const endM = Number(m[3]);
	if ((endM - startM + 12) % 12 !== 2) return null;
	return { y: 2000 + Number(m[1]), startM, endM, raw: m[0] };
}

// D1 に保存する四半期キー "2026.07-09" (開始月の西暦年)。文字列順 = 時系列順。
function quarterKey(q: Quarter): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${q.y}.${p(q.startM)}-${p(q.endM)}`;
}

// kabutan 発表日 "26/04/30" -> "2026-04-30"
function parseAnnounce(s: string | null | undefined): string | null {
	const m = (s ?? "").match(/(\d{2})\/(\d{2})\/(\d{2})/);
	return m ? `20${m[1]}-${m[2]}-${m[3]}` : null;
}

// 売上・営業益・経常益・最終益 (百万円)。
type PlFigures = {
	sales: number | null;
	operating: number | null;
	ordinary: number | null;
	net: number | null;
};

type QuarterRow = { q: Quarter; announce: string | null } & PlFigures;

// 通期表の予想行。period は決算期末 "2027.03"。
type FullYearForecast = { period: string } & PlFigures;

function plColumns(t: FinanceTable) {
	const col = (name: string) => t.headers.findIndex((h) => h.includes(name));
	const idx = {
		sales: col("売上高"),
		operating: col("営業益"),
		ordinary: col("経常益"),
		net: col("最終益"),
	};
	return (cells: { text: string }[]): PlFigures => {
		const at = (i: number) => (i >= 0 ? toNumber(cells[i]?.text) : null);
		return {
			sales: at(idx.sales),
			operating: at(idx.operating),
			ordinary: at(idx.ordinary),
			net: at(idx.net),
		};
	};
}

const rowLabel = (cells: { text: string }[]) =>
	(cells[0]?.text ?? "").replace(/\s+/g, " ").trim();

// 「決算期」「発表日」ヘッダを持つテーブルのうち、3ヵ月実績行が最も多いものの行を返す。
// 「予」付き行 (予想)・「前年同期比」行は除外する。
function quarterRowsFrom(tables: FinanceTable[]): QuarterRow[] {
	let bestRows: QuarterRow[] = [];
	for (const t of tables) {
		if (!(t.headers.includes("決算期") && t.headers.includes("発表日")))
			continue;
		const pl = plColumns(t);
		const rows: QuarterRow[] = [];
		for (const { cells } of t.rows) {
			const label = rowLabel(cells);
			if (/予/.test(label)) continue;
			const q = parseQLabel(label);
			if (!q) continue;
			rows.push({
				q,
				announce: parseAnnounce(cells[cells.length - 1]?.text),
				...pl(cells),
			});
		}
		if (rows.length > bestRows.length) bestRows = rows;
	}
	return bestRows;
}

// 「決算期」ヘッダを持つ最初のテーブルで、通期 ("2027.03"、後ろに "-MM" が続かない) の予想行を返す。
function forecastFrom(tables: FinanceTable[]): FullYearForecast | null {
	for (const t of tables) {
		if (!t.headers.includes("決算期")) continue;
		const pl = plColumns(t);
		for (const { cells } of t.rows) {
			const label = rowLabel(cells);
			if (!/予/.test(label)) continue;
			const m = label.match(/(\d{4}\.\d{2})(?!\s*-)/);
			if (m) return { period: m[1], ...pl(cells) };
		}
	}
	return null;
}

// finance ページから3ヵ月実績行と通期予想を読む。対象は「発表日」ヘッダを持つテーブル群だけなので、
// それに絞ってから読む (流すバイト数を絞る)。無ければ全文へフォールバック。
async function parseFinance(
	html: string,
): Promise<{ quarters: QuarterRow[]; forecast: FullYearForecast | null }> {
	const tables = await scanTables(sliceTables(html, "発表日") ?? html);
	return { quarters: quarterRowsFrom(tables), forecast: forecastFrom(tables) };
}

async function extractQuarterRows(html: string): Promise<QuarterRow[]> {
	return (await parseFinance(html)).quarters;
}

function estimateFromRows(quarters: QuarterRow[]): {
	est: string | null;
	detail: string;
} {
	const rows = quarters.filter((r) => r.announce);
	if (rows.length === 0) return { est: null, detail: "no quarterly rows" };

	rows.sort((a, b) => a.q.y - b.q.y || a.q.startM - b.q.startM);
	const last = rows[rows.length - 1];

	let nextStartM = last.q.startM + 3;
	let nextStartY = last.q.y;
	if (nextStartM > 12) {
		nextStartM -= 12;
		nextStartY += 1;
	}

	const prior = rows.find(
		(r) => r.q.startM === nextStartM && r.q.y === nextStartY - 1,
	);
	if (!prior?.announce) {
		return {
			est: null,
			detail: `last=${last.q.raw}(${last.announce}) nextQ=${String(nextStartM).padStart(2, "0")}月 prior=none`,
		};
	}

	const d = new Date(`${prior.announce}T00:00:00Z`);
	d.setUTCFullYear(d.getUTCFullYear() + 1);
	const est = d.toISOString().slice(0, 10);

	return {
		est,
		detail: `last=${last.q.raw}(${last.announce}) prior=${prior.q.raw}(${prior.announce}) → ${est}`,
	};
}

// 四半期実績行から次回決算発表予定日 (YYYY-MM-DD) を推定する。
// 国内ピア (peer-earnings.ts collectJpPeerEarnings) が使う。
export async function estimateNextEarningsDate(html: string): Promise<{
	est: string | null;
	detail: string;
}> {
	return estimateFromRows(await extractQuarterRows(html));
}

/**
 * 次回決算日を決める。JPX 一覧の公表日 (announced) があればそれを estimated=false で、無ければ推定日 (est) を
 * estimated=true で返す。detail は推定の根拠に公表日を前置きしたもの。
 * 国内ピア (peer-earnings.ts collectJpPeerEarnings) も使う。
 */
export function resolveNextDate(
	announced: string | null | undefined,
	est: string | null,
	estDetail: string,
): { date: string | null; estimated: boolean; detail: string } {
	if (!announced) return { date: est, estimated: true, detail: estDetail };
	return {
		date: announced,
		estimated: false,
		// sq-context は detail の "(YYYY-MM-DD)" を過去の発表日として拾うので、予定日は括弧で囲まない。
		detail: `jpx=${announced}; ${estDetail}`,
	};
}

async function saveEarnings(
	env: EarningsEnv,
	ticker: string,
	next: { date: string | null; estimated: boolean; detail: string },
	forecast: FullYearForecast | null,
): Promise<void> {
	const fetched_at = new Date().toISOString();
	const set = {
		nextDate: next.date,
		estimated: next.estimated,
		detail: next.detail,
		forecastPeriod: forecast?.period ?? null,
		forecastSales: forecast?.sales ?? null,
		forecastOperating: forecast?.operating ?? null,
		forecastOrdinary: forecast?.ordinary ?? null,
		forecastNet: forecast?.net ?? null,
		fetchedAt: fetched_at,
	};
	await db(env.DB)
		.insert(earnings)
		.values({ ticker, ...set })
		.onConflictDoUpdate({ target: earnings.ticker, set })
		.run();
}

// 四半期実績を (ticker, period) で上書き保存する。株探が過去分を訂正したら最新が勝つ。
async function saveQuarters(
	env: EarningsEnv,
	ticker: string,
	quarters: QuarterRow[],
): Promise<void> {
	if (quarters.length === 0) return;
	const fetched_at = new Date().toISOString();
	const d = db(env.DB);
	// 1文に全行をまとめると D1 のバインド変数上限を超えうるので1行=1ステートメントで batch する。
	const stmts = quarters.map((r) => {
		const set = {
			sales: r.sales,
			operating: r.operating,
			ordinary: r.ordinary,
			net: r.net,
			announcedAt: r.announce,
			fetchedAt: fetched_at,
		};
		return d
			.insert(earningsQuarters)
			.values({ ticker, period: quarterKey(r.q), ...set })
			.onConflictDoUpdate({
				target: [earningsQuarters.ticker, earningsQuarters.period],
				set,
			});
	});
	await d.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
}

/**
 * JPX 決算発表予定日一覧を引く。一覧が取れなくても推定日で続けられるよう、失敗は例外にせず
 * 空の Map と error を返す。summary は収集レスポンスに載せる診断。
 */
export async function loadEarningsSchedule(
	env: EarningsScheduleEnv,
	codes: readonly string[],
): Promise<{ dates: Map<string, string>; summary: unknown }> {
	try {
		const { dates, files } = await fetchEarningsSchedule(
			env,
			codes,
			jstDate(Date.now()),
		);
		return { dates, summary: { files } };
	} catch (e) {
		return { dates: new Map(), summary: { error: (e as Error).message } };
	}
}

// watchlist 全銘柄 (codeFilter 指定時はその1銘柄) の次回決算予定日を JPX 一覧の公表日か推定日で決め、
// 通期予想・四半期実績と合わせて D1 に保存。
export async function collectEarnings(
	env: EarningsEnv,
	codeFilter: string | null,
): Promise<Record<string, unknown>> {
	const codes = WATCHLIST.filter((c) => !codeFilter || c === codeFilter);
	const interval = parseInt(env.MIN_INTERVAL_MS, 10) || 5000;
	const schedule = await loadEarningsSchedule(env, codes);
	const results: Record<string, unknown> = { jpx_schedule: schedule.summary };
	for (const code of codes) {
		try {
			const html = await fetchHtml(URL_FINANCE(code), env);
			const { quarters, forecast } = await parseFinance(html);
			const { est, detail } = estimateFromRows(quarters);
			const next = resolveNextDate(schedule.dates.get(code), est, detail);
			await saveEarnings(env, code, next, forecast);
			await saveQuarters(env, code, quarters);
			results[code] = {
				next_date: next.date,
				estimated: next.estimated,
				detail: next.detail,
				quarters: quarters.length,
				forecast_period: forecast?.period ?? null,
			};
		} catch (e) {
			results[code] = { error: (e as Error).message };
		}
		await sleep(interval);
	}
	return results;
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	// kabutan finance ページの3ヵ月決算表を最小再現する。
	// 「決算期」「発表日」ヘッダを持ち、実績四半期行 (YY.MM-MM + 発表日) が並ぶ。
	// 予想行 (「予」付き) と「前年同期比」注記行は推定の土台から除外される。
	const financeHtml = (
		rows: Array<[label: string, announce: string]>,
	): string =>
		[
			"<table><thead><tr><th>決算期</th><th>売上高</th><th>発表日</th></tr></thead><tbody>",
			...rows.map(
				([label, announce]) =>
					`<tr><th>${label}</th><td>1,000</td><td>${announce}</td></tr>`,
			),
			"</tbody></table>",
		].join("");

	describe("parseQLabel", () => {
		it("四半期ラベル YY.MM-MM を分解する", () => {
			expect(parseQLabel("25.04-06")).toEqual({
				y: 2025,
				startM: 4,
				endM: 6,
				raw: "25.04-06",
			});
			expect(parseQLabel("25.11-01")?.endM).toBe(1);
		});
		it("形式に合わない注記行と3ヵ月でない期間は null", () => {
			expect(parseQLabel("前年同期比")).toBeNull();
			expect(parseQLabel("通期予")).toBeNull();
			expect(parseQLabel("25.04-09")).toBeNull();
		});
	});

	describe("parseAnnounce", () => {
		it("YY/MM/DD を 20YY-MM-DD にする", () => {
			expect(parseAnnounce("26/04/30")).toBe("2026-04-30");
		});
		it("空・null・未定は null", () => {
			expect(parseAnnounce(null)).toBeNull();
			expect(parseAnnounce("")).toBeNull();
			expect(parseAnnounce("未定")).toBeNull();
		});
	});

	describe("extractQuarterRows", () => {
		it("実績行だけ拾い、予想行と注記行を除外する", async () => {
			const html = financeHtml([
				["25.04-06", "25/08/06"],
				["25.07-09", "25/11/05"],
				["前年同期比", ""], // parseQLabel が null → スキップ
				["26.04-06予", "26/08/05"], // 「予」付き → スキップ
			]);
			const rows = await extractQuarterRows(html);
			expect(rows.map((r) => r.q.raw)).toEqual(["25.04-06", "25.07-09"]);
		});
	});

	describe("parseFinance", () => {
		const html = [
			"<table><thead><tr><th>決算期</th><th>売上高</th><th>営業益</th><th>経常益</th><th>最終益</th><th>修正1株益</th><th>修正1株配</th><th>発表日</th></tr></thead><tbody>",
			"<tr><th>連 2026.03</th><td>1,128,600</td><td>520,000</td><td>516,700</td><td>375,300</td><td>515.2</td><td>59</td><td>26/04/27</td></tr>",
			"<tr><th>連 予 2027.03</th><td>1,863,000</td><td>1,030,000</td><td>1,021,500</td><td>741,500</td><td>1,027</td><td>－</td><td>26/10/28</td></tr>",
			"<tr><th>前期比</th><td>+65.1</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>",
			"</tbody></table>",
			"<table><thead><tr><th>決算期</th><th>売上高</th><th>営業益</th><th>経常益</th><th>最終益</th><th>修正1株益</th><th>売上営業損益率</th><th>発表日</th></tr></thead><tbody>",
			"<tr><th>連 25.07-09</th><td>262,000</td><td>110,000</td><td>108,000</td><td>80,000</td><td>110</td><td>42.0</td><td>25/10/29</td></tr>",
			"<tr><th>連 26.07-09</th><td>480,000</td><td>-1,500</td><td>270,000</td><td>195,000</td><td>270</td><td>－</td><td>26/10/28</td></tr>",
			"<tr><th>前年同期比</th><td>+83.2</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>",
			"</tbody></table>",
		].join("");

		it("3ヵ月実績の各利益と発表日、通期予想行を拾う", async () => {
			const { quarters, forecast } = await parseFinance(html);
			expect(quarters.map((r) => quarterKey(r.q))).toEqual([
				"2025.07-09",
				"2026.07-09",
			]);
			expect(quarters[1]).toMatchObject({
				announce: "2026-10-28",
				sales: 480000,
				operating: -1500,
				ordinary: 270000,
				net: 195000,
			});
			expect(forecast).toEqual({
				period: "2027.03",
				sales: 1863000,
				operating: 1030000,
				ordinary: 1021500,
				net: 741500,
			});
		});
		it("予想行が無ければ forecast=null", async () => {
			expect((await parseFinance(financeHtml([]))).forecast).toBeNull();
		});
	});

	describe("resolveNextDate", () => {
		it("JPX の公表日があれば推定より優先し estimated=false", () => {
			expect(
				resolveNextDate("2026-11-04", "2026-11-05", "prior=(2025-11-05)"),
			).toEqual({
				date: "2026-11-04",
				estimated: false,
				detail: "jpx=2026-11-04; prior=(2025-11-05)",
			});
		});
		it("公表日が無ければ推定日を estimated=true で返す", () => {
			expect(resolveNextDate(undefined, "2026-11-05", "d")).toEqual({
				date: "2026-11-05",
				estimated: true,
				detail: "d",
			});
			expect(resolveNextDate(null, null, "d")).toEqual({
				date: null,
				estimated: true,
				detail: "d",
			});
		});
	});

	describe("estimateNextEarningsDate", () => {
		it("直近実績の次四半期 = 前年同期の発表日 +1年 で推定する", async () => {
			// 直近 = 25.07-09。次Q開始月 = 10。前年同期 24.10-12 の発表日 25/02/04 → +1年。
			const html = financeHtml([
				["24.10-12", "25/02/04"],
				["25.04-06", "25/08/06"],
				["25.07-09", "25/11/05"],
			]);
			expect((await estimateNextEarningsDate(html)).est).toBe("2026-02-04");
		});
		it("年跨ぎ (次Q開始月が翌年) でも前年同期を正しく引く", async () => {
			// 直近 = 25.10-12 → 次Q開始月 26.01。前年同期 25.01-03 の発表日 25/05/13 → +1年。
			const html = financeHtml([
				["25.01-03", "25/05/13"],
				["25.07-09", "25/11/05"],
				["25.10-12", "26/02/04"],
			]);
			expect((await estimateNextEarningsDate(html)).est).toBe("2026-05-13");
		});
		it("前年同期の発表日が無ければ est=null", async () => {
			const html = financeHtml([["25.07-09", "25/11/05"]]);
			expect((await estimateNextEarningsDate(html)).est).toBeNull();
		});
		it("実績行ゼロなら est=null", async () => {
			expect(
				(await estimateNextEarningsDate("<table></table>")).est,
			).toBeNull();
		});
	});
}
