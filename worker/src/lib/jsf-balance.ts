// Cloudflare Worker: 日証金の貸借取引残高 (証金残) の日次収集と、judge-context の margin.jsf の組み立て。
//
// 貸借取引残高 CSV (https://www.taisyaku.jp/data/zandaka.csv) は最新の 1 申込日分を全銘柄で持つ。
// 引け後 intake (18:00) の flows で 1 回取り、watchlist 銘柄の行を D1 jsf_balance に書く。
// 週次の信用残 (margin.ts) の間を埋める日次の需給で、証金を通る分だけを数える。

import { desc, eq } from "drizzle-orm";
import { db } from "./db";
import { jsfBalance } from "./schema";
import { WATCHLIST } from "./timeseries";
import { decodeSjis, fetchBytes } from "./utils";

export interface JsfBalanceEnv {
	DB: D1Database;
	USER_AGENT: string;
}

const URL_ZANDAKA_CSV = "https://www.taisyaku.jp/data/zandaka.csv";

// 列: 申込日,決済日,銘柄コード,銘柄名,取引所区分名,上場区分,速報／確報,融資新規株数,融資返済株数,
// 融資残高株数,貸株新規株数,貸株返済株数,貸株残高株数,… (以降は金額・回転日数)。
// 列名は Shift_JIS が読めない環境 (latin1 フォールバック) で照合できないため位置で読む。
const COL = {
	date: 0,
	code: 2,
	loanNew: 7,
	loanRepay: 8,
	loanQty: 9,
	lendNew: 10,
	lendRepay: 11,
	lendQty: 12,
} as const;

export interface JsfBalanceRow {
	date: string; // 貸借申込日 YYYY-MM-DD
	loan_new: number | null;
	loan_repay: number | null;
	loan_qty: number | null;
	lend_new: number | null;
	lend_repay: number | null;
	lend_qty: number | null;
}

// 銘柄名は全角で引用されるが、カンマを含む名前でも列がずれないよう引用を解いて分割する。
function splitCsvLine(line: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quoted = false;
	for (const ch of line) {
		if (ch === '"') quoted = !quoted;
		else if (ch === "," && !quoted) {
			out.push(cur);
			cur = "";
		} else cur += ch;
	}
	out.push(cur);
	return out;
}

function toInt(raw: string | undefined): number | null {
	const s = (raw ?? "").trim();
	if (!s) return null;
	const n = Number(s);
	return Number.isInteger(n) ? n : null;
}

/**
 * 貸借取引残高 CSV から codes の行を取り出す。同じコードが複数の取引所区分で並ぶときは先頭を使う。
 * @returns code → 行。申込日が YYYY/MM/DD でない行 (見出しなど) は読まない。
 */
function parseZandakaCsv(
	text: string,
	codes: readonly string[],
): Map<string, JsfBalanceRow> {
	const out = new Map<string, JsfBalanceRow>();
	// 全行を分割すると約 5000 行で Workers 無料枠の CPU 上限 (10ms) に迫るため、コードの出現位置から
	// その行だけを切り出して読む。
	for (const code of codes) {
		const needle = `,"${code}",`;
		for (
			let at = text.indexOf(needle);
			at >= 0;
			at = text.indexOf(needle, at + 1)
		) {
			const start = text.lastIndexOf("\n", at) + 1;
			const nl = text.indexOf("\n", at);
			const c = splitCsvLine(
				text.slice(start, nl < 0 ? undefined : nl).trimEnd(),
			);
			if ((c[COL.code] ?? "").trim() !== code) continue;
			const m = (c[COL.date] ?? "").match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
			if (!m) continue;
			out.set(code, {
				date: `${m[1]}-${m[2]}-${m[3]}`,
				loan_new: toInt(c[COL.loanNew]),
				loan_repay: toInt(c[COL.loanRepay]),
				loan_qty: toInt(c[COL.loanQty]),
				lend_new: toInt(c[COL.lendNew]),
				lend_repay: toInt(c[COL.lendRepay]),
				lend_qty: toInt(c[COL.lendQty]),
			});
			break;
		}
	}
	return out;
}

/**
 * CSV を 1 回取り、watchlist 銘柄の行を (ticker, 申込日) で upsert する。
 * @returns 申込日と、CSV に載っていなかった銘柄 (missing)。CSV に該当行が 1 つも無ければ error。
 */
export async function collectJsfBalance(
	env: JsfBalanceEnv,
): Promise<Record<string, unknown>> {
	const { text } = decodeSjis(await fetchBytes(URL_ZANDAKA_CSV, env));
	const rows = parseZandakaCsv(text, WATCHLIST);
	if (rows.size === 0) return { error: "no rows" };
	const fetchedAt = new Date().toISOString();
	const d = db(env.DB);
	const stmts = [...rows].map(([code, r]) => {
		const row = {
			ticker: code,
			date: r.date,
			loanNew: r.loan_new,
			loanRepay: r.loan_repay,
			loanQty: r.loan_qty,
			lendNew: r.lend_new,
			lendRepay: r.lend_repay,
			lendQty: r.lend_qty,
			fetchedAt,
		};
		return d
			.insert(jsfBalance)
			.values(row)
			.onConflictDoUpdate({
				target: [jsfBalance.ticker, jsfBalance.date],
				set: { ...row },
			});
	});
	await d.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
	return {
		dates: [...new Set([...rows.values()].map((r) => r.date))],
		missing: WATCHLIST.filter((c) => !rows.has(c)),
	};
}

// buildJsfBalance が 5 営業日前と比べるので、その 1 本先まで読む。
const READ_ROWS = 6;

/** 銘柄の証金残を申込日の新しい順に READ_ROWS 本読む。 */
export async function readJsfBalance(
	DB: D1Database,
	code: string,
): Promise<JsfBalanceRow[]> {
	return db(DB)
		.select({
			date: jsfBalance.date,
			loan_new: jsfBalance.loanNew,
			loan_repay: jsfBalance.loanRepay,
			loan_qty: jsfBalance.loanQty,
			lend_new: jsfBalance.lendNew,
			lend_repay: jsfBalance.lendRepay,
			lend_qty: jsfBalance.lendQty,
		})
		.from(jsfBalance)
		.where(eq(jsfBalance.ticker, code))
		.orderBy(desc(jsfBalance.date))
		.limit(READ_ROWS)
		.all();
}

const diff = (
	a: number | null | undefined,
	b: number | null | undefined,
): number | null => (a != null && b != null ? a - b : null);

/**
 * 証金残の最新日と増減を margin.jsf として組む。rows は申込日の新しい順。
 * 前日比 (*_chg) はその日の新規 − 返済、5 日比 (*_chg_5d) は 5 行前の残高との差 (行が足りなければ null)。
 * @returns 行が無ければ null。
 */
export function buildJsfBalance(
	rows: JsfBalanceRow[],
): Record<string, unknown> | null {
	const cur = rows[0];
	if (!cur) return null;
	const back5 = rows[5] ?? null;
	return {
		date: cur.date,
		loan_qty: cur.loan_qty,
		loan_chg: diff(cur.loan_new, cur.loan_repay),
		loan_chg_5d: diff(cur.loan_qty, back5?.loan_qty),
		lend_qty: cur.lend_qty,
		lend_chg: diff(cur.lend_new, cur.lend_repay),
		lend_chg_5d: diff(cur.lend_qty, back5?.lend_qty),
	};
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("parseZandakaCsv", () => {
		const csv = [
			'"申込日","決済日","銘柄コード","銘柄名","取引所区分名","上場区分","速報／確報","融資新規株数","融資返済株数","融資残高株数","貸株新規株数","貸株返済株数","貸株残高株数"',
			'"2026/11/25","2026/11/27","1301","極洋","東証およびＰＴＳ",,"確報",0,100,3700,0,0,0',
			'"2026/11/25","2026/11/27","6857","アド,バンテスト","東証およびＰＴＳ",,"確報",30300,7200,446700,100,6000,100',
			'"2026/11/25","2026/11/27","6857","アドバンテスト","名証",,"確報",1,1,1,1,1,1',
		].join("\r\n");

		it("指定コードの行を取り出し、引用内のカンマで列をずらさない", () => {
			const rows = parseZandakaCsv(csv, ["6857", "285A"]);
			expect([...rows.keys()]).toEqual(["6857"]);
			expect(rows.get("6857")).toEqual({
				date: "2026-11-25",
				loan_new: 30300,
				loan_repay: 7200,
				loan_qty: 446700,
				lend_new: 100,
				lend_repay: 6000,
				lend_qty: 100,
			});
		});
		it("見出し行や空行は読まない", () => {
			expect(parseZandakaCsv('"申込日"\r\n\r\n', ["6857"]).size).toBe(0);
		});
	});

	describe("buildJsfBalance", () => {
		const row = (date: string, loan: number, lend: number): JsfBalanceRow => ({
			date,
			loan_new: 300,
			loan_repay: 100,
			loan_qty: loan,
			lend_new: 0,
			lend_repay: 50,
			lend_qty: lend,
		});

		it("行が無ければ null", () => {
			expect(buildJsfBalance([])).toBeNull();
		});
		it("前日比は当日の新規 − 返済、5 日比は 5 行前との差", () => {
			const rows = [
				row("2026-11-25", 1000, 400),
				row("2026-11-24", 900, 420),
				row("2026-11-21", 900, 420),
				row("2026-11-20", 900, 420),
				row("2026-11-19", 900, 420),
				row("2026-11-18", 700, 500),
			];
			expect(buildJsfBalance(rows)).toEqual({
				date: "2026-11-25",
				loan_qty: 1000,
				loan_chg: 200,
				loan_chg_5d: 300,
				lend_qty: 400,
				lend_chg: -50,
				lend_chg_5d: -100,
			});
		});
		it("5 行前が無ければ 5 日比は null", () => {
			const out = buildJsfBalance([row("2026-11-25", 1000, 400)]);
			expect(out?.loan_chg_5d).toBeNull();
			expect(out?.lend_chg_5d).toBeNull();
		});
	});
}
