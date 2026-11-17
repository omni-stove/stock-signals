// Cloudflare Worker: 空売りまわりの需給データの収集と、judge-context 用ブロックの組み立て。
//
//   - 逆日歩 (日証金の品貸料率一覧 CSV)        → stock_lending
//   - 機関の空売り残高報告 (karauri.net 銘柄別) → short_positions
//   - 東証全体の空売り比率 (JPX 日次 PDF)       → market_short_ratio
//
// いずれも引け後 (eod) に取る。公表は当日夕方〜翌日なので、eod で拾えるのは前営業日分になりうる。

import { desc, eq, gte } from "drizzle-orm";
import { db } from "./db";
import { scanTables } from "./html";
import { pdfStreams } from "./inflate";
import { marketShortRatio, shortPositions, stockLending } from "./schema";
import { WATCHLIST } from "./timeseries";
import { fetchHtml, sleep } from "./utils";

export interface ShortInterestEnv {
	DB: D1Database;
	USER_AGENT: string;
	MIN_INTERVAL_MS: string;
}

const URL_LENDING_CSV = "https://www.taisyaku.jp/data/shina.csv";
const URL_KARAURI = (code: string) => `https://karauri.net/${code}/`;
const URL_JPX_SHORT =
	"https://www.jpx.co.jp/markets/statistics-equities/short-selling/index.html";
const JPX_ORIGIN = "https://www.jpx.co.jp";
// 空売り比率は直近の推移も読みたいので、未取得なら過去分も遡って取る (index ページに並ぶ範囲)。
const MARKET_SHORT_DAYS = 5;

function toNumber(raw: string | undefined | null): number | null {
	if (!raw) return null;
	const cleaned = raw.replace(/[,株%％]/g, "").trim();
	if (!cleaned || /^\*+$/.test(cleaned) || cleaned === "-" || cleaned === "－")
		return null;
	const n = Number(cleaned);
	return Number.isFinite(n) ? n : null;
}

async function fetchBytes(
	url: string,
	env: { USER_AGENT: string },
): Promise<Uint8Array> {
	const res = await fetch(url, {
		headers: { "User-Agent": env.USER_AGENT },
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	return new Uint8Array(await res.arrayBuffer());
}

// 日証金 CSV は Shift_JIS。数値とコードは ASCII なので、デコーダが無い環境でも latin1 で読める
// (その場合は日本語の制限措置欄だけ文字化けするので捨てる)。
function decodeSjis(bytes: Uint8Array): { text: string; sjis: boolean } {
	try {
		return { text: new TextDecoder("shift_jis").decode(bytes), sjis: true };
	} catch {
		return { text: new TextDecoder("latin1").decode(bytes), sjis: false };
	}
}

// ── 逆日歩 ────────────────────────────────────────────────────────────────
interface LendingParsed {
	date: string; // 貸借申込日 YYYY-MM-DD
	byCode: Map<
		string,
		{
			excess_shares: number | null;
			max_fee: number | null;
			fee: number | null;
			fee_days: number | null;
			restriction: string | null;
		}
	>;
}

// 品貸料率一覧 CSV。列: 貸借申込日,決済日,コード,銘柄名,取引所区分,決算事由,決算等,貸借値段,
// 貸株超過株数,最高料率,当日品貸料率,当日品貸日数,前日品貸料率,備考,制限,応札倍率ランク。
// データ行 (先頭が 8 桁の日付) が無ければ null。同じコードが複数取引所で並ぶときは先頭 (東証) を使う。
function parseLendingCsv(
	text: string,
	keepRestriction = true,
): LendingParsed | null {
	let date: string | null = null;
	const byCode: LendingParsed["byCode"] = new Map();
	for (const line of text.split(/\r?\n/)) {
		const c = line.split(",");
		if (!/^\d{8}$/.test(c[0] ?? "")) continue;
		date ??= `${c[0].slice(0, 4)}-${c[0].slice(4, 6)}-${c[0].slice(6, 8)}`;
		const code = (c[2] ?? "").trim();
		if (!code || byCode.has(code)) continue;
		const restriction = keepRestriction ? (c[14] ?? "").trim() : "";
		byCode.set(code, {
			excess_shares: toNumber(c[8]),
			max_fee: toNumber(c[9]),
			fee: toNumber(c[10]),
			fee_days: toNumber(c[11]),
			restriction: restriction || null,
		});
	}
	return date ? { date, byCode } : null;
}

async function collectLending(
	env: ShortInterestEnv,
	codes: string[],
): Promise<Record<string, unknown>> {
	const { text, sjis } = decodeSjis(await fetchBytes(URL_LENDING_CSV, env));
	const parsed = parseLendingCsv(text, sjis);
	if (!parsed) return { error: "no rows" };
	const fetchedAt = new Date().toISOString();
	const d = db(env.DB);
	const stmts = codes.map((code) => {
		const r = parsed.byCode.get(code);
		const row = {
			ticker: code,
			date: parsed.date,
			listed: r ? 1 : 0,
			excessShares: r?.excess_shares ?? null,
			maxFee: r?.max_fee ?? null,
			fee: r?.fee || null,
			feeDays: r?.fee_days ?? null,
			restriction: r?.restriction ?? null,
			fetchedAt,
		};
		return d
			.insert(stockLending)
			.values(row)
			.onConflictDoUpdate({
				target: [stockLending.ticker, stockLending.date],
				set: { ...row },
			});
	});
	if (stmts.length > 0) {
		await d.batch(
			stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]],
		);
	}
	return {
		date: parsed.date,
		listed: codes.filter((c) => parsed.byCode.has(c)),
	};
}

// ── 機関の空売り残高 ──────────────────────────────────────────────────────
interface ShortPositionParsed {
	calc_date: string;
	holder: string;
	ratio: number | null;
	qty: number | null;
	lapsed: boolean;
}

// 計算日 / 空売り者 / 残高割合 / 増減率 / 残高数量 / 増減量 / 備考 のテーブル。
async function parseKarauri(html: string): Promise<ShortPositionParsed[]> {
	const tables = await scanTables(html);
	const out: ShortPositionParsed[] = [];
	for (const t of tables) {
		if (!(t.headers.includes("計算日") && t.headers.includes("空売り者")))
			continue;
		const col = (name: string) => t.headers.indexOf(name);
		const [iDate, iHolder, iRatio, iQty, iNote] = [
			col("計算日"),
			col("空売り者"),
			col("残高割合"),
			col("残高数量"),
			col("備考"),
		];
		for (const { cells } of t.rows) {
			const m = (cells[iDate]?.text ?? "").match(/(\d{4})\/(\d{2})\/(\d{2})/);
			const holder = (cells[iHolder]?.text ?? "").trim();
			if (!m || !holder) continue;
			out.push({
				calc_date: `${m[1]}-${m[2]}-${m[3]}`,
				holder,
				ratio: toNumber(cells[iRatio]?.text),
				qty: toNumber(cells[iQty]?.text),
				lapsed: (cells[iNote]?.text ?? "").includes("報告義務消失"),
			});
		}
		break;
	}
	return out;
}

async function collectShortPositionsOne(
	env: ShortInterestEnv,
	code: string,
): Promise<{ written: number }> {
	const rows = await parseKarauri(await fetchHtml(URL_KARAURI(code), env));
	if (rows.length === 0) return { written: 0 };
	const fetchedAt = new Date().toISOString();
	const d = db(env.DB);
	const stmts = rows.map((r) =>
		d
			.insert(shortPositions)
			.values({
				ticker: code,
				calcDate: r.calc_date,
				holder: r.holder,
				ratio: r.ratio,
				qty: r.qty,
				lapsed: r.lapsed ? 1 : 0,
				fetchedAt,
			})
			.onConflictDoNothing(),
	);
	const results = await d.batch(
		stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]],
	);
	let written = 0;
	for (const r of results) written += r.meta.changes ?? 0;
	return { written };
}

// ── 東証全体の空売り比率 ──────────────────────────────────────────────────
// index ページの日次 PDF リンク (…/YYMMDD-m.pdf) を新しい順に返す。
function parseJpxShortLinks(html: string): { date: string; url: string }[] {
	const out: { date: string; url: string }[] = [];
	for (const m of html.matchAll(
		/href="([^"]*\/(\d{2})(\d{2})(\d{2})-m\.pdf)"/g,
	)) {
		const date = `20${m[2]}-${m[3]}-${m[4]}`;
		if (out.some((o) => o.date === date)) continue;
		out.push({ date, url: new URL(m[1], JPX_ORIGIN).toString() });
	}
	return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

// 空売り集計 PDF の表は 実注文 (a) / 空売り価格規制あり (b) / 価格規制なし (c) の売買代金と、
// 合計 (d) に対する比率 (a)/(d)・(b)/(d)・(c)/(d) を並べる。比率は "57.5%" の形で出現順に並ぶので、
// 先頭 3 つを a/b/c の比率として読み、合計が 100% 前後でなければ読み違いとして null。
function parseJpxShortRatio(
	streams: string[],
): { ratio: number; restricted: number; unrestricted: number } | null {
	for (const s of streams) {
		const pct = [...s.matchAll(/\((\d{1,3}\.\d)%\)/g)].map((m) => Number(m[1]));
		if (pct.length < 3) continue;
		const [a, b, c] = pct;
		if (Math.abs(a + b + c - 100) > 0.5) continue;
		return {
			ratio: Math.round((b + c) * 10) / 10,
			restricted: b,
			unrestricted: c,
		};
	}
	return null;
}

async function collectMarketShortRatio(
	env: ShortInterestEnv,
): Promise<Record<string, unknown>> {
	const links = parseJpxShortLinks(await fetchHtml(URL_JPX_SHORT, env)).slice(
		0,
		MARKET_SHORT_DAYS,
	);
	if (links.length === 0) return { error: "no links" };
	const d = db(env.DB);
	const have = new Set(
		(
			await d
				.select({ date: marketShortRatio.date })
				.from(marketShortRatio)
				.where(gte(marketShortRatio.date, links[links.length - 1].date))
				.all()
		).map((r) => r.date),
	);
	const written: string[] = [];
	for (const l of links) {
		if (have.has(l.date)) continue;
		const parsed = parseJpxShortRatio(
			await pdfStreams(await fetchBytes(l.url, env)),
		);
		if (!parsed) continue;
		await d
			.insert(marketShortRatio)
			.values({
				date: l.date,
				ratio: parsed.ratio,
				restrictedRatio: parsed.restricted,
				unrestrictedRatio: parsed.unrestricted,
				fetchedAt: new Date().toISOString(),
			})
			.onConflictDoNothing()
			.run();
		written.push(l.date);
	}
	return { written };
}

// 3 ソースをまとめて収集する。1 つが落ちても他は続行する。
// part を指定するとその 1 つだけ取る (lending = 逆日歩 / positions = 機関の空売り残高 /
// market = 東証全体の空売り比率)。省略時は全部 (code 指定時は銘柄別の 2 つだけ)。
export type ShortInterestPart = "lending" | "positions" | "market";

export async function collectShortInterest(
	env: ShortInterestEnv,
	codeFilter: string | null,
	part: ShortInterestPart | null = null,
): Promise<Record<string, unknown>> {
	const codes = WATCHLIST.filter((c) => !codeFilter || c === codeFilter);
	const interval = parseInt(env.MIN_INTERVAL_MS, 10) || 5000;
	const out: Record<string, unknown> = {};
	if (!part || part === "lending") {
		out.lending = await collectLending(env, codes).catch((e) => ({
			error: (e as Error).message,
		}));
	}
	if (!part || part === "positions") {
		const positions: Record<string, unknown> = {};
		for (const [i, code] of codes.entries()) {
			if (i > 0 || !part) await sleep(interval);
			positions[code] = await collectShortPositionsOne(env, code).catch(
				(e) => ({
					error: (e as Error).message,
				}),
			);
		}
		out.positions = positions;
	}
	if (part === "market" || (!part && !codeFilter)) {
		out.marketShortRatio = await collectMarketShortRatio(env).catch((e) => ({
			error: (e as Error).message,
		}));
	}
	return out;
}

// ── judge-context 用ブロック ───────────────────────────────────────────────
export interface LendingRow {
	date: string;
	listed: number;
	excess_shares?: number | null;
	max_fee?: number | null;
	fee?: number | null;
	fee_days?: number | null;
	restriction?: string | null;
}

export interface ShortPositionRow {
	calc_date: string;
	holder: string;
	ratio?: number | null;
	qty?: number | null;
	lapsed: number;
}

export interface MarketShortRow {
	date: string;
	ratio: number;
}

// 逆日歩: 最新の申込日の状態と、逆日歩が付いた申込日が直近で何日連続しているか。
// rows は date 降順。
export function buildLending(rows: LendingRow[]): Record<string, unknown> {
	if (rows.length === 0) return { status: "unavailable" };
	const cur = rows[0];
	let streak = 0;
	for (const r of rows) {
		if (!(r.fee && r.fee > 0)) break;
		streak++;
	}
	return {
		status: "ok",
		date: cur.date,
		listed: cur.listed === 1,
		fee: cur.fee ?? null,
		fee_days: cur.fee_days ?? null,
		max_fee: cur.max_fee ?? null,
		excess_shares: cur.excess_shares ?? null,
		restriction: cur.restriction ?? null,
		fee_streak_days: streak,
	};
}

// 機関の空売り残高: 空売り者ごとの最新報告のうち報告義務が残っているもの (0.5% 以上) を合算する。
// rows は calc_date 降順。sinceDays 前時点の合計と比べた増減も出す (その時点の最新報告で再集計)。
export function buildShortPositions(
	rows: ShortPositionRow[],
	today: string,
	sinceDays = 30,
): Record<string, unknown> {
	if (rows.length === 0) return { status: "none" };
	const activeAt = (asOf: string) => {
		const latest = new Map<string, ShortPositionRow>();
		for (const r of rows) {
			if (r.calc_date > asOf || latest.has(r.holder)) continue;
			latest.set(r.holder, r);
		}
		return [...latest.values()].filter((r) => r.lapsed !== 1);
	};
	const cut = new Date(`${today}T00:00:00Z`);
	cut.setUTCDate(cut.getUTCDate() - sinceDays);
	const past = cut.toISOString().slice(0, 10);
	const sum = (xs: ShortPositionRow[]) =>
		Math.round(xs.reduce((a, r) => a + (r.ratio ?? 0), 0) * 1000) / 1000;
	const now = activeAt(today);
	const before = activeAt(past);
	return {
		status: now.length > 0 ? "ok" : "none",
		latest_calc_date: rows[0].calc_date,
		holders_n: now.length,
		total_ratio_pct: sum(now),
		total_ratio_chg_pct: Math.round((sum(now) - sum(before)) * 1000) / 1000,
		chg_since: past,
		holders: now
			.sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))
			.slice(0, 5)
			.map((r) => ({
				holder: r.holder,
				ratio_pct: r.ratio ?? null,
				calc_date: r.calc_date,
			})),
	};
}

// 東証全体の空売り比率: 最新値と直近 5 日平均。rows は date 降順。
export function buildMarketShortRatio(
	rows: MarketShortRow[],
): Record<string, unknown> {
	if (rows.length === 0) return { status: "unavailable" };
	const win = rows.slice(0, 5);
	return {
		status: "ok",
		date: rows[0].date,
		ratio_pct: rows[0].ratio,
		avg_5d_pct:
			Math.round((win.reduce((a, r) => a + r.ratio, 0) / win.length) * 10) / 10,
	};
}

// D1 から読む側 (judge-context / market-context) の共通 select。
export async function readMarketShortRatio(
	DB: D1Database,
): Promise<MarketShortRow[]> {
	return await db(DB)
		.select({ date: marketShortRatio.date, ratio: marketShortRatio.ratio })
		.from(marketShortRatio)
		.orderBy(desc(marketShortRatio.date))
		.limit(5)
		.all();
}

export async function readShortInterest(
	DB: D1Database,
	code: string,
): Promise<{ lending: LendingRow[]; positions: ShortPositionRow[] }> {
	const lending = await db(DB)
		.select({
			date: stockLending.date,
			listed: stockLending.listed,
			excess_shares: stockLending.excessShares,
			max_fee: stockLending.maxFee,
			fee: stockLending.fee,
			fee_days: stockLending.feeDays,
			restriction: stockLending.restriction,
		})
		.from(stockLending)
		.where(eq(stockLending.ticker, code))
		.orderBy(desc(stockLending.date))
		.limit(20)
		.all();
	const positions = await db(DB)
		.select({
			calc_date: shortPositions.calcDate,
			holder: shortPositions.holder,
			ratio: shortPositions.ratio,
			qty: shortPositions.qty,
			lapsed: shortPositions.lapsed,
		})
		.from(shortPositions)
		.where(eq(shortPositions.ticker, code))
		.orderBy(desc(shortPositions.calcDate))
		.limit(200)
		.all();
	return { lending, positions };
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("parseLendingCsv", () => {
		const csv = [
			"品貸料率一覧,,,,,,,,,,,,,,,",
			"貸借申込日,決済日,コード,銘柄名,取引所区分,決算事由,決算等,貸借値段（円）,貸株超過株数,最高料率（円）,当日品貸料率（円）,当日品貸日数,前日品貸料率（円）,備考,制限,応札倍率ランク",
			"20261110,20261112,1356,ＴＰダブル,東証,決算,20270220,111.30,48560,6.00,0.00,1,*****,,,F",
			"20261110,20261112,6920,レーザー,東証,決算,20270630,20000,120000,40.00,5.20,3,0.80,,注意喚起,B",
			"20261110,20261112,6920,レーザー,名証,決算,20270630,20000,0,40.00,*****,*****,*****,,,",
		].join("\n");
		it("申込日と銘柄ごとの料率を読む (同コードは先頭行)", () => {
			const p = parseLendingCsv(csv);
			expect(p?.date).toBe("2026-11-10");
			expect(p?.byCode.get("6920")).toEqual({
				excess_shares: 120000,
				max_fee: 40,
				fee: 5.2,
				fee_days: 3,
				restriction: "注意喚起",
			});
			expect(p?.byCode.get("1356")?.fee).toBe(0);
		});
		it("***** は null、データ行が無ければ null", () => {
			expect(parseLendingCsv(csv)?.byCode.size).toBe(2);
			expect(parseLendingCsv("品貸料率一覧\n貸借申込日,決済日")).toBeNull();
		});
	});

	describe("parseKarauri", () => {
		const html = `<table id="sort"><thead><tr><th>計算日</th><th>空売り者</th><th>残高割合</th><th>増減率</th><th>残高数量</th><th>増減量</th><th>備考</th></tr></thead><tbody>
			<tr><td><a href="/6857/?date=2026-08-28">2026/08/28</a></td><td><a>JPモルガン証券</a></td><td>0.480%</td><td>-0.120%</td><td>3,533,508株</td><td>-877,867</td><td><span>報告義務消失</span></td></tr>
			<tr><td><a>2026/08/25</a></td><td><a>JPモルガン証券</a></td><td>0.600%</td><td>+0.080%</td><td>4,411,375株</td><td>+553,220</td><td></td></tr>
			</tbody></table>`;
		it("計算日・空売り者・割合・数量・消失を読む", async () => {
			expect(await parseKarauri(html)).toEqual([
				{
					calc_date: "2026-08-28",
					holder: "JPモルガン証券",
					ratio: 0.48,
					qty: 3533508,
					lapsed: true,
				},
				{
					calc_date: "2026-08-25",
					holder: "JPモルガン証券",
					ratio: 0.6,
					qty: 4411375,
					lapsed: false,
				},
			]);
		});
	});

	describe("parseJpxShortLinks / parseJpxShortRatio", () => {
		it("日次 PDF リンクを新しい順に並べる", () => {
			const html = `<a href="/x/a-att/261110-m.pdf">m</a><a href="/x/a-att/261110-g.pdf">g</a><a href="/x/b-att/261111-m.pdf">m</a>`;
			expect(parseJpxShortLinks(html)).toEqual([
				{
					date: "2026-11-11",
					url: "https://www.jpx.co.jp/x/b-att/261111-m.pdf",
				},
				{
					date: "2026-11-10",
					url: "https://www.jpx.co.jp/x/a-att/261110-m.pdf",
				},
			]);
		});
		it("(a)/(b)/(c) の比率から空売り比率 = b + c を出す", () => {
			const s =
				"[(5,382,287)] TJ [(57.5%)] TJ [(3,269,852)] TJ [(34.9%)] TJ [(704,812)] TJ [(7.5%)] TJ";
			expect(parseJpxShortRatio(["BT ET", s])).toEqual({
				ratio: 42.4,
				restricted: 34.9,
				unrestricted: 7.5,
			});
		});
		it("合計が 100% にならなければ読み違いとして null", () => {
			expect(parseJpxShortRatio(["[(10.0%)] [(20.0%)] [(30.0%)]"])).toBeNull();
		});
	});

	describe("buildLending", () => {
		it("逆日歩の連続日数を数える", () => {
			const out = buildLending([
				{ date: "2026-11-10", listed: 1, fee: 0.8, fee_days: 1 },
				{ date: "2026-11-09", listed: 1, fee: 0.4, fee_days: 1 },
				{ date: "2026-11-06", listed: 1, fee: null },
			]);
			expect(out.status).toBe("ok");
			expect(out.listed).toBe(true);
			expect(out.fee_streak_days).toBe(2);
		});
		it("一覧に載らない日は listed=false / streak 0", () => {
			const out = buildLending([{ date: "2026-11-10", listed: 0 }]);
			expect(out.listed).toBe(false);
			expect(out.fee_streak_days).toBe(0);
		});
		it("行なしは unavailable", () => {
			expect(buildLending([])).toEqual({ status: "unavailable" });
		});
	});

	describe("buildShortPositions", () => {
		const rows: ShortPositionRow[] = [
			{ calc_date: "2026-11-05", holder: "A", ratio: 0.7, lapsed: 0 },
			{ calc_date: "2026-10-28", holder: "B", ratio: 0.45, lapsed: 1 },
			{ calc_date: "2026-10-01", holder: "B", ratio: 0.6, lapsed: 0 },
			{ calc_date: "2026-09-20", holder: "A", ratio: 0.5, lapsed: 0 },
		];
		it("報告義務が残る空売り者の最新割合を合算し、30日前と比べる", () => {
			const out = buildShortPositions(rows, "2026-11-11");
			expect(out.holders_n).toBe(1);
			expect(out.total_ratio_pct).toBe(0.7);
			// 30日前 (10-12) 時点: A 0.5 + B 0.6 = 1.1
			expect(out.total_ratio_chg_pct).toBe(-0.4);
			expect(out.holders).toEqual([
				{ holder: "A", ratio_pct: 0.7, calc_date: "2026-11-05" },
			]);
		});
		it("全員が消失していれば none", () => {
			const out = buildShortPositions(
				[{ calc_date: "2026-11-01", holder: "B", ratio: 0.4, lapsed: 1 }],
				"2026-11-11",
			);
			expect(out.status).toBe("none");
		});
		it("行なしは none", () => {
			expect(buildShortPositions([], "2026-11-11")).toEqual({ status: "none" });
		});
	});

	describe("buildMarketShortRatio", () => {
		it("最新値と 5 日平均", () => {
			const out = buildMarketShortRatio([
				{ date: "2026-11-11", ratio: 42.4 },
				{ date: "2026-11-10", ratio: 40.0 },
			]);
			expect(out).toEqual({
				status: "ok",
				date: "2026-11-11",
				ratio_pct: 42.4,
				avg_5d_pct: 41.2,
			});
		});
	});
}
