// Cloudflare Worker: 場中リアルタイム指数の収集 (live indexes)
//
// 前夜確定の premarket_backdrop (SOX/Nasdaq/Dow/日経先物) と違い、日本市場と同時進行で動く
// 指数の「今の現値」を場中 5分毎 cron に相乗りして貯める。地合い (market-check) が、寄り前の
// premarket に加えて「アジアが今どう動いているか」を読めるようにするのが狙い。
//
// 収集対象:
//   - nikkei225: kabutan の日経平均ページ (code=0000)。個別銘柄と同じ .si_i1_2 ブロック構造なので
//     現値/前日比/変化率/時刻をそのまま拾える。premarket の日経先物 (寄り前) に対する場中の現値。
//   - kospi: investing.com の KOSPI ページ。半導体 (サムスン/SKハイニックス) 比重が高く、この
//     半導体ウォッチリストとの連動性が高いアジア同時進行指数。kabutan に指数ページが無いため別ソース。
//
// prices と同じ「5分枠で1行」冪等モデル (slot5min + onConflictDoNothing)。※LLM は使わない。

import * as cheerio from "cheerio";
import { db } from "./db";
import { sliceStockInfo } from "./kabutan";
import { liveIndexes } from "./schema";
import { fetchHtml, sleep } from "./utils";

export interface LiveIndexEnv {
	DB: D1Database;
	USER_AGENT: string;
	MIN_INTERVAL_MS: string;
}

type Parser = "kabutan" | "investing";
type IndexDef = { key: string; label: string; url: string; parser: Parser };

const INDEX_DEFS: IndexDef[] = [
	{
		key: "nikkei225",
		label: "日経平均株価(225種)",
		url: "https://kabutan.jp/stock/?code=0000",
		parser: "kabutan",
	},
	{
		key: "kospi",
		label: "韓国 KOSPI",
		url: "https://www.investing.com/indices/kospi",
		parser: "investing",
	},
];

type IndexQuote = {
	price: number | null;
	change: number | null;
	change_pct: number | null;
	quote_time: string | null;
};

// カンマ・単位・全角ダッシュ・符号装飾 (＋/+/%/括弧) を除いて number へ。
function toNumber(raw: string | undefined | null): number | null {
	if (!raw) return null;
	const cleaned = raw.replace(/[,円株%％＋+()]/g, "").trim();
	if (!cleaned || cleaned === "－" || cleaned === "ー" || cleaned === "-")
		return null;
	const n = Number(cleaned);
	return Number.isFinite(n) ? n : null;
}

// ISO8601 を5分枠に丸めたキー (timeseries.slot5min と同じ規則)。
// quote_time (JST/UTC どちらでも) か fetched_at を「自分の時計の5分枠」に落として冪等キーにする。
function slot5min(iso: string): string {
	const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
	if (!m) return iso;
	const floored = Math.floor(parseInt(m[3], 10) / 5) * 5;
	return `${m[1]}T${m[2]}:${String(floored).padStart(2, "0")}`;
}

// 株探の指数ページ (日経平均/TOPIX 等)。個別銘柄の現値ページと同じ .si_i1_2 ブロック構造。
function parseKabutanIndex(html: string): IndexQuote {
	const $ = cheerio.load(sliceStockInfo(html));
	const block = $(".si_i1_2").first();
	const price = toNumber(block.find(".kabuka").first().text());
	const dds = block.find(".si_i1_dl1 dd");
	const change = toNumber(dds.eq(0).find("span").first().text());
	const change_pct = toNumber(dds.eq(1).find("span").first().text());
	const quote_time = $("#stockinfo_i1 time").first().attr("datetime") || null;
	return { price, change, change_pct, quote_time };
}

// investing.com のページは 1MB を超え、そのまま parse すると CPU を数百ms食う。
// data-test 属性が並ぶ現値ブロック (price-last → change → change-percent →
// trading-time-label の順) の数KBだけを切り出す。並びが違う/マーカーが無ければ全文を返す。
function sliceInstrument(html: string): string {
	const s = html.indexOf('data-test="instrument-price-last"');
	const t = html.indexOf('data-test="trading-time-label"');
	if (s < 0 || t < 0 || t < s) return html;
	const start = html.lastIndexOf("<", s);
	const timeEnd = html.indexOf("</time>", t);
	return html.slice(
		start,
		timeEnd < 0 ? t + 2_000 : timeEnd + "</time>".length,
	);
}

// investing.com の指数ページ。値は data-test 属性で安定して取れる:
//   instrument-price-last / -change / -change-percent、時刻は <time data-test="trading-time-label">。
//   change-percent は "(-2.04%)" のように括弧付きなので toNumber が括弧を剥がす。
//   quote_time は <time dateTime="…"> の ISO8601 (UTC) を優先し、無ければ表示テキスト。
function parseInvestingIndex(html: string): IndexQuote {
	const $ = cheerio.load(sliceInstrument(html));
	const price = toNumber(
		$('[data-test="instrument-price-last"]').first().text(),
	);
	const change = toNumber(
		$('[data-test="instrument-price-change"]').first().text(),
	);
	const change_pct = toNumber(
		$('[data-test="instrument-price-change-percent"]').first().text(),
	);
	const timeEl = $('[data-test="trading-time-label"]').first();
	const quote_time =
		timeEl.attr("dateTime") ||
		timeEl.attr("datetime") ||
		timeEl.text().trim() ||
		null;
	return { price, change, change_pct, quote_time };
}

function parse(parser: Parser, html: string): IndexQuote {
	return parser === "kabutan"
		? parseKabutanIndex(html)
		: parseInvestingIndex(html);
}

// 全指数を順次取得し、live_indexes に (key, slot) 冪等で書く (append-only 相当)。
// 1指数が落ちても他は続行。値付き時刻があればそれを、無ければ取得時刻を5分枠に丸めてキーにする。
export async function collectLiveIndexes(
	env: LiveIndexEnv,
): Promise<Record<string, unknown>> {
	const interval = parseInt(env.MIN_INTERVAL_MS, 10) || 5000;
	const results: Record<string, unknown> = {};
	let first = true;
	for (const def of INDEX_DEFS) {
		if (!first) await sleep(interval);
		first = false;
		try {
			const q = parse(def.parser, await fetchHtml(def.url, env));
			const fetched_at = new Date().toISOString();
			const slot = slot5min(q.quote_time || fetched_at);
			const r = await db(env.DB)
				.insert(liveIndexes)
				.values({
					key: def.key,
					slot,
					source: def.parser,
					price: q.price,
					change: q.change,
					changePct: q.change_pct,
					quoteTime: q.quote_time,
					fetchedAt: fetched_at,
				})
				.onConflictDoNothing()
				.run();
			const written = r.meta.changes ?? 0;
			results[def.key] = { written, skipped: written ? 0 : 1, ...q };
		} catch (e) {
			results[def.key] = { error: (e as Error).message };
			console.error(`live-index [${def.key}] error: ${(e as Error).message}`);
		}
	}
	return results;
}

// ── 出力整形 (route が D1 から引いた各指数の最新行を読み手向けに整える純粋ロジック) ──

// 表示順とラベル。route は key ごとの最新 1 行を引いて渡すだけ。
const DISPLAY: { key: string; label: string }[] = INDEX_DEFS.map((d) => ({
	key: d.key,
	label: d.label,
}));

export type LiveIndexRow = {
	key: string;
	price?: number | null;
	change?: number | null;
	change_pct?: number | null;
	quote_time?: string | null;
	fetched_at?: string | null;
};

// /market-context 用 live_indexes ブロック。key ごとに最新行を並べ、age>1h で stale 判定。
// 場中に同時進行で動く指数なので premarket (age>20h) より鮮度の閾値をきつく取る。
//   行なし key → 出さない。全 key 行なし → { status: "unavailable", indexes: [] }
export function buildLiveIndexesBlock(
	rows: LiveIndexRow[],
	epochNow: number,
): Record<string, unknown> {
	const byKey = new Map(rows.map((r) => [r.key, r]));
	const indexes = DISPLAY.flatMap((d) => {
		const r = byKey.get(d.key);
		if (!r?.fetched_at) return [];
		const ageH = Math.floor(
			(epochNow - new Date(r.fetched_at).getTime()) / 3600_000,
		);
		return [
			{
				key: d.key,
				label: d.label,
				status: ageH > 1 ? "stale" : "ok",
				age_hours: ageH,
				price: r.price ?? null,
				change: r.change ?? null,
				change_pct: r.change_pct ?? null,
				quote_time: r.quote_time ?? null,
			},
		];
	});
	return indexes.length > 0
		? { status: "ok", indexes }
		: { status: "unavailable", indexes: [] };
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("toNumber", () => {
		it("カンマ・単位・符号装飾を除く", () => {
			expect(toNumber("70,474.96")).toBe(70474.96);
			expect(toNumber("+412.64")).toBe(412.64);
			expect(toNumber("(-2.04%)")).toBe(-2.04);
		});
		it("空・各種ダッシュは null", () => {
			expect(toNumber(null)).toBeNull();
			expect(toNumber("－")).toBeNull();
			expect(toNumber("-")).toBeNull();
		});
	});

	describe("slot5min", () => {
		it("分を5分枠に切り下げ TZ を捨てる", () => {
			expect(slot5min("2026-07-01T15:31:00+09:00")).toBe("2026-07-01T15:30");
			expect(slot5min("2026-07-01T06:29:59.000Z")).toBe("2026-07-01T06:25");
		});
		it("想定外フォーマットはそのまま", () => {
			expect(slot5min("not-a-date")).toBe("not-a-date");
		});
	});

	describe("parseKabutanIndex", () => {
		// 日経平均ページの現値ブロック (個別銘柄と同じ .si_i1_2 構造)。
		const html = `
			<div id="stockinfo_i1">
				<div class="si_i1_2">
					<span class="kabuka">70,474.96</span>
					<dl class="si_i1_dl1">
						<dd><span>+412.64</span></dd>
						<dd><span>+0.59%</span></dd>
					</dl>
				</div>
				<time datetime="2026-07-01T15:30+09:00"></time>
			</div>`;
		it("現値・前日比・変化率・時刻を抽出する", () => {
			expect(parseKabutanIndex(html)).toEqual({
				price: 70474.96,
				change: 412.64,
				change_pct: 0.59,
				quote_time: "2026-07-01T15:30+09:00",
			});
		});
		it("空 HTML は全 null", () => {
			expect(parseKabutanIndex("<html></html>")).toEqual({
				price: null,
				change: null,
				change_pct: null,
				quote_time: null,
			});
		});
	});

	describe("parseInvestingIndex", () => {
		// investing.com KOSPI ページの data-test 属性群 (括弧付き変化率・<time dateTime>)。
		const html = `
			<div data-test="instrument-price-last">8,303.41</div>
			<span data-test="instrument-price-change">-173.07</span>
			<span data-test="instrument-price-change-percent">(-2.04%)</span>
			<time dateTime="2026-07-01T06:29:59.000Z" data-test="trading-time-label">02:29:59</time>`;
		it("現値・前日比・括弧付き変化率・ISO時刻を抽出する", () => {
			expect(parseInvestingIndex(html)).toEqual({
				price: 8303.41,
				change: -173.07,
				change_pct: -2.04,
				quote_time: "2026-07-01T06:29:59.000Z",
			});
		});
		it("dateTime が無ければ表示テキストを時刻に使う", () => {
			const q = parseInvestingIndex(
				'<time data-test="trading-time-label">02:29:59</time>',
			);
			expect(q.quote_time).toBe("02:29:59");
		});
		it("空 HTML は全 null", () => {
			expect(parseInvestingIndex("<html></html>")).toEqual({
				price: null,
				change: null,
				change_pct: null,
				quote_time: null,
			});
		});
	});

	describe("buildLiveIndexesBlock", () => {
		const NOW = new Date("2026-07-01T06:00:00Z").getTime();

		it("行なしは unavailable", () => {
			expect(buildLiveIndexesBlock([], NOW)).toEqual({
				status: "unavailable",
				indexes: [],
			});
		});
		it("age<=1h は ok、INDEX_DEFS の順で並ぶ", () => {
			const b = buildLiveIndexesBlock(
				[
					{
						key: "kospi",
						price: 8303.41,
						change_pct: -2.04,
						fetched_at: new Date(NOW - 10 * 60_000).toISOString(),
					},
					{
						key: "nikkei225",
						price: 70474.96,
						change_pct: 0.59,
						fetched_at: new Date(NOW - 10 * 60_000).toISOString(),
					},
				],
				NOW,
			) as { status: string; indexes: { key: string; status: string }[] };
			expect(b.status).toBe("ok");
			// DISPLAY (=INDEX_DEFS) 順: nikkei225 が先、kospi が後。
			expect(b.indexes.map((i) => i.key)).toEqual(["nikkei225", "kospi"]);
			expect(b.indexes[0].status).toBe("ok");
		});
		it("age>1h は stale、行なし key は出さない", () => {
			const b = buildLiveIndexesBlock(
				[
					{
						key: "nikkei225",
						price: 1,
						fetched_at: new Date(NOW - 2 * 3600_000).toISOString(),
					},
				],
				NOW,
			) as { indexes: { key: string; status: string }[] };
			expect(b.indexes).toHaveLength(1);
			expect(b.indexes[0].status).toBe("stale");
		});
	});
}
