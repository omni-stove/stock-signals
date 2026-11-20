// Cloudflare Worker: SEAJ の日本製半導体製造装置 販売高 (速報) の収集と、市場コンテキスト用ブロック。
//
// SEAJ 統計ページのプレスリリース表から「販売高速報値(3ヶ月平均) 半導体製造装置（日本製）YYYY年M月度」
// の PDF を取り、表の月・販売高・前月比・前年比を seaj_sales に month で upsert する。
// 同じページの Excel は旧形式 (BIFF) で xlsx.ts では読めないため PDF を使う。

import { desc } from "drizzle-orm";
import { db } from "./db";
import { scanTables } from "./html";
import { extractPdfText } from "./pdf-text";
import { seajSales } from "./schema";

export interface SeajSalesEnv {
	DB: D1Database;
	USER_AGENT: string;
}

const URL_STATS = "https://www.seaj.or.jp/statistics/";
const SOURCE = "SEAJ";
const FETCH_TIMEOUT_MS = 20_000;
// 最新月の月末から今日までの日数がこれを超えたら stale。速報は翌月下旬に出るので 1 回の取り逃しまでは許す。
const STALE_DAYS = 60;
const TREND_MONTHS = 3;
// 前年同月比を保存済みの行から出すのに 12 か月前まで要る。
const READ_LIMIT = 24;

export interface SeajRelease {
	month: string; // 対象月 YYYY-MM
	pdfUrl: string;
	publishedAt: string | null; // リリース日 YYYY-MM-DD
}

export interface SeajSalesRow {
	month: string;
	sales: number; // 億円
	yoy_pct: number | null;
	mom_pct: number | null;
	published_at: string | null;
}

const pad2 = (n: number | string) => String(n).padStart(2, "0");
const round2 = (n: number) => Math.round(n * 100) / 100;

function shiftMonth(month: string, n: number): string {
	const [y, m] = month.split("-").map(Number);
	const d = new Date(Date.UTC(y, m - 1 + n, 1));
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

const RELEASE_TITLE =
	/販売高速報値[\s\S]*?半導体製造装置\s*[（(]\s*日本製\s*[)）]\s*(\d{4})\s*年\s*(\d{1,2})\s*月度/;
const RELEASE_DATE = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/;

/**
 * SEAJ 統計ページの HTML (デコード済み) から、日本製半導体製造装置の販売高速報 PDF のうち
 * 対象月が最も新しいものを返す。PDF の URL は baseUrl で絶対化する。見つからなければ null。
 */
export async function parseSeajRelease(
	html: string,
	baseUrl: string,
): Promise<SeajRelease | null> {
	let best: SeajRelease | null = null;
	for (const table of await scanTables(html)) {
		for (const row of table.rows) {
			const title = row.cells[0]?.text.match(RELEASE_TITLE);
			if (!title) continue;
			const href = row.cells.find((c) =>
				c.aHref?.toLowerCase().split(/[?#]/)[0].endsWith(".pdf"),
			)?.aHref;
			if (!href) continue;
			const month = `${title[1]}-${pad2(title[2])}`;
			if (best && best.month >= month) continue;
			const date = row.cells
				.slice(1)
				.map((c) => c.text.match(RELEASE_DATE))
				.find((m) => m);
			best = {
				month,
				pdfUrl: new URL(href, baseUrl).toString(),
				publishedAt: date
					? `${date[1]}-${pad2(date[2])}-${pad2(date[3])}`
					: null,
			};
		}
	}
	return best;
}

export interface ParsedSeajMonth {
	month: string;
	sales: number; // 億円
	yoyPct: number | null;
	momPct: number | null;
}

const UNIT_RE = /単位\s*[:：]\s*(百万円|億円)/;
const UNIT_TO_OKU: Record<string, number> = { 百万円: 100, 億円: 1 };
const ROW_RE =
	/^[ \t]*(\d{4})\/(\d{1,2})(?:[ \t]*[(（][^)）\n]*[)）])?[ \t]+([\d,]+(?:\.\d+)?)((?:[ \t]+[-−▲]?\d+(?:\.\d+)?[ \t]*[%％])*)[ \t]*$/gm;
const PCT_RE = /([-−▲]?)(\d+(?:\.\d+)?)\s*[%％]/g;

/**
 * 速報 PDF のテキストから表の各月 (販売高・前月比・前年比) を読む。販売高は億円に直す。
 * 単位か列見出し (前月比・前年比) が読めなければ空配列。比率が 2 列揃わない行は比率を null にする。
 */
export function parseSeajSalesText(text: string): ParsedSeajMonth[] {
	const unit = text.match(UNIT_RE);
	if (!unit) return [];
	const head = text.slice(unit.index ?? 0);
	const mom = head.search(/前月比/);
	const yoy = head.search(/前年(?:同月)?比/);
	if (mom < 0 || yoy < 0) return [];
	const momFirst = mom < yoy;
	const divisor = UNIT_TO_OKU[unit[1]];
	const out: ParsedSeajMonth[] = [];
	for (const m of head.matchAll(ROW_RE)) {
		const month = `${m[1]}-${pad2(m[2])}`;
		if (out.some((o) => o.month === month)) continue;
		const pcts = [...m[4].matchAll(PCT_RE)].map(
			(p) => (p[1] ? -1 : 1) * Number(p[2]),
		);
		const [a, b] = pcts.length === 2 ? pcts : [null, null];
		out.push({
			month,
			sales: round2(Number(m[3].replace(/,/g, "")) / divisor),
			momPct: momFirst ? a : b,
			yoyPct: momFirst ? b : a,
		});
	}
	return out;
}

/**
 * 欠けた前年同月比・前月比を、同じ速報の他の月か保存済みの行の販売高から出して埋める。
 * 比較する月の販売高が無ければ null のまま。
 */
export function fillSeajChanges(
	parsed: ParsedSeajMonth[],
	stored: SeajSalesRow[],
): ParsedSeajMonth[] {
	const sales = new Map(stored.map((r) => [r.month, r.sales]));
	for (const p of parsed) sales.set(p.month, p.sales);
	const pct = (now: number, month: string) => {
		const before = sales.get(month);
		return before ? round2(((now - before) / before) * 100) : null;
	};
	return parsed.map((p) => ({
		...p,
		yoyPct: p.yoyPct ?? pct(p.sales, shiftMonth(p.month, -12)),
		momPct: p.momPct ?? pct(p.sales, shiftMonth(p.month, -1)),
	}));
}

async function fetchBytes(
	url: string,
	env: { USER_AGENT: string },
): Promise<Uint8Array> {
	const res = await fetch(url, {
		headers: { "User-Agent": env.USER_AGENT },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	return new Uint8Array(await res.arrayBuffer());
}

/**
 * SEAJ の最新の販売高速報を取り、載っている全月を seaj_sales に upsert する。
 * 戻り値は対象月・リリース日・保存行数、取れなければ { error }。
 */
export async function collectSeajSales(
	env: SeajSalesEnv,
): Promise<Record<string, unknown>> {
	// 統計ページは Shift_JIS。表題の日本語で行を選ぶので latin1 へは落とせない。
	const html = new TextDecoder("shift_jis").decode(
		await fetchBytes(URL_STATS, env),
	);
	const release = await parseSeajRelease(html, URL_STATS);
	if (!release) return { error: "release not found" };
	if (new URL(release.pdfUrl).host !== new URL(URL_STATS).host)
		return { error: `unexpected host ${release.pdfUrl}` };
	const parsed = parseSeajSalesText(
		await extractPdfText(await fetchBytes(release.pdfUrl, env)),
	);
	if (parsed.length === 0) return { error: "no rows", pdf: release.pdfUrl };
	const rows = fillSeajChanges(parsed, await readSeajSales(env.DB));
	const d = db(env.DB);
	const fetchedAt = new Date().toISOString();
	const stmts = rows.map((r) => {
		const values = {
			sales: r.sales,
			yoyPct: r.yoyPct,
			momPct: r.momPct,
			publishedAt: release.publishedAt,
			source: SOURCE,
			fetchedAt,
		};
		return d
			.insert(seajSales)
			.values({ month: r.month, ...values })
			.onConflictDoUpdate({ target: seajSales.month, set: values });
	});
	await d.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
	return {
		month: release.month,
		published_at: release.publishedAt,
		rows: rows.length,
	};
}

/** seaj_sales を新しい月から READ_LIMIT 行読む。 */
export async function readSeajSales(DB: D1Database): Promise<SeajSalesRow[]> {
	return await db(DB)
		.select({
			month: seajSales.month,
			sales: seajSales.sales,
			yoy_pct: seajSales.yoyPct,
			mom_pct: seajSales.momPct,
			published_at: seajSales.publishedAt,
		})
		.from(seajSales)
		.orderBy(desc(seajSales.month))
		.limit(READ_LIMIT)
		.all();
}

function daysSinceMonthEnd(month: string, today: string): number {
	const [y, m] = month.split("-").map(Number);
	return (Date.parse(today) - Date.UTC(y, m, 0)) / 86_400_000;
}

/**
 * 最新月の販売高 (億円・3 か月移動平均)・前年同月比・前月比と、直近 TREND_MONTHS か月の
 * 前年同月比の推移 (古い月から) を返す。行が無ければ status: none、最新月の月末から
 * STALE_DAYS 日を超えていれば status: stale。
 */
export function buildSeajSalesBlock(
	rows: SeajSalesRow[],
	today: string,
): Record<string, unknown> {
	if (rows.length === 0) return { status: "none" };
	const sorted = [...rows].sort((a, b) => (a.month < b.month ? 1 : -1));
	const head = sorted[0];
	if (daysSinceMonthEnd(head.month, today) > STALE_DAYS)
		return { status: "stale", month: head.month };
	return {
		status: "ok",
		source: SOURCE,
		unit: "億円",
		basis: "3か月移動平均",
		month: head.month,
		published_at: head.published_at,
		sales: head.sales,
		yoy_pct: head.yoy_pct,
		mom_pct: head.mom_pct,
		yoy_trend: sorted
			.slice(0, TREND_MONTHS)
			.reverse()
			.map((r) => ({ month: r.month, yoy_pct: r.yoy_pct })),
	};
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	// SEAJ 統計ページ (2026-11 取得) のプレスリリース表と Excel 表の行をそのまま抜いたもの。
	const LISTING = `<table><thead><tr><th>資料内容</th><th>データ</th><th>リリース日</th></tr></thead><tbody>
<tr><td class="lft">販売高速報値(3ヶ月平均) <br>半導体製造装置（日本製）2026年9月度</td><td class="cntr"><a href="87971401208413.pdf" target="_blank" rel="nofollow"><img src="../common/images/bt_pdf.jpg" alt=""></a></td><td class="cntr">2026年10月23日</td></tr><tr><td class="lft">販売高速報値(3ヶ月平均)<br> FPD製造装置（日本製）2026年9月度</td><td class="cntr"><a href="8697576848148.pdf" target="_blank" rel="nofollow"><img src="../common/images/bt_pdf.jpg" alt=""></a></td><td class="cntr">2026年10月23日</td></tr><tr><td class="lft">世界統計（WorldWide SEMS Report）</td><td class="cntr"><a href="5197541811024.pdf" target="_blank" rel="nofollow"><img src="../common/images/bt_pdf.jpg" alt=""></a></td><td class="cntr">2026年9月4日</td></tr>
</tbody></table>
<table><thead><tr><th>資料内容</th><th>データ</th></tr></thead><tbody>
<tr><td class="lft">販売高速報値(3ヶ月平均)<br> 半導体</td><td class="cntr"><a href="3697614531024.xls" target="_blank" rel="nofollow"><img src="../common/images/bt_excel.jpg" alt=""></a></td></tr>
</tbody></table>`;

	// 2026年9月度速報 PDF を extractPdfText で読んだテキストの表の部分。
	const PDF_TEXT = `日本製 半導体製造装置 2026 年 9 月度の販売高は 629,040 百万円
単位：百万円
販売
(3 ヶ月平均)
前月比
(％)
前年比
(％)
2026/4 510,155 6.2% 14.1%
2026/5 526,352 3.2% 17.9%
2026/6 513,610 -2.4% 26.9%
2026/7 556,220 8.3% 35.4%
2026/8(確定値) 597,915 7.5% 47.4%
2026/9(暫定値) 629,040 5.2% 48.2%
本データは速報値(3 ヶ月移動平均)です。`;

	describe("parseSeajRelease", () => {
		it("半導体製造装置の速報 PDF と対象月・リリース日を取る", async () => {
			expect(await parseSeajRelease(LISTING, URL_STATS)).toEqual({
				month: "2026-09",
				pdfUrl: "https://www.seaj.or.jp/statistics/87971401208413.pdf",
				publishedAt: "2026-10-23",
			});
		});
		it("FPD や Excel の行しか無ければ null", async () => {
			const html = LISTING.replace(
				"半導体製造装置（日本製）",
				"FPD製造装置（日本製）",
			);
			expect(await parseSeajRelease(html, URL_STATS)).toBeNull();
		});
	});

	describe("parseSeajSalesText", () => {
		it("実 PDF の表から各月の販売高 (億円)・前年比・前月比を読む", () => {
			const rows = parseSeajSalesText(PDF_TEXT);
			expect(rows).toHaveLength(6);
			expect(rows.at(-1)).toEqual({
				month: "2026-09",
				sales: 6290.4,
				yoyPct: 48.2,
				momPct: 5.2,
			});
			expect(rows[2]).toEqual({
				month: "2026-06",
				sales: 5136.1,
				yoyPct: 26.9,
				momPct: -2.4,
			});
		});
		it("列の並びが前年比→前月比でも見出しに従う", () => {
			const swapped = PDF_TEXT.replace("前月比", "@@")
				.replace("前年比", "前月比")
				.replace("@@", "前年比");
			expect(parseSeajSalesText(swapped).at(-1)).toMatchObject({
				yoyPct: 5.2,
				momPct: 48.2,
			});
		});
		it("単位が億円ならそのまま、▲ は負", () => {
			const text = "単位：億円\n前月比 前年比\n2026/9 6,290.4 ▲1.5% 48.2%";
			expect(parseSeajSalesText(text)).toEqual([
				{ month: "2026-09", sales: 6290.4, momPct: -1.5, yoyPct: 48.2 },
			]);
		});
		it("比率が欠けた行は null、単位が読めなければ空", () => {
			expect(
				parseSeajSalesText("単位：百万円\n前月比 前年比\n2026/9 629,040"),
			).toEqual([
				{ month: "2026-09", sales: 6290.4, momPct: null, yoyPct: null },
			]);
			expect(parseSeajSalesText(PDF_TEXT.replace("単位：百万円", ""))).toEqual(
				[],
			);
		});
	});

	describe("fillSeajChanges", () => {
		it("欠けた比率を同じ速報と保存済みの行から出す", () => {
			const parsed = [
				{ month: "2026-08", sales: 5979.15, yoyPct: 47.4, momPct: 7.5 },
				{ month: "2026-09", sales: 6290.4, yoyPct: null, momPct: null },
			];
			const stored: SeajSalesRow[] = [
				{
					month: "2025-09",
					sales: 4245.9,
					yoy_pct: null,
					mom_pct: null,
					published_at: null,
				},
			];
			expect(fillSeajChanges(parsed, stored)[1]).toEqual({
				month: "2026-09",
				sales: 6290.4,
				yoyPct: 48.15,
				momPct: 5.21,
			});
			expect(fillSeajChanges(parsed, [])[1].yoyPct).toBeNull();
		});
	});

	describe("buildSeajSalesBlock", () => {
		const row = (month: string, sales: number, yoy: number): SeajSalesRow => ({
			month,
			sales,
			yoy_pct: yoy,
			mom_pct: 1,
			published_at: "2026-10-23",
		});
		const rows = [
			row("2026-07", 5562.2, 35.4),
			row("2026-09", 6290.4, 48.2),
			row("2026-06", 5136.1, 26.9),
			row("2026-08", 5979.15, 47.4),
		];
		it("最新月の値と直近 3 か月の前年同月比を古い月から返す", () => {
			expect(buildSeajSalesBlock(rows, "2026-11-20")).toEqual({
				status: "ok",
				source: "SEAJ",
				unit: "億円",
				basis: "3か月移動平均",
				month: "2026-09",
				published_at: "2026-10-23",
				sales: 6290.4,
				yoy_pct: 48.2,
				mom_pct: 1,
				yoy_trend: [
					{ month: "2026-07", yoy_pct: 35.4 },
					{ month: "2026-08", yoy_pct: 47.4 },
					{ month: "2026-09", yoy_pct: 48.2 },
				],
			});
		});
		it("最新月の月末から 60 日を超えたら stale、行が無ければ none", () => {
			expect(buildSeajSalesBlock(rows, "2026-11-29").status).toBe("ok");
			expect(buildSeajSalesBlock(rows, "2026-11-30")).toEqual({
				status: "stale",
				month: "2026-09",
			});
			expect(buildSeajSalesBlock([], "2026-11-20")).toEqual({ status: "none" });
		});
	});
}
