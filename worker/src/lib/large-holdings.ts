// Cloudflare Worker: EDINET の大量保有報告書・変更報告書の収集と、judge-context 用の絞り込み。
//
// 収集: EDINET API v2 の書類一覧 (documents.json, type=2) を直近 LOOKBACK_DAYS 日ぶん引き、
// 対象会社 (subjectEdinetCode) が監視銘柄の docTypeCode 350 だけを拾う。保有割合は書類の CSV
// (type=5, zip 内の XBRL_TO_CSV/jplvh*.csv、UTF-16 タブ区切り) から読み、取れなければ null で残す。
// 取得済みの doc_id は CSV を取り直さない。LLM 不使用。
//
// 絞り込み (holdingItems): 銘柄ブリーフの supply ブロックに足すので、提出者ごとの最新 1 件・
// 直近 RECENT_DAYS 日・MAX_ITEMS 件までにし、特例報告 (機関投資家の定例報告) は保有割合が
// 取れて 1pt 以上動いたものだけ残す。

import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "./db";
import type { Env } from "./env";
import { unzipBytes } from "./inflate";
import { largeHoldings } from "./schema";
import { sleep } from "./utils";
import { EDINET_TO_TICKER } from "./watchlist";

const API = "https://api.edinet-fsa.go.jp/api/v2";
const LOOKBACK_DAYS = 7;
const FETCH_TIMEOUT_MS = 20_000;

type LargeHoldingsEnv = Pick<
	Env,
	"DB" | "EDINET_API_KEY" | "MIN_INTERVAL_MS" | "USER_AGENT"
>;

interface EdinetDoc {
	docID: string;
	docTypeCode: string | null;
	subjectEdinetCode: string | null;
	filerName: string | null;
	docDescription: string | null;
	submitDateTime: string | null; // "YYYY-MM-DD hh:mm"
	withdrawalStatus: string | null;
	csvFlag: string | null;
}

interface HoldingReport {
	docId: string;
	ticker: string;
	filer: string;
	reportKind: "new" | "change";
	special: boolean;
	submitDate: string;
	csv: boolean;
}

// 書類一覧から、監視銘柄が対象の大量保有報告書・変更報告書を取り出す (訂正・取下げは除く)。
function pickHoldingReports(
	docs: EdinetDoc[],
	edinetToTicker: Record<string, string>,
): HoldingReport[] {
	return docs.flatMap((d) => {
		if (d.docTypeCode !== "350" || d.withdrawalStatus !== "0") return [];
		const ticker = d.subjectEdinetCode
			? edinetToTicker[d.subjectEdinetCode]
			: undefined;
		const desc = d.docDescription ?? "";
		const reportKind = desc.startsWith("変更報告書")
			? "change"
			: desc.startsWith("大量保有報告書")
				? "new"
				: null;
		const submitDate = d.submitDateTime?.slice(0, 10) ?? "";
		if (!ticker || !reportKind || !/^\d{4}-\d{2}-\d{2}$/.test(submitDate))
			return [];
		return [
			{
				docId: d.docID,
				ticker,
				filer: (d.filerName ?? "").trim(),
				reportKind,
				special: desc.includes("特例対象株券等"),
				submitDate,
				csv: d.csvFlag === "1",
			},
		];
	});
}

function decodeCsv(bytes: Uint8Array): string {
	if (bytes[0] === 0xff && bytes[1] === 0xfe)
		return new TextDecoder("utf-16le").decode(bytes.subarray(2));
	return new TextDecoder("utf-8").decode(bytes);
}

const RATIO_ID = /:HoldingRatioOfShareCertificatesEtc$/;
const PREV_RATIO_ID = /:HoldingRatioOfShareCertificatesEtcPerLastReport$/;

// XBRL_TO_CSV の行 (要素ID / コンテキストID / 値) から保有割合 (%) とその前回報告値を引く。
// 共同保有で複数行あるときは要素 ID に Total を含む行、次に FilingDateInstant の行を採る。
// 値が 1 以下なら比率 (0.0512) とみなして % に直す。
function parseHoldingRatios(csv: string): {
	ratio: number | null;
	prevRatio: number | null;
} {
	const rows = csv
		.split(/\r?\n/)
		.map((l) => l.split("\t").map((f) => f.replace(/^"|"$/g, "")));
	const header = rows[0] ?? [];
	const col = (name: string, fallback: number) => {
		const i = header.indexOf(name);
		return i >= 0 ? i : fallback;
	};
	const idCol = col("要素ID", 0);
	const ctxCol = col("コンテキストID", 2);
	const valCol = col("値", 8);
	const pick = (re: RegExp): number | null => {
		const hits = rows.slice(1).filter((r) => re.test(r[idCol] ?? ""));
		const best =
			hits.find((r) => /Total/.test(r[idCol])) ??
			hits.find((r) => r[ctxCol] === "FilingDateInstant") ??
			hits[0];
		const n = Number(best?.[valCol]);
		if (!best || best[valCol] === "" || !Number.isFinite(n)) return null;
		return Math.round((n <= 1 ? n * 100 : n) * 100) / 100;
	};
	return { ratio: pick(RATIO_ID), prevRatio: pick(PREV_RATIO_ID) };
}

// EDINET を GET する。Subscription-Key を含む URL はエラーやログに出さない。
async function edinetGet(
	path: string,
	query: Record<string, string>,
	env: LargeHoldingsEnv,
): Promise<Response> {
	const q = new URLSearchParams({
		...query,
		"Subscription-Key": env.EDINET_API_KEY ?? "",
	});
	const res = await fetch(`${API}${path}?${q.toString()}`, {
		headers: { "User-Agent": env.USER_AGENT },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`EDINET HTTP ${res.status} ${path}`);
	return res;
}

function jstToday(): string {
	return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

export async function collectLargeHoldings(
	env: LargeHoldingsEnv,
): Promise<Record<string, unknown>> {
	if (!env.EDINET_API_KEY) return { skipped: "EDINET_API_KEY unset" };
	const interval = parseInt(env.MIN_INTERVAL_MS, 10) || 5000;
	const today = jstToday();
	const reports: HoldingReport[] = [];
	for (let i = LOOKBACK_DAYS - 1; i >= 0; i--) {
		const date = addDays(today, -i);
		const res = await edinetGet("/documents.json", { date, type: "2" }, env);
		const body = (await res.json()) as { results?: EdinetDoc[] };
		reports.push(...pickHoldingReports(body.results ?? [], EDINET_TO_TICKER));
		await sleep(interval);
	}
	const d = db(env.DB);
	const known = new Set(
		reports.length === 0
			? []
			: (
					await d
						.select({ docId: largeHoldings.docId })
						.from(largeHoldings)
						.where(
							inArray(
								largeHoldings.docId,
								reports.map((r) => r.docId),
							),
						)
						.all()
				).map((r) => r.docId),
	);
	let inserted = 0;
	let ratioMissing = 0;
	for (const r of reports.filter((x) => !known.has(x.docId))) {
		let ratios = {
			ratio: null as number | null,
			prevRatio: null as number | null,
		};
		if (r.csv) {
			try {
				const res = await edinetGet(
					`/documents/${r.docId}`,
					{ type: "5" },
					env,
				);
				const csv = await unzipBytes(
					new Uint8Array(await res.arrayBuffer()),
					(n) => /XBRL_TO_CSV\/jplvh[^/]*\.csv$/.test(n),
				);
				if (csv) ratios = parseHoldingRatios(decodeCsv(csv));
			} catch (e) {
				console.error(
					`large-holdings [${r.docId}] csv: ${(e as Error).message}`,
				);
			}
			await sleep(interval);
		}
		if (ratios.ratio == null) ratioMissing++;
		await d
			.insert(largeHoldings)
			.values({
				docId: r.docId,
				ticker: r.ticker,
				filer: r.filer,
				reportKind: r.reportKind,
				special: r.special,
				submitDate: r.submitDate,
				ratio: ratios.ratio,
				prevRatio: ratios.prevRatio,
				fetchedAt: new Date().toISOString(),
			})
			.onConflictDoNothing()
			.run();
		inserted++;
	}
	return {
		days: LOOKBACK_DAYS,
		matched: reports.length,
		inserted,
		ratioMissing,
	};
}

// ── judge-context 用 ─────────────────────────────────────────────────────────

export interface LargeHoldingRow {
	filer: string;
	report_kind: string;
	special: boolean;
	submit_date: string;
	ratio: number | null;
	prev_ratio: number | null;
}

const RECENT_DAYS = 90;
const MAX_ITEMS = 3;

export async function readLargeHoldings(
	env: Pick<Env, "DB">,
	ticker: string,
	today: string,
): Promise<LargeHoldingRow[]> {
	return db(env.DB)
		.select({
			filer: largeHoldings.filer,
			report_kind: largeHoldings.reportKind,
			special: largeHoldings.special,
			submit_date: largeHoldings.submitDate,
			ratio: largeHoldings.ratio,
			prev_ratio: largeHoldings.prevRatio,
		})
		.from(largeHoldings)
		.where(
			and(
				eq(largeHoldings.ticker, ticker),
				gte(largeHoldings.submitDate, addDays(today, -RECENT_DAYS)),
			),
		)
		.orderBy(desc(largeHoldings.submitDate))
		.all();
}

// supply.items に足す形にする。rows は submit_date DESC。
export function holdingItems(
	rows: LargeHoldingRow[],
	today: string,
): Record<string, unknown>[] {
	const since = addDays(today, -RECENT_DAYS);
	const seen = new Set<string>();
	return rows
		.filter((r) => r.submit_date >= since && r.submit_date <= today)
		.filter((r) => {
			if (seen.has(r.filer)) return false;
			seen.add(r.filer);
			return true;
		})
		.filter(
			(r) =>
				!r.special ||
				(r.ratio != null &&
					r.prev_ratio != null &&
					Math.abs(r.ratio - r.prev_ratio) >= 1),
		)
		.slice(0, MAX_ITEMS)
		.map((r) => ({
			date: r.submit_date,
			kind:
				r.report_kind === "new" ? "large_holding_new" : "large_holding_change",
			filer: r.filer.slice(0, 30),
			ratio_pct: r.ratio,
			...(r.prev_ratio != null ? { prev_ratio_pct: r.prev_ratio } : {}),
			...(r.special ? { special: true } : {}),
			days_since: Math.round(
				(Date.parse(`${today}T00:00:00Z`) -
					Date.parse(`${r.submit_date}T00:00:00Z`)) /
					86400_000,
			),
		}));
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("pickHoldingReports", () => {
		const base: EdinetDoc = {
			docID: "S100AAAA",
			docTypeCode: "350",
			subjectEdinetCode: "E01950",
			filerName: "ブラックロック・ジャパン株式会社 ",
			docDescription: "変更報告書（特例対象株券等）",
			submitDateTime: "2026-11-12 15:00",
			withdrawalStatus: "0",
			csvFlag: "1",
		};
		const map = { E01950: "6857" };

		it("監視銘柄が対象の 350 を、新規/変更・特例の別付きで拾う", () => {
			expect(
				pickHoldingReports(
					[
						base,
						{
							...base,
							docID: "S100BBBB",
							docDescription: "大量保有報告書",
							filerName: "個人投資家",
						},
					],
					map,
				),
			).toEqual([
				{
					docId: "S100AAAA",
					ticker: "6857",
					filer: "ブラックロック・ジャパン株式会社",
					reportKind: "change",
					special: true,
					submitDate: "2026-11-12",
					csv: true,
				},
				{
					docId: "S100BBBB",
					ticker: "6857",
					filer: "個人投資家",
					reportKind: "new",
					special: false,
					submitDate: "2026-11-12",
					csv: true,
				},
			]);
		});

		it("訂正・取下げ・対象外の会社・他の書類は除く", () => {
			expect(
				pickHoldingReports(
					[
						{ ...base, docTypeCode: "360" },
						{ ...base, withdrawalStatus: "1" },
						{ ...base, subjectEdinetCode: "E99999" },
						{ ...base, subjectEdinetCode: null },
						{ ...base, docTypeCode: "120" },
					],
					map,
				),
			).toEqual([]);
		});
	});

	describe("parseHoldingRatios", () => {
		const row = (id: string, ctx: string, v: string) =>
			[
				`"${id}"`,
				'"項目"',
				`"${ctx}"`,
				'"当期"',
				'"その他"',
				'"時点"',
				'"pure"',
				'"-"',
				`"${v}"`,
			].join("\t");
		const header = [
			'"要素ID"',
			'"項目名"',
			'"コンテキストID"',
			'"相対年度"',
			'"連結・個別"',
			'"期間・時点"',
			'"ユニットID"',
			'"単位"',
			'"値"',
		].join("\t");

		it("保有割合と前回報告値を % で返す", () => {
			const csv = [
				header,
				row(
					"jplvh_cor:HoldingRatioOfShareCertificatesEtc",
					"FilingDateInstant",
					"0.0612",
				),
				row(
					"jplvh_cor:HoldingRatioOfShareCertificatesEtcPerLastReport",
					"FilingDateInstant",
					"0.0498",
				),
			].join("\r\n");
			expect(parseHoldingRatios(csv)).toEqual({ ratio: 6.12, prevRatio: 4.98 });
		});

		it("共同保有で複数行あれば FilingDateInstant の行を採る", () => {
			const csv = [
				header,
				row(
					"jplvh_cor:HoldingRatioOfShareCertificatesEtc",
					"FilingDateInstant_Row1Member",
					"0.02",
				),
				row(
					"jplvh_cor:HoldingRatioOfShareCertificatesEtc",
					"FilingDateInstant",
					"0.07",
				),
			].join("\n");
			expect(parseHoldingRatios(csv).ratio).toBe(7);
		});

		it("該当行が無ければ null", () => {
			expect(parseHoldingRatios(header)).toEqual({
				ratio: null,
				prevRatio: null,
			});
		});
	});

	describe("holdingItems", () => {
		const TODAY = "2026-11-13";
		const r = (p: Partial<LargeHoldingRow>): LargeHoldingRow => ({
			filer: "A",
			report_kind: "change",
			special: false,
			submit_date: "2026-11-10",
			ratio: 6,
			prev_ratio: 5,
			...p,
		});

		it("提出者ごとの最新 1 件に絞り、特例は 1pt 以上動いたものだけ残す", () => {
			expect(
				holdingItems(
					[
						r({
							filer: "A",
							submit_date: "2026-11-10",
							ratio: 7,
							prev_ratio: 6,
						}),
						r({ filer: "A", submit_date: "2026-10-01" }),
						r({ filer: "B", special: true, ratio: 5.5, prev_ratio: 5.2 }),
						r({ filer: "C", special: true, ratio: 8.1, prev_ratio: 6.9 }),
						r({ filer: "D", special: true, ratio: null, prev_ratio: null }),
					],
					TODAY,
				),
			).toEqual([
				{
					date: "2026-11-10",
					kind: "large_holding_change",
					filer: "A",
					ratio_pct: 7,
					prev_ratio_pct: 6,
					days_since: 3,
				},
				{
					date: "2026-11-10",
					kind: "large_holding_change",
					filer: "C",
					ratio_pct: 8.1,
					prev_ratio_pct: 6.9,
					special: true,
					days_since: 3,
				},
			]);
		});

		it("新規報告は割合が取れなくても残し、90 日より前と上限超えは落とす", () => {
			const out = holdingItems(
				[
					r({ filer: "N", report_kind: "new", ratio: null, prev_ratio: null }),
					r({ filer: "B" }),
					r({ filer: "C" }),
					r({ filer: "D" }),
					r({ filer: "Old", submit_date: "2026-07-01" }),
				],
				TODAY,
			);
			expect(out.map((x) => x.filer)).toEqual(["N", "B", "C"]);
			expect(out[0]).toEqual({
				date: "2026-11-10",
				kind: "large_holding_new",
				filer: "N",
				ratio_pct: null,
				days_since: 3,
			});
		});
	});
}
