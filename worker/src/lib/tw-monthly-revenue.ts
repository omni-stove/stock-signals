// Cloudflare Worker: 台湾企業 (TSMC) の月次売上の収集と、market-context 用ブロック。
//
// 取得元は公開資訊観測站 (MOPS) の上市会社月次売上一覧 (静的 HTML、対象月ごとに 1 ページ):
//   https://mopsov.twse.com.tw/nas/t21/sii/t21sc03_{民国年}_{月}_0.html
// TSMC 自身が法定開示として提出する数字で、単位は千 NTD。行は
//   公司代號 | 公司名稱 | 當月營收 | 上月營收 | 去年當月營收 | 上月比較增減(%) | 去年同月增減(%) | 累計… | 備註
// の並び。単位が tw_monthly_revenue と同じ千 NTD で、前月比・前年同月比も同じ行に載るのでここから取る。
// ページは Big5 のことがあるが、読むのは ASCII の会社コードと数字だけなので UTF-8 で読んでも崩れない。

import { desc, eq } from "drizzle-orm";
import { db } from "./db";
import { twMonthlyRevenue } from "./schema";
import { fetchHtml, jstDate, sleep } from "./utils";

export interface TwMonthlyRevenueEnv {
	DB: D1Database;
	USER_AGENT: string;
	MIN_INTERVAL_MS: string;
}

const COMPANY = "TSMC";
const TWSE_CODE = "2330";
// 前月分 (未公表なら前々月分) を最新として yoy 推移 3 か月が埋まるだけ遡る。
const LOOKBACK_MONTHS = 4;
// 法定期限は翌月 10 日なので、月末から 45 日経っても次の月が無ければ取得が止まっている。
const STALE_DAYS = 45;
// 前月比・前年同月比の検算で許す差 (MOPS は小数 2 桁に丸めて載せる)。
const PCT_TOLERANCE = 0.05;
const DAY_MS = 86_400_000;

/** 対象月 (YYYY-MM) の MOPS 月次売上一覧 (国内上市会社) の URL を返す。 */
function mopsUrl(month: string): string {
	const [y, m] = month.split("-").map((n) => Number.parseInt(n, 10));
	return `https://mopsov.twse.com.tw/nas/t21/sii/t21sc03_${y - 1911}_${m}_0.html`;
}

/** YYYY-MM を n か月ずらした YYYY-MM を返す (n は負でもよい)。 */
function shiftMonth(month: string, n: number): string {
	const [y, m] = month.split("-").map((v) => Number.parseInt(v, 10));
	const total = y * 12 + (m - 1) + n;
	return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** YYYY-MM の月末日 (YYYY-MM-DD) を返す。 */
function monthEnd(month: string): string {
	const [y, m] = month.split("-").map((v) => Number.parseInt(v, 10));
	return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function round2(v: number): number {
	return Math.round(v * 100) / 100;
}

/** base に対する cur の増減率 (%) を小数 2 桁で返す。base が 0 以下なら null。 */
function changePct(cur: number, base: number): number | null {
	return base > 0 ? round2((cur / base - 1) * 100) : null;
}

function cellNumber(raw: string | undefined): number | null {
	if (raw === undefined) return null;
	const s = raw
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/[\s,]/g, "");
	if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
	const v = Number(s);
	return Number.isFinite(v) ? v : null;
}

type ParsedRevenue = {
	revenue: number; // 千 NTD
	momPct: number | null;
	yoyPct: number | null;
};

/**
 * MOPS 月次売上一覧の HTML から会社コード code の行を読み、当月売上 (千 NTD)・前月比・前年同月比 (%) を返す。
 * 行が無い、当月売上が読めない、または載っている増減率が同じ行の売上から計算した値と合わない
 * (列の並びが変わった) ときは null。増減率のセルが空なら、その率は null で返す。
 */
function parseMopsMonthlyRevenue(
	html: string,
	code: string,
): ParsedRevenue | null {
	// 一覧は業種ごとの表が外枠の表に入れ子になっており、<tr> 単位で切ると外側の行に食われるため、
	// 会社コードのセルから行末までを切り出す。
	const head = new RegExp(`<td[^>]*>\\s*${code}\\s*</td>`).exec(html);
	if (!head) return null;
	const rest = html.slice(head.index);
	const end = rest.indexOf("</tr>");
	const row = end < 0 ? rest : rest.slice(0, end);
	const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(
		(c) => c[1],
	);
	if (cells.length < 7) return null;
	const revenue = cellNumber(cells[2]);
	if (revenue === null || revenue <= 0) return null;
	const prev = cellNumber(cells[3]);
	const lastYear = cellNumber(cells[4]);
	const momPct = cellNumber(cells[5]);
	const yoyPct = cellNumber(cells[6]);
	const consistent = (pct: number | null, base: number | null) => {
		if (pct === null || base === null) return true;
		const calc = changePct(revenue, base);
		return calc === null || Math.abs(calc - pct) <= PCT_TOLERANCE;
	};
	if (!consistent(momPct, prev) || !consistent(yoyPct, lastYear)) return null;
	return { revenue, momPct, yoyPct };
}

/** 一覧に会社の行 (4 桁の会社コードのセル) が 1 つでもあれば true。公表前の月のページには無い。 */
function hasCompanyRows(html: string): boolean {
	return /<td[^>]*>\s*\d{4}\s*<\/td>/.test(html);
}

export interface TwMonthlyRevenueRow {
	month: string;
	revenue: number;
	yoy_pct: number | null;
	mom_pct: number | null;
	source: string;
}

/**
 * 前月比・前年同月比が null の行を、rows 自身と known (保存済みの行) にある前月・前年同月の売上から埋めて返す。
 * 基準月の行がどちらにも無ければ null のまま。
 */
function fillChanges(
	rows: TwMonthlyRevenueRow[],
	known: TwMonthlyRevenueRow[],
): TwMonthlyRevenueRow[] {
	const revenueOf = new Map<string, number>();
	for (const r of [...known, ...rows]) revenueOf.set(r.month, r.revenue);
	const pctFrom = (r: TwMonthlyRevenueRow, months: number) => {
		const base = revenueOf.get(shiftMonth(r.month, -months));
		return base === undefined ? null : changePct(r.revenue, base);
	};
	return rows.map((r) => ({
		...r,
		mom_pct: r.mom_pct ?? pctFrom(r, 1),
		yoy_pct: r.yoy_pct ?? pctFrom(r, 12),
	}));
}

/**
 * TSMC の月次売上を MOPS から取り、tw_monthly_revenue に (company, month) で upsert する。
 * 対象は JST 今月の前月から LOOKBACK_MONTHS か月分のうち未保存の月だけで、全部保存済みなら取得しない。
 * 前月分がまだ無い (404 または一覧に会社の行が 1 つも無い) のは公表前として pending に入れて正常終了する。
 * それより前の月が取れない・読めないときは、読めた月を保存した後に例外を投げてジョブ失敗にする。
 * 戻り値は { written: 保存した月, pending: 公表待ちの月 }。
 */
export async function collectTwMonthlyRevenue(
	env: TwMonthlyRevenueEnv,
	epochNow: number = Date.now(),
): Promise<Record<string, unknown>> {
	const latestCandidate = shiftMonth(jstDate(epochNow).slice(0, 7), -1);
	const months = Array.from({ length: LOOKBACK_MONTHS }, (_, i) =>
		shiftMonth(latestCandidate, -i),
	);
	const stored = await readTwMonthlyRevenue(env.DB);
	const have = new Set(stored.map((r) => r.month));
	const targets = months.filter((m) => !have.has(m));
	const interval = Number.parseInt(env.MIN_INTERVAL_MS, 10) || 5000;

	const parsed: TwMonthlyRevenueRow[] = [];
	const pending: string[] = [];
	const failures: string[] = [];
	for (const [i, month] of targets.entries()) {
		if (i > 0) await sleep(interval);
		const url = mopsUrl(month);
		let html: string;
		try {
			html = await fetchHtml(url, env);
		} catch (e) {
			const status = (e as { status?: number }).status;
			if (status === 404 && month === latestCandidate) pending.push(month);
			else failures.push(`${month}: ${String(e)}`);
			continue;
		}
		const r = parseMopsMonthlyRevenue(html, TWSE_CODE);
		if (r) {
			parsed.push({
				month,
				revenue: r.revenue,
				yoy_pct: r.yoyPct,
				mom_pct: r.momPct,
				source: url,
			});
		} else if (month === latestCandidate && !hasCompanyRows(html)) {
			pending.push(month);
		} else {
			failures.push(
				`${month}: ${TWSE_CODE} の行を読めない (ページ構造変更の可能性)`,
			);
		}
	}

	const rows = fillChanges(parsed, stored);
	if (rows.length > 0) {
		const d = db(env.DB);
		const fetchedAt = new Date(epochNow).toISOString();
		const stmts = rows.map((r) =>
			d
				.insert(twMonthlyRevenue)
				.values({
					company: COMPANY,
					month: r.month,
					revenue: r.revenue,
					yoyPct: r.yoy_pct,
					momPct: r.mom_pct,
					source: r.source,
					fetchedAt,
				})
				.onConflictDoUpdate({
					target: [twMonthlyRevenue.company, twMonthlyRevenue.month],
					set: {
						revenue: r.revenue,
						yoyPct: r.yoy_pct,
						momPct: r.mom_pct,
						source: r.source,
						fetchedAt,
					},
				}),
		);
		await d.batch(
			stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]],
		);
	}
	const result = { written: rows.map((r) => r.month), pending };
	if (failures.length > 0) {
		throw new Error(
			`tw-monthly-revenue: ${failures.join(" / ")} (保存済み ${JSON.stringify(result)})`,
		);
	}
	return result;
}

/** 保存済みの TSMC の月次売上を新しい月順に、前年同月比を計算できる 24 か月分まで返す。 */
export async function readTwMonthlyRevenue(
	DB: D1Database,
): Promise<TwMonthlyRevenueRow[]> {
	return await db(DB)
		.select({
			month: twMonthlyRevenue.month,
			revenue: twMonthlyRevenue.revenue,
			yoy_pct: twMonthlyRevenue.yoyPct,
			mom_pct: twMonthlyRevenue.momPct,
			source: twMonthlyRevenue.source,
		})
		.from(twMonthlyRevenue)
		.where(eq(twMonthlyRevenue.company, COMPANY))
		.orderBy(desc(twMonthlyRevenue.month))
		.limit(24)
		.all();
}

/**
 * market-context 用の TSMC 月次売上ブロック。today は JST の YYYY-MM-DD。
 *   行なし → { status: "unavailable" }
 *   行あり → 最新月の revenue (千 NTD)・yoy_pct・mom_pct と、最新月までの 3 か月の yoy_trend (古い月から順、
 *            行が無い月は yoy_pct: null)。最新月の月末から STALE_DAYS 日を超えていれば status: "stale"、
 *            それ以外は "ok"。
 */
export function buildTwMonthlyRevenueBlock(
	rows: TwMonthlyRevenueRow[],
	today: string,
): Record<string, unknown> {
	if (rows.length === 0) return { status: "unavailable" };
	const byMonth = new Map(rows.map((r) => [r.month, r]));
	const latest = [...byMonth.keys()].sort().reverse()[0];
	const row = byMonth.get(latest) as TwMonthlyRevenueRow;
	const ageDays = Math.floor(
		(Date.parse(`${today}T00:00:00Z`) -
			Date.parse(`${monthEnd(latest)}T00:00:00Z`)) /
			DAY_MS,
	);
	return {
		status: ageDays > STALE_DAYS ? "stale" : "ok",
		company: COMPANY,
		unit: "千NTD",
		month: latest,
		revenue: row.revenue,
		yoy_pct: row.yoy_pct,
		mom_pct: row.mom_pct,
		yoy_trend: [2, 1, 0].map((n) => {
			const month = shiftMonth(latest, -n);
			return { month, yoy_pct: byMonth.get(month)?.yoy_pct ?? null };
		}),
		source: row.source,
	};
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	// MOPS t21sc03 の様式 (外枠の表に業種ごとの表が入れ子、数字は右寄せで桁区切り付き) を縮めたもの。
	const mopsPage = (tsmcRow: string) => `
<html><head><meta http-equiv="Content-Type" content="text/html; charset=big5"></head><body>
<center><b>本資料由各公司依規定申報</b></center>
<table width=100% border=0><tr><td>
<table class='hasBorder'>
<tr><th class='tt' rowspan=2>公司<br>代號</th><th class='tt' rowspan=2>公司名稱</th><th class='tt' colspan=5>營業收入</th><th class='tt' colspan=3>累計營業收入</th><th class='tt' rowspan=2>備註</th></tr>
<tr><th class='tt'>當月營收</th><th class='tt'>上月營收</th><th class='tt'>去年當月營收</th><th class='tt'>上月比較<br>增減(%)</th><th class='tt'>去年同月<br>增減(%)</th><th class='tt'>當月累計營收</th><th class='tt'>去年累計營收</th><th class='tt'>前期比較<br>增減(%)</th></tr>
<tr align=right><td align=center>2303</td><td align=left>聯電</td><td nowrap>   20,542,000</td><td nowrap>   19,866,000</td><td nowrap>   19,702,000</td><td nowrap>     3.40</td><td nowrap>     4.26</td><td nowrap>  196,000,000</td><td nowrap>  190,000,000</td><td nowrap>     3.15</td><td nowrap>-</td></tr>
${tsmcRow}
<tr align=right><td align=center>23301</td><td align=left>dummy</td><td nowrap>1</td><td nowrap>1</td><td nowrap>1</td><td nowrap>0.00</td><td nowrap>0.00</td><td nowrap>1</td><td nowrap>1</td><td nowrap>0.00</td><td nowrap>-</td></tr>
</table>
</td></tr></table>
</body></html>`;
	const tsmc = (
		cur: string,
		prev: string,
		ly: string,
		mom: string,
		yoy: string,
	) =>
		`<tr align=right><td align=center>2330</td><td align=left>台積電</td><td nowrap>${cur}</td><td nowrap>${prev}</td><td nowrap>${ly}</td><td nowrap>${mom}</td><td nowrap>${yoy}</td><td nowrap>3,130,000,000</td><td nowrap>2,400,000,000</td><td nowrap>30.42</td><td nowrap>-</td></tr>`;

	describe("parseMopsMonthlyRevenue", () => {
		it("会社コードの行から当月売上 (千 NTD)・前月比・前年同月比を読む", () => {
			const html = mopsPage(
				tsmc(
					"  367,473,000",
					"  330,980,000",
					"  314,240,000",
					"    11.03",
					"    16.94",
				),
			);
			expect(parseMopsMonthlyRevenue(html, "2330")).toEqual({
				revenue: 367_473_000,
				momPct: 11.03,
				yoyPct: 16.94,
			});
		});

		it("負の増減率を読む", () => {
			const html = mopsPage(
				tsmc("300,000,000", "330,000,000", "310,000,000", "-9.09", "-3.23"),
			);
			expect(parseMopsMonthlyRevenue(html, "2330")).toMatchObject({
				momPct: -9.09,
				yoyPct: -3.23,
			});
		});

		it("増減率のセルが空ならその率は null", () => {
			const html = mopsPage(
				tsmc("367,473,000", "330,980,000", "", "11.03", "&nbsp;"),
			);
			expect(parseMopsMonthlyRevenue(html, "2330")).toEqual({
				revenue: 367_473_000,
				momPct: 11.03,
				yoyPct: null,
			});
		});

		it("載っている増減率が売上の列と合わなければ (列ずれ) null", () => {
			const html = mopsPage(
				tsmc("367,473,000", "330,980,000", "314,240,000", "16.94", "11.03"),
			);
			expect(parseMopsMonthlyRevenue(html, "2330")).toBeNull();
		});

		it("会社コードの行が無い・売上が読めなければ null", () => {
			expect(parseMopsMonthlyRevenue(mopsPage(""), "2330")).toBeNull();
			expect(
				parseMopsMonthlyRevenue(mopsPage(tsmc("-", "", "", "", "")), "2330"),
			).toBeNull();
		});
	});

	describe("hasCompanyRows", () => {
		it("会社コードのセルがあれば true、見出しだけのページは false", () => {
			expect(hasCompanyRows(mopsPage(""))).toBe(true);
			expect(
				hasCompanyRows(
					"<table class='hasBorder'><tr><th class='tt'>公司<br>代號</th></tr></table>",
				),
			).toBe(false);
		});
	});

	describe("shiftMonth / monthEnd / mopsUrl", () => {
		it("年をまたいで月をずらす", () => {
			expect(shiftMonth("2026-01", -1)).toBe("2025-12");
			expect(shiftMonth("2026-10", -12)).toBe("2025-10");
			expect(shiftMonth("2026-12", 1)).toBe("2027-01");
		});
		it("月末日を返す (うるう年の 2 月を含む)", () => {
			expect(monthEnd("2026-10")).toBe("2026-10-31");
			expect(monthEnd("2028-02")).toBe("2028-02-29");
		});
		it("民国年と 0 埋めしない月で URL を組む", () => {
			expect(mopsUrl("2026-10")).toBe(
				"https://mopsov.twse.com.tw/nas/t21/sii/t21sc03_115_10_0.html",
			);
			expect(mopsUrl("2026-01")).toBe(
				"https://mopsov.twse.com.tw/nas/t21/sii/t21sc03_115_1_0.html",
			);
		});
	});

	const row = (
		month: string,
		revenue: number,
		yoy: number | null = null,
		mom: number | null = null,
	): TwMonthlyRevenueRow => ({
		month,
		revenue,
		yoy_pct: yoy,
		mom_pct: mom,
		source: "s",
	});

	describe("fillChanges", () => {
		it("null の率を保存済み・同時取得の前月・前年同月の売上から計算する", () => {
			const out = fillChanges(
				[row("2026-10", 120), row("2026-09", 100)],
				[row("2025-10", 80)],
			);
			expect(out[0]).toMatchObject({ mom_pct: 20, yoy_pct: 50 });
			expect(out[1]).toMatchObject({ mom_pct: null, yoy_pct: null });
		});
		it("ページに載っていた率は上書きしない", () => {
			const out = fillChanges(
				[row("2026-10", 120, 7, 3)],
				[row("2026-09", 100)],
			);
			expect(out[0]).toMatchObject({ mom_pct: 3, yoy_pct: 7 });
		});
	});

	describe("buildTwMonthlyRevenueBlock", () => {
		const rows = [
			row("2026-10", 367_473_000, 16.94, 11.03),
			row("2026-09", 330_980_000, 17.5, -1.4),
			row("2026-08", 335_770_000, 33.8, 4.5),
			row("2026-07", 323_170_000, 25.8, 22.5),
		];

		it("最新月の売上・率と、最新月までの 3 か月の yoy 推移を古い順に返す", () => {
			expect(buildTwMonthlyRevenueBlock(rows, "2026-11-20")).toEqual({
				status: "ok",
				company: "TSMC",
				unit: "千NTD",
				month: "2026-10",
				revenue: 367_473_000,
				yoy_pct: 16.94,
				mom_pct: 11.03,
				yoy_trend: [
					{ month: "2026-08", yoy_pct: 33.8 },
					{ month: "2026-09", yoy_pct: 17.5 },
					{ month: "2026-10", yoy_pct: 16.94 },
				],
				source: "s",
			});
		});

		it("並び順によらず最新月を選び、行が無い月の yoy は null", () => {
			const out = buildTwMonthlyRevenueBlock([rows[2], rows[0]], "2026-11-20");
			expect(out.month).toBe("2026-10");
			expect(out.yoy_trend).toEqual([
				{ month: "2026-08", yoy_pct: 33.8 },
				{ month: "2026-09", yoy_pct: null },
				{ month: "2026-10", yoy_pct: 16.94 },
			]);
		});

		it("最新月の月末から 45 日を超えたら stale", () => {
			expect(buildTwMonthlyRevenueBlock(rows, "2026-12-15").status).toBe("ok");
			expect(buildTwMonthlyRevenueBlock(rows, "2026-12-16").status).toBe(
				"stale",
			);
		});

		it("行なしは unavailable", () => {
			expect(buildTwMonthlyRevenueBlock([], "2026-11-20")).toEqual({
				status: "unavailable",
			});
		});
	});
}
