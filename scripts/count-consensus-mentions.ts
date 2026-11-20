// scripts/count-consensus-mentions.ts
//
// 監視銘柄の決算発表 (D1 earnings_quarters.announced_at) ごとに、発表日〜発表日 + MENTION_WINDOW_DAYS
// 暦日の株探記事 (D1 articles, source = kabutan:<code>) の R2 本文を読み、「市場予想」「コンセンサス」を
// 含む文を数える。/judge-context の earnings_result.consensus_mentions が拾う範囲と同じ記事・同じ文の
// 判定を使い、1 決算 3 件の上限は掛けずに全件を数える。
//
// 実行:   pnpm run count:consensus-mentions [--since YYYY-MM-DD] [--show]   (リポジトリ直下で)
//   --since  この日以降に発表された決算だけを見る (既定: JST 今日の 1 年前)
//   --show   該当した文を日付・URL 付きで全件出す
// 本番の D1/R2 を worker/ の wrangler で読むので、先に `pnpm -C worker exec wrangler login` しておく。

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
	consensusSentences,
	MENTION_WINDOW_DAYS,
} from "../worker/src/lib/consensus-text.ts";
import { WATCHLIST } from "../worker/src/lib/watchlist.ts";

const D1_NAME = "stock-signals";
const R2_BUCKET = "stock-signals-articles";

/** 決算 1 件とその窓に入った記事 1 件 (記事が無い決算は url/r2_key が null)。 */
interface Row {
	ticker: string;
	period: string;
	announced_at: string;
	url: string | null;
	published_at: string | null;
	r2_key: string | null;
}

interface Hit {
	ticker: string;
	date: string;
	url: string;
	sentence: string;
}

interface TickerTally {
	earnings: number;
	articles: number;
	unreadable: number;
	matchedArticles: number;
	sentences: number;
}

/**
 * codes の決算のうち since 以降に発表されたものを、窓に入った株探記事と LEFT JOIN して返す SQL。
 * D1 に渡す SQL は文字列でしか組めないので、埋め込む値はここで形を検査する。
 */
function buildSql(codes: string[], since: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
		throw new Error(`--since は YYYY-MM-DD で指定する: ${since}`);
	}
	if (codes.length === 0) throw new Error("監視銘柄が空");
	for (const c of codes) {
		if (!/^[0-9A-Z]+$/.test(c)) throw new Error(`想定外の銘柄コード: ${c}`);
	}
	const inList = codes.map((c) => `'${c}'`).join(", ");
	return [
		"SELECT q.ticker AS ticker, q.period AS period, q.announced_at AS announced_at,",
		"  a.url AS url, a.published_at AS published_at, a.r2_key AS r2_key",
		"FROM earnings_quarters q",
		"LEFT JOIN articles a",
		"  ON a.ticker = q.ticker AND a.source = 'kabutan:' || q.ticker",
		"  AND a.published_at >= q.announced_at",
		`  AND a.published_at <= date(q.announced_at, '+${MENTION_WINDOW_DAYS} days')`,
		`WHERE q.announced_at >= '${since}' AND q.ticker IN (${inList})`,
		"ORDER BY q.ticker, q.announced_at, a.published_at",
	].join("\n");
}

/** `wrangler d1 execute --json` の標準出力から結果行を取り出す。失敗した文があれば throw。 */
function parseD1Rows(stdout: string): Row[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error(
			`wrangler d1 execute の出力が JSON でない:\n${stdout.slice(0, 500)}`,
		);
	}
	if (!Array.isArray(parsed)) {
		throw new Error("wrangler d1 execute の出力が配列でない");
	}
	const rows: Row[] = [];
	for (const stmt of parsed as { success?: boolean; results?: Row[] }[]) {
		if (stmt.success === false || !Array.isArray(stmt.results)) {
			throw new Error("wrangler d1 execute のクエリが失敗した");
		}
		rows.push(...stmt.results);
	}
	return rows;
}

/** R2 の記事 JSON から本文を取り出す。JSON でないか body が無ければ null。 */
function parseArticleBody(raw: string): string | null {
	try {
		const body = (JSON.parse(raw) as { body?: unknown }).body;
		return typeof body === "string" ? body : null;
	} catch {
		return null;
	}
}

/**
 * rows を銘柄ごとに集計する。bodyOf は r2_key から本文を返し、読めなければ null を返す。
 * 同じ記事が 2 つの決算の窓に入っても記事・文は 1 回だけ数える。
 */
function tally(
	rows: Row[],
	bodyOf: (r2Key: string) => string | null,
): { byTicker: Map<string, TickerTally>; hits: Hit[] } {
	const byTicker = new Map<string, TickerTally>();
	const hits: Hit[] = [];
	const seenEarnings = new Set<string>();
	const seenArticles = new Set<string>();
	for (const r of rows) {
		let t = byTicker.get(r.ticker);
		if (!t) {
			t = {
				earnings: 0,
				articles: 0,
				unreadable: 0,
				matchedArticles: 0,
				sentences: 0,
			};
			byTicker.set(r.ticker, t);
		}
		const earningsKey = `${r.ticker}|${r.period}`;
		if (!seenEarnings.has(earningsKey)) {
			seenEarnings.add(earningsKey);
			t.earnings++;
		}
		if (!r.url || !r.r2_key || seenArticles.has(r.url)) continue;
		seenArticles.add(r.url);
		t.articles++;
		const body = bodyOf(r.r2_key);
		if (body === null) {
			t.unreadable++;
			continue;
		}
		const found = consensusSentences(body, r.ticker);
		if (found.length === 0) continue;
		t.matchedArticles++;
		t.sentences += found.length;
		for (const { sentence } of found) {
			hits.push({
				ticker: r.ticker,
				date: r.published_at ?? "",
				url: r.url,
				sentence,
			});
		}
	}
	return { byTicker, hits };
}

function wrangler(args: string[]): string {
	return execFileSync("pnpm", ["-C", "worker", "exec", "wrangler", ...args], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function readR2Body(r2Key: string): string | null {
	try {
		return parseArticleBody(
			wrangler([
				"r2",
				"object",
				"get",
				`${R2_BUCKET}/${r2Key}`,
				"--remote",
				"--pipe",
			]),
		);
	} catch {
		return null;
	}
}

function oneYearAgoJst(): string {
	const d = new Date(Date.now() + 9 * 3600_000);
	d.setUTCFullYear(d.getUTCFullYear() - 1);
	return d.toISOString().slice(0, 10);
}

function main(): void {
	const { values } = parseArgs({
		options: {
			since: { type: "string" },
			show: { type: "boolean", default: false },
		},
	});
	const since = values.since ?? oneYearAgoJst();
	const rows = parseD1Rows(
		wrangler([
			"d1",
			"execute",
			D1_NAME,
			"--remote",
			"--json",
			"--command",
			buildSql(WATCHLIST, since),
		]),
	);

	const keys = new Set(rows.flatMap((r) => (r.r2_key ? [r.r2_key] : [])));
	const bodies = new Map<string, string | null>();
	let done = 0;
	for (const key of keys) {
		bodies.set(key, readR2Body(key));
		done++;
		process.stderr.write(`\rR2 本文を読込中 ${done}/${keys.size}`);
	}
	if (keys.size > 0) process.stderr.write("\n");

	const { byTicker, hits } = tally(rows, (k) => bodies.get(k) ?? null);
	const sum: TickerTally = {
		earnings: 0,
		articles: 0,
		unreadable: 0,
		matchedArticles: 0,
		sentences: 0,
	};
	console.log(
		`決算発表 ${since} 以降・発表日〜+${MENTION_WINDOW_DAYS} 日の株探記事 (source=kabutan:<code>)`,
	);
	console.log("銘柄\t決算\t記事\t本文欠損\t該当記事\t該当文");
	for (const [ticker, t] of [...byTicker].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		console.log(
			`${ticker}\t${t.earnings}\t${t.articles}\t${t.unreadable}\t${t.matchedArticles}\t${t.sentences}`,
		);
		for (const k of Object.keys(sum) as (keyof TickerTally)[]) sum[k] += t[k];
	}
	console.log(
		`合計\t${sum.earnings}\t${sum.articles}\t${sum.unreadable}\t${sum.matchedArticles}\t${sum.sentences}`,
	);
	if (values.show) {
		for (const h of hits) {
			console.log(`\n${h.ticker} ${h.date} ${h.url}\n  ${h.sentence}`);
		}
	}
}

if (!import.meta.vitest) {
	try {
		main();
	} catch (e) {
		console.error(e instanceof Error ? e.message : e);
		process.exit(1);
	}
}

// in-source tests (vitest.config.ts 参照)
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	const row = (over: Partial<Row>): Row => ({
		ticker: "6857",
		period: "2026.07-09",
		announced_at: "2026-10-28",
		url: null,
		published_at: null,
		r2_key: null,
		...over,
	});

	describe("buildSql", () => {
		it("監視銘柄と since を埋め、窓を MENTION_WINDOW_DAYS で切る", () => {
			const sql = buildSql(["6857", "285A"], "2025-11-20");
			expect(sql).toContain("q.ticker IN ('6857', '285A')");
			expect(sql).toContain("q.announced_at >= '2025-11-20'");
			expect(sql).toContain(
				`date(q.announced_at, '+${MENTION_WINDOW_DAYS} days')`,
			);
			expect(sql).toContain("a.source = 'kabutan:' || q.ticker");
		});
		it("形の合わない値は throw", () => {
			expect(() => buildSql(["6857"], "2025/11/20")).toThrow(/since/);
			expect(() => buildSql(["68'57"], "2025-11-20")).toThrow(/銘柄コード/);
			expect(() => buildSql([], "2025-11-20")).toThrow(/空/);
		});
	});

	describe("parseD1Rows", () => {
		it("全文の results を連結する", () => {
			const out = JSON.stringify([
				{ success: true, results: [row({ url: "u1" })] },
				{ success: true, results: [row({ url: "u2" })] },
			]);
			expect(parseD1Rows(out).map((r) => r.url)).toEqual(["u1", "u2"]);
		});
		it("JSON でない・失敗した文は throw", () => {
			const failed = JSON.stringify([{ success: false }]);
			expect(() => parseD1Rows("✘ ERROR")).toThrow(/JSON/);
			expect(() => parseD1Rows(failed)).toThrow(/失敗/);
		});
	});

	describe("parseArticleBody", () => {
		it("body を返し、無いか壊れていれば null", () => {
			expect(parseArticleBody('{"body":"本文"}')).toBe("本文");
			expect(parseArticleBody('{"title":"x"}')).toBeNull();
			expect(parseArticleBody("not json")).toBeNull();
		});
	});

	describe("tally", () => {
		it("決算・記事・欠損・該当を銘柄ごとに数え、同じ記事は 1 回だけ数える", () => {
			const bodies: Record<string, string> = {
				k1: "増益。営業利益は市場予想を上回った。\nコンセンサスも超過。",
				k2: "増収増益で着地。",
			};
			const { byTicker, hits } = tally(
				[
					row({ url: "u1", published_at: "2026-10-28", r2_key: "k1" }),
					row({ url: "u2", published_at: "2026-10-29", r2_key: "k2" }),
					row({ url: "u3", published_at: "2026-10-30", r2_key: "gone" }),
					row({
						period: "2026.10-12",
						announced_at: "2026-10-30",
						url: "u1",
						published_at: "2026-10-28",
						r2_key: "k1",
					}),
					row({ ticker: "285A", period: "2026.07-09" }),
				],
				(k) => bodies[k] ?? null,
			);
			expect(byTicker.get("6857")).toEqual({
				earnings: 2,
				articles: 3,
				unreadable: 1,
				matchedArticles: 1,
				sentences: 2,
			});
			expect(byTicker.get("285A")).toEqual({
				earnings: 1,
				articles: 0,
				unreadable: 0,
				matchedArticles: 0,
				sentences: 0,
			});
			expect(hits).toEqual([
				{
					ticker: "6857",
					date: "2026-10-28",
					url: "u1",
					sentence: "営業利益は市場予想を上回った。",
				},
				{
					ticker: "6857",
					date: "2026-10-28",
					url: "u1",
					sentence: "コンセンサスも超過。",
				},
			]);
		});
	});
}
