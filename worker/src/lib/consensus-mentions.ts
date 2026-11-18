// 直近決算の発表日以降に出た株探記事から、市場予想 (コンセンサス) に触れた文を抜き出す。
// 予想値そのものは収集しないので、記事が市場予想比をどう書いたかを文と出典で渡すだけにする。
//
//   readConsensusMentions(env, code, announcedAt)
//     → 発表日から WINDOW_DAYS 暦日以内の kabutan:<code> 記事本文 (R2) を読み、
//       「市場予想」「コンセンサス」を含む文を {date, text, url} で最大 MAX_MENTIONS 件返す。

import { and, asc, eq, gte, lte } from "drizzle-orm";
import { db } from "./db";
import type { Env } from "./env";
import { articles } from "./schema";

export interface ConsensusMention {
	date: string; // 記事の公開日 YYYY-MM-DD
	text: string; // 該当文 (MAX_TEXT_LEN で切り詰め)
	url: string;
}

export interface MentionSource {
	date: string;
	url: string;
	body: string | null;
}

const WINDOW_DAYS = 7;
const MAX_MENTIONS = 3;
// LLM 入力を細く保つため、1文が長い記事 (表の地の文化など) はここで切る。
const MAX_TEXT_LEN = 200;
const CONSENSUS_RE = /市場予想|コンセンサス/;

function addDays(date: string, n: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

// 本文を「。」と改行で文に割る。句点は文に残す。
function splitSentences(body: string): string[] {
	return body
		.split(/(?<=。)|\n/)
		.map((s) => s.replace(/\s+/g, " ").trim())
		.filter((s) => s.length > 0);
}

// 先頭から切ると該当語が落ちるので、一致位置を中心に MAX_TEXT_LEN 文字を残す。
function clip(s: string, matchAt: number): string {
	if (s.length <= MAX_TEXT_LEN) return s;
	const start = Math.min(
		Math.max(0, matchAt - MAX_TEXT_LEN / 2),
		s.length - MAX_TEXT_LEN,
	);
	const end = start + MAX_TEXT_LEN;
	return `${start > 0 ? "…" : ""}${s.slice(start, end)}${end < s.length ? "…" : ""}`;
}

/**
 * sources (順不同) のうち公開日が announcedAt 〜 announcedAt + WINDOW_DAYS のものを古い順に見て、
 * 市場予想・コンセンサスに触れた文を最大 MAX_MENTIONS 件返す。同じ文は1件にまとめる。
 * 発表前の記事 (決算プレビュー) は結果に対する市場予想比ではないので含めない。
 */
export function extractConsensusMentions(
	sources: MentionSource[],
	announcedAt: string,
): ConsensusMention[] {
	const until = addDays(announcedAt, WINDOW_DAYS);
	const inWindow = sources
		.filter((s) => s.body && s.date >= announcedAt && s.date <= until)
		.sort((a, b) => a.date.localeCompare(b.date));
	const out: ConsensusMention[] = [];
	const seen = new Set<string>();
	for (const s of inWindow) {
		for (const sentence of splitSentences(s.body as string)) {
			const at = sentence.search(CONSENSUS_RE);
			if (at < 0) continue;
			const text = clip(sentence, at);
			if (seen.has(text)) continue;
			seen.add(text);
			out.push({ date: s.date, text, url: s.url });
			if (out.length >= MAX_MENTIONS) return out;
		}
	}
	return out;
}

/**
 * D1 の articles (source = kabutan:<code>) から発表日以降 WINDOW_DAYS 日の記事を引き、
 * R2 の本文から extractConsensusMentions で該当文を返す。R2 の欠損・破損はその記事を飛ばす。
 */
export async function readConsensusMentions(
	env: Env,
	code: string,
	announcedAt: string,
): Promise<ConsensusMention[]> {
	const rows = await db(env.DB)
		.select({
			url: articles.url,
			date: articles.publishedAt,
			r2_key: articles.r2Key,
		})
		.from(articles)
		.where(
			and(
				eq(articles.ticker, code),
				eq(articles.source, `kabutan:${code}`),
				gte(articles.publishedAt, announcedAt),
				lte(articles.publishedAt, addDays(announcedAt, WINDOW_DAYS)),
			),
		)
		.orderBy(asc(articles.publishedAt))
		.all();

	const sources: MentionSource[] = await Promise.all(
		rows.map(async (r) => {
			let body: string | null = null;
			try {
				const obj = await env.ARTICLES.get(r.r2_key);
				if (obj) {
					const json = JSON.parse(await obj.text()) as { body?: string };
					body = json.body ?? null;
				}
			} catch {
				// 1記事の欠損で earnings_result 全体を落とさない。
			}
			return { date: r.date ?? "", url: r.url, body };
		}),
	);
	return extractConsensusMentions(sources, announcedAt);
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	const src = (date: string, body: string | null, url = `u-${date}`) => ({
		date,
		url,
		body,
	});

	describe("extractConsensusMentions", () => {
		it("発表日以降7日以内の記事から市場予想・コンセンサスに触れた文を古い順に返す", () => {
			const out = extractConsensusMentions(
				[
					src(
						"2026-10-29",
						"7-9月期の経常利益は前年比2倍。市場コンセンサスを上回った。\n株価は急伸。",
					),
					src(
						"2026-10-28",
						"アドバンテストが決算を発表。\n営業利益は市場予想を下回った。",
					),
				],
				"2026-10-28",
			);
			expect(out).toEqual([
				{
					date: "2026-10-28",
					text: "営業利益は市場予想を下回った。",
					url: "u-2026-10-28",
				},
				{
					date: "2026-10-29",
					text: "市場コンセンサスを上回った。",
					url: "u-2026-10-29",
				},
			]);
		});
		it("発表前の記事と8日目以降の記事は使わない", () => {
			expect(
				extractConsensusMentions(
					[
						src("2026-10-27", "市場予想は増益。"),
						src("2026-11-05", "市場予想を上回った。"),
					],
					"2026-10-28",
				),
			).toEqual([]);
			expect(
				extractConsensusMentions(
					[src("2026-11-04", "市場予想を上回った。")],
					"2026-10-28",
				),
			).toHaveLength(1);
		});
		it("最大3件、同じ文は1件にまとめ、本文なしは飛ばす", () => {
			const body =
				"A は市場予想超え。B は市場予想並み。C はコンセンサス未達。D は市場予想比で上振れ。";
			const out = extractConsensusMentions(
				[
					src("2026-10-28", "A は市場予想超え。", "dup"),
					src("2026-10-28", null, "none"),
					src("2026-10-29", body),
				],
				"2026-10-28",
			);
			expect(out.map((m) => m.text)).toEqual([
				"A は市場予想超え。",
				"B は市場予想並み。",
				"C はコンセンサス未達。",
			]);
		});
		it("該当文が無ければ空", () => {
			expect(
				extractConsensusMentions(
					[src("2026-10-28", "増収増益で着地。")],
					"2026-10-28",
				),
			).toEqual([]);
		});
		it("長い文は該当語を残して切り詰める", () => {
			const long = `${"あ".repeat(250)}市場予想を上回った${"い".repeat(250)}。`;
			const [m] = extractConsensusMentions(
				[src("2026-10-28", long)],
				"2026-10-28",
			);
			expect(m.text).toContain("市場予想を上回った");
			expect(m.text).toHaveLength(MAX_TEXT_LEN + 2);
			expect(m.text.startsWith("…")).toBe(true);
			expect(m.text.endsWith("…")).toBe(true);
		});
	});
}
