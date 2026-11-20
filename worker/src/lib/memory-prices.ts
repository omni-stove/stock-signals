// Cloudflare Worker: メモリのスポット価格 (TrendForce DRAMeXchange) の収集と、市場コンテキスト用ブロック。
//
// DRAMeXchange のトップに載る DRAM Spot / NAND Flash Spot の表から、品目・Session Average・
// Session Change を取り memory_prices に (date, item) で upsert する。同じトップにある
// Wafer Spot などの表は公表間隔が違い前回比の意味が揃わないため取らない。

import { desc } from "drizzle-orm";
import { db } from "./db";
import { decodeEntities, scanHtml } from "./html";
import { tseBusinessDaysBetween } from "./market-calendar";
import { memoryPrices } from "./schema";
import { fetchHtml, jstDate } from "./utils";

export interface MemoryPricesEnv {
	DB: D1Database;
	USER_AGENT: string;
}

const URL_DRAMEXCHANGE = "https://www.dramexchange.com/";
const SOURCE = "DRAMeXchange";
// 最新公表日から今日までの東証営業日数がこれを超えたら stale。
const STALE_BUSINESS_DAYS = 5;
// 変化率を取る公表日の幅。
const CHANGE_WINDOW = 20;
// 品目数 (DRAM + NAND で十数品目) × 変化率の幅に余裕を持たせた読み出し行数。
const READ_LIMIT = 40 * (CHANGE_WINDOW + 5);

export interface MemoryPriceQuote {
	date: string; // JST YYYY-MM-DD
	item: string;
	sessionAvg: number;
	changePct: number | null;
}

type Section = "dram" | "nand" | "other";

// 表の見出しの直前に現れる表題で、その表がどの価格系列かを決める。最後に現れたものが効く。
const SECTION_TITLES: { re: RegExp; section: Section }[] = [
	{ re: /DRAM\s+Spot\s+Price/gi, section: "dram" },
	{ re: /(?:NAND\s+)?Flash\s+Spot\s+Price/gi, section: "nand" },
	{ re: /Wafer\s+Spot\s+Price/gi, section: "other" },
	{ re: /GDDR\s+Spot\s+Price/gi, section: "other" },
	{ re: /Contract\s+Price/gi, section: "other" },
];

const MONTHS: Record<string, number> = {
	jan: 1,
	feb: 2,
	mar: 3,
	apr: 4,
	may: 5,
	jun: 6,
	jul: 7,
	aug: 8,
	sep: 9,
	oct: 10,
	nov: 11,
	dec: 12,
};

// "Last Update: Nov 19 2026 18:10 (GMT+8)" / "Last Update:2026/11/19 18:10" を JST の暦日にする。
// 時刻があれば GMT+8 として JST に直す (台湾の 23 時台は JST で翌日になる)。読めなければ null。
export function parseLastUpdate(text: string): string | null {
	const named = text.match(
		/Last\s*Update\s*:?\s*([A-Za-z]{3,9})\.?\s*(\d{1,2}),?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/i,
	);
	const numeric = text.match(
		/Last\s*Update\s*:?\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/i,
	);
	let y: number;
	let mo: number;
	let d: number;
	let hh: string | undefined;
	let mm: string | undefined;
	if (named) {
		const m = MONTHS[named[1].slice(0, 3).toLowerCase()];
		if (!m) return null;
		y = Number(named[3]);
		mo = m;
		d = Number(named[2]);
		hh = named[4];
		mm = named[5];
	} else if (numeric) {
		y = Number(numeric[1]);
		mo = Number(numeric[2]);
		d = Number(numeric[3]);
		hh = numeric[4];
		mm = numeric[5];
	} else {
		return null;
	}
	// Date.UTC は 2/31 などを翌月へ繰り越すので、暦に無い日付はここで落とす。
	const civil = `${y}-${pad2(mo)}-${pad2(d)}`;
	if (new Date(Date.UTC(y, mo - 1, d)).toISOString().slice(0, 10) !== civil)
		return null;
	const utc = Date.UTC(
		y,
		mo - 1,
		d,
		hh === undefined ? 12 : Number(hh) - 8,
		mm === undefined ? 0 : Number(mm),
	);
	return jstDate(utc);
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

// ASCII だけ小文字にする。toLowerCase は一部の非 ASCII で長さが変わり、元 HTML との添字がずれるため。
function asciiLower(s: string): string {
	return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

// pos を含む最も内側の <table>…</table> の [開始, 終了) を返す。無ければ null。
function enclosingTable(
	lower: string,
	pos: number,
): { start: number; end: number } | null {
	let start = lower.lastIndexOf("<table", pos);
	while (start >= 0) {
		const between = lower.slice(start, pos);
		const opens = between.split("<table").length - 1;
		const closes = between.split("</table>").length - 1;
		if (opens > closes) break;
		start = lower.lastIndexOf("<table", start - 1);
	}
	if (start < 0) return null;
	// 見出しより後ろに入れ子の表は置かれない前提 (データ行はセルだけ)。
	const close = lower.indexOf("</table>", pos);
	if (close < 0) return null;
	return { start, end: close + "</table>".length };
}

function sectionAt(
	html: string,
	pos: number,
): { section: Section; at: number } | null {
	const head = html.slice(0, pos);
	let best: { section: Section; at: number } | null = null;
	for (const { re, section } of SECTION_TITLES) {
		for (const m of head.matchAll(re)) {
			const at = m.index ?? 0;
			if (!best || at > best.at) best = { section, at };
		}
	}
	return best;
}

type Cell = { text: string; down: boolean };
type RewriterElement = Parameters<
	NonNullable<NonNullable<Parameters<HTMLRewriter["on"]>[1]>["element"]>
>[0];

async function scanRows(frag: string): Promise<Cell[][]> {
	const rows: Cell[][] = [];
	let cell: Cell | null = null;
	const openCell = () => {
		cell = { text: "", down: false };
		rows[rows.length - 1]?.push(cell);
	};
	const text = (t: { text: string }) => {
		if (cell) cell.text += t.text;
	};
	// 騰落の向きを矢印画像だけで示し、数値に符号を付けない表示に備えて画像の名前も見る。
	const arrow = (e: RewriterElement) => {
		if (!cell) return;
		const name = asciiLower(
			[e.getAttribute("src"), e.getAttribute("alt"), e.getAttribute("class")]
				.filter(Boolean)
				.join(" "),
		);
		// 語頭だけを見る (CDN のホスト名 "cdn" などを下げと読まないため)。
		if (/(?:^|[^a-z])(?:down|dn|fall|decrease)/.test(name)) cell.down = true;
	};
	await scanHtml(frag, [
		[
			"tr",
			{
				element() {
					rows.push([]);
					cell = null;
				},
			},
		],
		["td", { element: openCell, text }],
		["th", { element: openCell, text }],
		["td img", { element: arrow }],
		["th img", { element: arrow }],
		["td span", { element: arrow }],
		["td font", { element: arrow }],
	]);
	for (const r of rows) for (const c of r) c.text = decodeEntities(c.text);
	return rows;
}

const squash = (s: string) => asciiLower(s.replace(/\s+/g, ""));
const tidy = (s: string) => s.replace(/\s+/g, " ").trim();

function parseNumber(s: string): number | null {
	const m = s.replace(/,/g, "").match(/[-+]?\d+(?:\.\d+)?/);
	if (!m) return null;
	const n = Number(m[0]);
	return Number.isFinite(n) ? n : null;
}

function parseChange(c: Cell): number | null {
	const n = parseNumber(c.text);
	if (n === null) return null;
	if (/[-−▼↓]/.test(c.text) || c.down) return -Math.abs(n);
	return Math.abs(n);
}

// 見出し行 (Session Average / Session Change を持つ行) から下のデータ行を品目ごとに読む。
function readQuotes(rows: Cell[][], date: string): MemoryPriceQuote[] {
	const out: MemoryPriceQuote[] = [];
	let cols: { item: number; avg: number; chg: number } | null = null;
	for (const r of rows) {
		const keys = r.map((c) => squash(c.text));
		const avg = keys.indexOf("sessionaverage");
		const chg = keys.indexOf("sessionchange");
		if (avg >= 0 && chg >= 0) {
			const item = keys.findIndex((k) => k.startsWith("item"));
			cols = { item: item >= 0 ? item : 0, avg, chg };
			continue;
		}
		if (!cols || r.length <= Math.max(cols.avg, cols.chg, cols.item)) continue;
		const item = tidy(r[cols.item].text);
		const sessionAvg = parseNumber(r[cols.avg].text);
		if (!item || sessionAvg === null || sessionAvg <= 0) continue;
		out.push({ date, item, sessionAvg, changePct: parseChange(r[cols.chg]) });
	}
	return out;
}

const HEADER_RE = /Session\s*(?:<br\s*\/?>\s*)?Average/gi;

// DRAMeXchange トップの HTML から DRAM Spot / NAND Flash Spot の品目を読む。
// 表題か "Last Update" が読めない表は日付を決められないので捨てる。
export async function parseMemoryPrices(
	html: string,
): Promise<MemoryPriceQuote[]> {
	const lower = asciiLower(html);
	const out: MemoryPriceQuote[] = [];
	let lastEnd = -1;
	for (const m of html.matchAll(HEADER_RE)) {
		const at = m.index ?? 0;
		if (at < lastEnd) continue;
		const table = enclosingTable(lower, at);
		if (!table) continue;
		lastEnd = table.end;
		const sec = sectionAt(html, at);
		if (!sec || sec.section === "other") continue;
		const date = parseLastUpdate(
			html
				.slice(Math.min(sec.at, table.start), table.end)
				.replace(/<[^>]*>/g, " ")
				.replace(/&nbsp;/g, " "),
		);
		if (!date) continue;
		const rows = await scanRows(html.slice(table.start, table.end));
		for (const q of readQuotes(rows, date)) {
			if (!out.some((o) => o.item === q.item)) out.push(q);
		}
	}
	return out;
}

export async function collectMemoryPrices(
	env: MemoryPricesEnv,
): Promise<Record<string, unknown>> {
	const quotes = await parseMemoryPrices(
		await fetchHtml(URL_DRAMEXCHANGE, env),
	);
	if (quotes.length === 0) return { error: "no rows" };
	const d = db(env.DB);
	const fetchedAt = new Date().toISOString();
	const stmts = quotes.map((q) =>
		d
			.insert(memoryPrices)
			.values({ ...q, source: SOURCE, fetchedAt })
			.onConflictDoUpdate({
				target: [memoryPrices.date, memoryPrices.item],
				set: {
					sessionAvg: q.sessionAvg,
					changePct: q.changePct,
					source: SOURCE,
					fetchedAt,
				},
			}),
	);
	await d.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
	return {
		dates: [...new Set(quotes.map((q) => q.date))],
		items: quotes.length,
	};
}

export interface MemoryPriceRow {
	date: string;
	item: string;
	session_avg: number;
	change_pct: number | null;
}

export async function readMemoryPrices(
	DB: D1Database,
): Promise<MemoryPriceRow[]> {
	return await db(DB)
		.select({
			date: memoryPrices.date,
			item: memoryPrices.item,
			session_avg: memoryPrices.sessionAvg,
			change_pct: memoryPrices.changePct,
		})
		.from(memoryPrices)
		.orderBy(desc(memoryPrices.date))
		.limit(READ_LIMIT)
		.all();
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// 品目ごとの最新公表日が STALE_BUSINESS_DAYS 以内の品目の最新値・前回比・直近 20 公表日での変化率。
// change_pct は取得元の Session Change で、欠けていれば保存済みの前回公表日の値から出す。
// change_20d_pct は 20 公表日前の値が無ければ null。
export function buildMemoryPricesBlock(
	rows: MemoryPriceRow[],
	today: string,
): Record<string, unknown> {
	if (rows.length === 0) return { status: "none" };
	const latest = rows.reduce((a, r) => (r.date > a ? r.date : a), rows[0].date);
	if (tseBusinessDaysBetween(latest, today) > STALE_BUSINESS_DAYS)
		return { status: "stale", date: latest };
	const byItem = new Map<string, MemoryPriceRow[]>();
	for (const r of rows) {
		const list = byItem.get(r.item) ?? [];
		list.push(r);
		byItem.set(r.item, list);
	}
	const pct = (now: number, before: number | undefined) =>
		before ? round2(((now - before) / before) * 100) : null;
	const items: Record<string, unknown>[] = [];
	for (const [item, list] of byItem) {
		list.sort((a, b) => (a.date < b.date ? 1 : -1));
		const [head, prev] = list;
		if (tseBusinessDaysBetween(head.date, today) > STALE_BUSINESS_DAYS)
			continue;
		items.push({
			item,
			date: head.date,
			session_avg: head.session_avg,
			change_pct: head.change_pct ?? pct(head.session_avg, prev?.session_avg),
			change_20d_pct: pct(head.session_avg, list[CHANGE_WINDOW]?.session_avg),
		});
	}
	return {
		status: "ok",
		source: SOURCE,
		unit: "USD",
		date: latest,
		items,
	};
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	// DRAMeXchange トップの表の組み (表題・Last Update・見出し行・データ行) を縮めたもの。
	const row = (item: string, avg: string, chg: string) =>
		`<tr><td class="tab_tr_l">${item}</td><td>4.900</td><td>4.300</td><td>4.800</td><td>4.400</td><td>${avg}</td><td>${chg}</td></tr>`;
	const header =
		"<tr><td>Item</td><td>Daily High</td><td>Daily Low</td><td>Session High</td><td>Session Low</td><td>Session<br>Average</td><td>Session<br>Change</td></tr>";
	const PAGE = `<html><body>
<table width="100%"><tr><td>
  <div class="title">DRAM Spot Price</div>
  <div class="update">Last Update: Nov 19 2026 18:10 (GMT+8)</div>
  <table class="tab_box">
    ${header}
    ${row("DDR5 16Gb (2Gx8) 4800/5600", "12.500", '<img src="/images/up.gif"> 1.25 %')}
    ${row("DDR4 16Gb (2Gx8) 3200", "9.875", '<img src="/images/down.gif"> 0.48 %')}
    ${row("DDR4 8Gb (1Gx8) 3200", "4.613", "-0.32 %")}
    ${row("DDR3 4Gb 512Mx8 1600/1866", "1.450", "0.00 %")}
  </table>
</td><td>
  <div class="title">NAND Flash Spot Price</div>
  <div class="update">Last Update: Nov 19 2026 18:10 (GMT+8)</div>
  <table class="tab_box">
    ${header}
    ${row("SLC 2Gb 256MBx8", "2.220", "0.45 %")}
    ${row("MLC 64Gb 8GBx8", "3.150", "--")}
  </table>
</td></tr></table>
<div class="title">Wafer Spot Price</div>
<div class="update">Last Update: Nov 19 2026 11:00 (GMT+8)</div>
<table class="tab_box">${header}${row("512Gb TLC", "4.100", "1.00 %")}</table>
</body></html>`;

	describe("parseLastUpdate", () => {
		it("GMT+8 の時刻を JST の暦日にする", () => {
			expect(parseLastUpdate("Last Update: Nov 19 2026 18:10 (GMT+8)")).toBe(
				"2026-11-19",
			);
			expect(parseLastUpdate("Last Update: Nov 19 2026 23:30 (GMT+8)")).toBe(
				"2026-11-20",
			);
		});
		it("数字の日付と時刻なしも読む", () => {
			expect(parseLastUpdate("Last Update:2026/11/19")).toBe("2026-11-19");
		});
		it("読めなければ null", () => {
			expect(parseLastUpdate("Last Update: Foo 19 2026")).toBeNull();
			expect(parseLastUpdate("Last Update: 2026/02/31")).toBeNull();
			expect(parseLastUpdate("no date")).toBeNull();
		});
	});

	describe("parseMemoryPrices", () => {
		it("DRAM / NAND Flash Spot の品目を値付きで読み、Wafer は取らない", async () => {
			expect(await parseMemoryPrices(PAGE)).toEqual([
				{
					date: "2026-11-19",
					item: "DDR5 16Gb (2Gx8) 4800/5600",
					sessionAvg: 12.5,
					changePct: 1.25,
				},
				{
					date: "2026-11-19",
					item: "DDR4 16Gb (2Gx8) 3200",
					sessionAvg: 9.875,
					changePct: -0.48,
				},
				{
					date: "2026-11-19",
					item: "DDR4 8Gb (1Gx8) 3200",
					sessionAvg: 4.613,
					changePct: -0.32,
				},
				{
					date: "2026-11-19",
					item: "DDR3 4Gb 512Mx8 1600/1866",
					sessionAvg: 1.45,
					changePct: 0,
				},
				{
					date: "2026-11-19",
					item: "SLC 2Gb 256MBx8",
					sessionAvg: 2.22,
					changePct: 0.45,
				},
				{
					date: "2026-11-19",
					item: "MLC 64Gb 8GBx8",
					sessionAvg: 3.15,
					changePct: null,
				},
			]);
		});
		it("Last Update が読めない表は捨てる", async () => {
			const html = `<div>DRAM Spot Price</div><table>${header}${row("DDR4 8Gb (1Gx8) 3200", "4.613", "0.10 %")}</table>`;
			expect(await parseMemoryPrices(html)).toEqual([]);
		});
		it("見出しが無いページは空", async () => {
			expect(
				await parseMemoryPrices("<html><body>maintenance</body></html>"),
			).toEqual([]);
		});
	});

	describe("buildMemoryPricesBlock", () => {
		const series = (item: string, n: number, start: number, step: number) => {
			const out: MemoryPriceRow[] = [];
			let d = "2026-11-19";
			for (let i = 0; i < n; i++) {
				out.push({
					date: d,
					item,
					session_avg: start - step * i,
					change_pct: i === 0 ? 0.5 : null,
				});
				// 平日だけを公表日として遡る。
				do {
					const t = new Date(`${d}T12:00:00Z`);
					t.setUTCDate(t.getUTCDate() - 1);
					d = t.toISOString().slice(0, 10);
				} while ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()));
			}
			return out;
		};

		it("品目ごとに最新値・前回比・20 公表日前比を返す", () => {
			const rows = [
				...series("DDR5 16Gb (2Gx8) 4800/5600", 21, 12, 0.1),
				...series("DDR4 8Gb (1Gx8) 3200", 2, 4.6, 0.1).map((r) => ({
					...r,
					change_pct: null,
				})),
			];
			const out = buildMemoryPricesBlock(rows, "2026-11-20");
			expect(out).toEqual({
				status: "ok",
				source: "DRAMeXchange",
				unit: "USD",
				date: "2026-11-19",
				items: [
					{
						item: "DDR5 16Gb (2Gx8) 4800/5600",
						session_avg: 12,
						change_pct: 0.5,
						change_20d_pct: 20,
					},
					{
						item: "DDR4 8Gb (1Gx8) 3200",
						session_avg: 4.6,
						change_pct: 2.22,
						change_20d_pct: null,
					},
				],
			});
		});
		it("最新日が 5 営業日を超えて古い品目は出さず、公表日がずれた品目は両方出す", () => {
			const rows = [
				{ date: "2026-11-19", item: "A", session_avg: 1, change_pct: 0 },
				{ date: "2026-11-18", item: "B", session_avg: 2, change_pct: 0 },
				{ date: "2026-11-10", item: "C", session_avg: 3, change_pct: 0 },
			];
			const out = buildMemoryPricesBlock(rows, "2026-11-20");
			expect((out.items as { item: string }[]).map((i) => i.item)).toEqual([
				"A",
				"B",
			]);
		});
		it("行なしは none、5 営業日超の古さは stale", () => {
			expect(buildMemoryPricesBlock([], "2026-11-20")).toEqual({
				status: "none",
			});
			const rows = [
				{ date: "2026-11-12", item: "A", session_avg: 1, change_pct: 0 },
			];
			expect(buildMemoryPricesBlock(rows, "2026-11-19").status).toBe("ok");
			expect(buildMemoryPricesBlock(rows, "2026-11-20")).toEqual({
				status: "stale",
				date: "2026-11-12",
			});
		});
	});
}
