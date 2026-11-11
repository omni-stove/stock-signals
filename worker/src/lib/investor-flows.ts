// Cloudflare Worker: 投資部門別売買状況 (JPX 週次) の収集と、judge-context / market-context 用ブロック。
//
// JPX の「投資部門別 株式売買状況」週次 xlsx (stock_1_w_<週初>_<週末>.xlsx) を読み、東証プライムの
// 金額行から部門ごとの差引き (買い−売り、億円) を investor_flows に貯める。公表は翌週第 4 営業日の
// 午後なので、eod で index ページを見て未取得の週だけ取る。市場全体の数字で、銘柄別ではない。

import { desc, inArray } from "drizzle-orm";
import { db } from "./db";
import { unzipText } from "./inflate";
import { investorFlows } from "./schema";
import { fetchHtml } from "./utils";

export interface InvestorFlowsEnv {
	DB: D1Database;
	USER_AGENT: string;
}

const URL_JPX_INVESTOR =
	"https://www.jpx.co.jp/markets/statistics-equities/investor-type/index.html";
const JPX_ORIGIN = "https://www.jpx.co.jp";
// 未取得なら遡って取る週数 (連続買い越し/売り越しの週数を数えられる程度)。
const WEEKS_BACK = 4;

// 部門 → 見出し行での表記。span は「その見出しから同じ行の次の見出しまで」の列範囲で、
// 範囲内の「差引」列を合算する (海外投資家 = 法人 + 個人、個人 = 現金 + 信用 など)。
const INVESTORS: { key: string; label: string }[] = [
	{ key: "foreigners", label: "海外投資家" },
	{ key: "individuals", label: "個人" },
	{ key: "trust_banks", label: "信託銀行" },
	{ key: "investment_trusts", label: "投資信託" },
	{ key: "business_cos", label: "事業法人" },
	{ key: "proprietary", label: "自己" },
];

function parseInvestorLinks(
	html: string,
): { weekStart: string; weekEnd: string; url: string }[] {
	const out: { weekStart: string; weekEnd: string; url: string }[] = [];
	const ymd = (s: string) =>
		`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
	for (const m of html.matchAll(
		/href="([^"]*\/stock_1_w_(\d{8})_(\d{8})\.xlsx)"/g,
	)) {
		const weekStart = ymd(m[2]);
		if (out.some((o) => o.weekStart === weekStart)) continue;
		out.push({
			weekStart,
			weekEnd: ymd(m[3]),
			url: new URL(m[1], JPX_ORIGIN).toString(),
		});
	}
	return out.sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1));
}

// 列名 (A, B, …, AA) ⇄ 0 始まりの番号。
function colIndex(col: string): number {
	let n = 0;
	for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}

function decodeXml(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

// シートを行番号 → (列番号 → 値) に読む。共有文字列は解決済み、数値は文字列のまま。
function readSheet(
	sheetXml: string,
	sharedXml: string,
): Map<number, Map<number, string>> {
	const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
		decodeXml(
			[...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => t[1]).join(""),
		),
	);
	const rows = new Map<number, Map<number, string>>();
	for (const m of sheetXml.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
		const ref = m[1].match(/\br="([A-Z]+)(\d+)"/);
		const v = m[2]?.match(/<v>([^<]*)<\/v>/);
		if (!ref || !v) continue;
		const value = /\bt="s"/.test(m[1])
			? (shared[Number(v[1])] ?? "")
			: decodeXml(v[1]);
		const r = Number(ref[2]);
		if (!rows.has(r)) rows.set(r, new Map());
		rows.get(r)?.set(colIndex(ref[1]), value);
	}
	return rows;
}

// 東証プライムの金額行から部門ごとの差引き (億円) を出す。読めなければ null。
function parseInvestorSheet(
	rows: Map<number, Map<number, string>>,
): Record<string, number> | null {
	const rowNums = [...rows.keys()].sort((a, b) => a - b);
	const find = (pred: (cells: Map<number, string>) => boolean) =>
		rowNums.find((r) => pred(rows.get(r) ?? new Map()));
	const startsWith = (v: string | undefined, p: string) =>
		(v ?? "").trim().startsWith(p);

	const balanceRow = find(
		(c) => [...c.values()].filter((v) => startsWith(v, "差引")).length >= 3,
	);
	const primeRow = find((c) => startsWith(c.get(1), "東証プライム"));
	if (balanceRow === undefined || primeRow === undefined) return null;
	const valueRow = rowNums.find(
		(r) => r >= primeRow && startsWith(rows.get(r)?.get(2), "金額"),
	);
	if (valueRow === undefined) return null;
	const balanceCols = [...(rows.get(balanceRow)?.entries() ?? [])]
		.filter(([, v]) => startsWith(v, "差引"))
		.map(([c]) => c);
	const values = rows.get(valueRow) ?? new Map();

	const out: Record<string, number> = {};
	for (const { key, label } of INVESTORS) {
		// 見出し行は差引行より上。最初にラベルが現れる行と列を探す。
		let span: [number, number] | null = null;
		for (const r of rowNums) {
			if (r >= balanceRow) break;
			const cells = [...(rows.get(r)?.entries() ?? [])].sort(
				(a, b) => a[0] - b[0],
			);
			const i = cells.findIndex(([, v]) => startsWith(v, label));
			if (i < 0) continue;
			span = [cells[i][0], cells[i + 1]?.[0] ?? Number.POSITIVE_INFINITY];
			break;
		}
		if (!span) continue;
		const [from, to] = span;
		const cols = balanceCols.filter((c) => c >= from && c < to);
		if (cols.length === 0) continue;
		const sen = cols.reduce((a, c) => a + Number(values.get(c) ?? 0), 0);
		// 千円 → 億円
		out[key] = Math.round(sen / 10_000) / 10;
	}
	return Object.keys(out).length > 0 ? out : null;
}

export async function collectInvestorFlows(
	env: InvestorFlowsEnv,
): Promise<Record<string, unknown>> {
	const links = parseInvestorLinks(
		await fetchHtml(URL_JPX_INVESTOR, env),
	).slice(0, WEEKS_BACK);
	if (links.length === 0) return { error: "no links" };
	const d = db(env.DB);
	const have = new Set(
		(
			await d
				.selectDistinct({ weekStart: investorFlows.weekStart })
				.from(investorFlows)
				.where(
					inArray(
						investorFlows.weekStart,
						links.map((l) => l.weekStart),
					),
				)
				.all()
		).map((r) => r.weekStart),
	);
	const written: string[] = [];
	for (const l of links) {
		if (have.has(l.weekStart)) continue;
		const res = await fetch(l.url, {
			headers: { "User-Agent": env.USER_AGENT },
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) continue;
		const zip = new Uint8Array(await res.arrayBuffer());
		const sheet = await unzipText(zip, "xl/worksheets/sheet1.xml");
		const shared = await unzipText(zip, "xl/sharedStrings.xml");
		if (!sheet || !shared) continue;
		const nets = parseInvestorSheet(readSheet(sheet, shared));
		if (!nets) continue;
		const fetchedAt = new Date().toISOString();
		const stmts = Object.entries(nets).map(([investor, netValue]) =>
			d
				.insert(investorFlows)
				.values({
					weekStart: l.weekStart,
					weekEnd: l.weekEnd,
					investor,
					netValue,
					fetchedAt,
				})
				.onConflictDoNothing(),
		);
		await d.batch(
			stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]],
		);
		written.push(l.weekStart);
	}
	return { written };
}

export interface InvestorFlowRow {
	week_start: string;
	week_end: string;
	investor: string;
	net_value: number;
}

// 最新週の部門別差引きと、海外投資家・個人の連続買い越し/売り越し週数。
export function buildInvestorFlows(
	rows: InvestorFlowRow[],
): Record<string, unknown> {
	if (rows.length === 0) return { status: "unavailable" };
	const weeks = [...new Set(rows.map((r) => r.week_start))].sort().reverse();
	const latest = weeks[0];
	const net = (week: string, investor: string) =>
		rows.find((r) => r.week_start === week && r.investor === investor)
			?.net_value ?? null;
	const streak = (investor: string): number => {
		const first = net(latest, investor);
		if (first == null || first === 0) return 0;
		let n = 0;
		for (const w of weeks) {
			const v = net(w, investor);
			if (v == null || Math.sign(v) !== Math.sign(first)) break;
			n++;
		}
		return Math.sign(first) * n;
	};
	const latestRows = rows.filter((r) => r.week_start === latest);
	return {
		status: "ok",
		market: "東証プライム",
		unit: "億円",
		week_start: latest,
		week_end: latestRows[0]?.week_end ?? null,
		net: Object.fromEntries(latestRows.map((r) => [r.investor, r.net_value])),
		// 正 = 連続買い越し週数、負 = 連続売り越し週数 (保存済みの週の範囲で数える)。
		foreigners_streak_weeks: streak("foreigners"),
		individuals_streak_weeks: streak("individuals"),
	};
}

export async function readInvestorFlows(
	DB: D1Database,
): Promise<InvestorFlowRow[]> {
	return await db(DB)
		.select({
			week_start: investorFlows.weekStart,
			week_end: investorFlows.weekEnd,
			investor: investorFlows.investor,
			net_value: investorFlows.netValue,
		})
		.from(investorFlows)
		.orderBy(desc(investorFlows.weekStart))
		.limit(INVESTORS.length * 8)
		.all();
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("parseInvestorLinks", () => {
		it("週次 xlsx のリンクを新しい週順に並べる", () => {
			const html = `<a href="/m/a-att/stock_1_w_20261019_20261023.xlsx">x</a>
				<a href="/m/a-att/stock_1_w_20261019_20261023.pdf">p</a>
				<a href="/m/b-att/stock_1_w_20261026_20261030.xlsx">x</a>`;
			expect(parseInvestorLinks(html)).toEqual([
				{
					weekStart: "2026-10-26",
					weekEnd: "2026-10-30",
					url: "https://www.jpx.co.jp/m/b-att/stock_1_w_20261026_20261030.xlsx",
				},
				{
					weekStart: "2026-10-19",
					weekEnd: "2026-10-23",
					url: "https://www.jpx.co.jp/m/a-att/stock_1_w_20261019_20261023.xlsx",
				},
			]);
		});
	});

	describe("readSheet / parseInvestorSheet", () => {
		// JPX の様式を縮めたもの: 自己 (D-G) / 個人 (H-K) / 海外投資家 (L-O: 法人 L, 個人 N) / 法人 (P-: 投資信託 P, 信託銀行 R)。
		const shared = [
			"自己",
			"個人",
			"海外投資家 Foreigners",
			"法人",
			"投資信託",
			"信託銀行",
			"差引 Balance",
			"東証プライム\nTSE Prime",
			"株数",
			"金額",
			"売",
		];
		const sharedXml = `<sst>${shared.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`;
		const c = (ref: string, v: string | number, s = false) =>
			`<c r="${ref}"${s ? ' t="s"' : ""}><v>${v}</v></c>`;
		const sheetXml = [
			`<row r="4">${c("D4", 0, true)}${c("H4", 1, true)}${c("L4", 2, true)}${c("P4", 3, true)}</row>`,
			`<row r="5">${c("P5", 4, true)}${c("R5", 5, true)}</row>`,
			`<row r="7">${c("D7", 10, true)}${c("E7", 6, true)}${c("I7", 6, true)}${c("M7", 6, true)}${c("O7", 6, true)}${c("Q7", 6, true)}${c("S7", 6, true)}</row>`,
			`<row r="8">${c("B8", 7, true)}${c("C8", 8, true)}${c("E8", 1)}${c("M8", 999)}</row>`,
			`<row r="9">${c("C9", 9, true)}${c("E9", -50_000_000)}${c("I9", 1_000_000)}${c("M9", 207_814_267)}${c("O9", -1_502_618)}${c("Q9", 10_000_000)}${c("S9", -29_305_128)}</row>`,
		].join("");

		it("プライム金額行の差引きを部門ごとに合算して億円にする", () => {
			expect(parseInvestorSheet(readSheet(sheetXml, sharedXml))).toEqual({
				proprietary: -500,
				individuals: 10,
				foreigners: 2063.1,
				investment_trusts: 100,
				trust_banks: -293.1,
			});
		});
		it("様式が読めなければ null", () => {
			expect(parseInvestorSheet(readSheet("<row/>", sharedXml))).toBeNull();
		});
	});

	describe("buildInvestorFlows", () => {
		const row = (w: string, investor: string, v: number) => ({
			week_start: w,
			week_end: w,
			investor,
			net_value: v,
		});
		it("最新週の差引きと連続週数", () => {
			const out = buildInvestorFlows([
				row("2026-10-26", "foreigners", 2063),
				row("2026-10-26", "individuals", -78),
				row("2026-10-19", "foreigners", 500),
				row("2026-10-19", "individuals", 100),
				row("2026-10-12", "foreigners", -300),
			]);
			expect(out.week_start).toBe("2026-10-26");
			expect(out.net).toEqual({ foreigners: 2063, individuals: -78 });
			expect(out.foreigners_streak_weeks).toBe(2);
			expect(out.individuals_streak_weeks).toBe(-1);
		});
		it("行なしは unavailable", () => {
			expect(buildInvestorFlows([])).toEqual({ status: "unavailable" });
		});
	});
}
