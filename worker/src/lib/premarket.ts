// Cloudflare Worker: 寄り前の地合い収集 (premarket backdrop)
//
// ローカルの scripts/fetch-premarket.ts (前夜マーケットモード) と同じ kabutan パーサを
// Worker に移植したもの。米国指数 (SOX/Nasdaq/Dow) と CME日経225先物(ドル建て) を取得し、
// jsonl ではなく D1 テーブル premarket_backdrop に INSERT OR REPLACE で冪等に書く。
//
// 前夜の米国市場 (とくに SOX) と日経先物が寄り付きの方向をかなり決めるため、これを
// 寄り前 intake cron が取得し、signal-judge の pre-open weighting の入力にする。
//
// ※寄前気配 (kehai) は寄りが読めないため移植しない (scripts 側にローカル資産として残置)。
// ※LLM は使わない。スクレイピング・正規化のみ。kabutan は全ソース UTF-8 なので iconv 不要。

import * as cheerio from "cheerio";
import { db } from "./db";
import { premarketBackdrop } from "./schema";
import { fetchHtml, sleep } from "./utils";

export interface PremarketEnv {
	DB: D1Database;
	USER_AGENT: string;
	MIN_INTERVAL_MS: string;
}

// ローカル config/sources.yaml の premarket.us_indexes / nikkei_futures と対応。
// Worker は読み取り専用 FS で yaml を持てないため、ここに写す (timeseries.ts の WATCHLIST と同じ方針)。
type UsIndexDef = { key: string; label: string; url: string };
const US_INDEXES: UsIndexDef[] = [
	{
		key: "sox",
		label: "SOX(フィラデルフィア半導体)",
		url: "https://us.kabutan.jp/indexes/%5ESOX",
	},
	{
		key: "ndx",
		label: "ナスダック総合",
		url: "https://us.kabutan.jp/indexes/%5EIXIC",
	},
	{ key: "dji", label: "NYダウ", url: "https://us.kabutan.jp/indexes/%5EDJI" },
];
const NIKKEI_FUTURES_URL =
	"https://s.kabutan.jp/futures/%E3%82%B7%E3%82%AB%E3%82%B4%E6%97%A5%E7%B5%8C%E5%B9%B3%E5%9D%87%E5%85%88%E7%89%A9%EF%BC%88%E3%83%89%E3%83%AB%E5%BB%BA%E3%81%A6%EF%BC%89";

type IndexQuote = {
	key: string;
	label: string;
	price: number | null;
	change: number | null;
	change_pct: number | null;
	// us.kabutan が出す参照時刻 (例: "27日 06:16") をそのまま保持。監査用。
	ny_time: string | null;
	jst_time: string | null;
};

// scripts/fetch-premarket.ts の toNumber と同じ (円/株/% や全角マイナスを吸収)。
function toNumber(raw: string | undefined | null): number | null {
	if (!raw) return null;
	const cleaned = raw.replace(/[,円株%＋+()]/g, "").trim();
	if (!cleaned || cleaned === "－" || cleaned === "ー" || cleaned === "-")
		return null;
	const n = Number(cleaned);
	return Number.isFinite(n) ? n : null;
}

// us.kabutan.jp の指数ページ。現値ブロック (.text-3xl) の親要素テキストは
//   "12,876.90 前日比 +674.36 (+5.53%) NY時間 26日 17:16 日本時間 27日 06:16"
// の形。正規表現で分解する。レイアウトが変わったら price だけでも返す。
function parseUsIndex(html: string, idx: UsIndexDef): IndexQuote {
	const $ = cheerio.load(html);
	const priceEl = $(".text-3xl").first();
	const block = priceEl.parent().text().replace(/\s+/g, " ").trim();

	const price = toNumber(priceEl.text());

	const chgMatch = block.match(
		/前日比\s*([+\-－ー]?[\d,]+(?:\.\d+)?)\s*\(\s*([+\-－ー]?[\d.]+)\s*%\s*\)/,
	);
	const change = chgMatch ? toNumber(chgMatch[1]) : null;
	const change_pct = chgMatch ? toNumber(chgMatch[2]) : null;

	const nyMatch = block.match(/NY時間\s*([0-9]{1,2}日\s*[0-9:]{4,5})/);
	const jstMatch = block.match(/日本時間\s*([0-9]{1,2}日\s*[0-9:]{4,5})/);

	return {
		key: idx.key,
		label: idx.label,
		price,
		change,
		change_pct,
		ny_time: nyMatch ? nyMatch[1].replace(/\s+/g, " ") : null,
		jst_time: jstMatch ? jstMatch[1].replace(/\s+/g, " ") : null,
	};
}

// CME日経225先物(ドル建て)ページ。.text-3xl 親は "65,560円 ー 円 ー 6月限" のように
// 現値+限月。前日比は空欄のことが多いので現値と限月だけ取る。
function parseNikkeiFutures(html: string): {
	price: number | null;
	contract: string | null;
} {
	const $ = cheerio.load(html);
	const priceEl = $(".text-3xl").first();
	const block = priceEl.parent().text().replace(/\s+/g, " ").trim();
	const price = toNumber(priceEl.text());
	const contractMatch = block.match(/([0-9]{1,2}月限)/);
	return { price, contract: contractMatch ? contractMatch[1] : null };
}

// 米国指数3本+日経先物を取得し、premarket_backdrop に1行 INSERT する (append-only)。
// 1指数が落ちても他は続行 (price=null で残す)。PK は取得時刻 (UTC ISO8601) なので
// 暦日変換は一切しない — 時差ズレを構造的に避けるため。同じ NY クローズを複数回取っても
// 取得ごとに別行が積まれるだけで、最新は fetched_at DESC LIMIT 1 で取れる。
export async function collectBackdrop(
	env: PremarketEnv,
): Promise<Record<string, unknown>> {
	const interval = parseInt(env.MIN_INTERVAL_MS, 10) || 5000;

	const us_indexes: IndexQuote[] = [];
	let first = true;
	for (const idx of US_INDEXES) {
		if (!first) await sleep(interval);
		first = false;
		try {
			us_indexes.push(parseUsIndex(await fetchHtml(idx.url, env), idx));
		} catch (e) {
			us_indexes.push({
				key: idx.key,
				label: idx.label,
				price: null,
				change: null,
				change_pct: null,
				ny_time: null,
				jst_time: null,
			});
			console.error(`premarket [${idx.key}] error: ${(e as Error).message}`);
		}
	}

	let nikkei: { price: number | null; contract: string | null } = {
		price: null,
		contract: null,
	};
	try {
		await sleep(interval);
		nikkei = parseNikkeiFutures(await fetchHtml(NIKKEI_FUTURES_URL, env));
	} catch (e) {
		console.error(`premarket [fut] error: ${(e as Error).message}`);
	}

	const pick = (key: string) =>
		us_indexes.find((q) => q.key === key)?.change_pct ?? null;
	const fetched_at = new Date().toISOString();

	const backdropRow = {
		fetchedAt: fetched_at,
		soxChangePct: pick("sox"),
		nasdaqChangePct: pick("ndx"),
		dowChangePct: pick("dji"),
		nikkeiFuturesPrice: nikkei.price,
		nikkeiContract: nikkei.contract,
		usIndexesJson: JSON.stringify(us_indexes),
	};
	await db(env.DB)
		.insert(premarketBackdrop)
		.values(backdropRow)
		.onConflictDoUpdate({
			target: premarketBackdrop.fetchedAt,
			set: {
				soxChangePct: backdropRow.soxChangePct,
				nasdaqChangePct: backdropRow.nasdaqChangePct,
				dowChangePct: backdropRow.dowChangePct,
				nikkeiFuturesPrice: backdropRow.nikkeiFuturesPrice,
				nikkeiContract: backdropRow.nikkeiContract,
				usIndexesJson: backdropRow.usIndexesJson,
			},
		})
		.run();

	return {
		fetched_at,
		sox_change_pct: pick("sox"),
		nasdaq_change_pct: pick("ndx"),
		dow_change_pct: pick("dji"),
		nikkei_futures_price: nikkei.price,
		nikkei_contract: nikkei.contract,
	};
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;
	const SOX = US_INDEXES[0];

	describe("toNumber", () => {
		it("カンマ・単位・符号装飾 (円/株/%/＋/+/括弧) を除く", () => {
			expect(toNumber("12,876.90")).toBe(12876.9);
			expect(toNumber("＋674.36")).toBe(674.36);
			expect(toNumber("(5.53)%")).toBe(5.53);
		});
		it("全角/半角マイナスは数値として残る", () => {
			expect(toNumber("-1.2")).toBe(-1.2);
		});
		it("空・各種ダッシュ・null は null", () => {
			expect(toNumber(null)).toBeNull();
			expect(toNumber("")).toBeNull();
			expect(toNumber("－")).toBeNull();
			expect(toNumber("ー")).toBeNull();
			expect(toNumber("-")).toBeNull();
		});
	});

	describe("parseUsIndex", () => {
		// us.kabutan の現値ブロック: .text-3xl が現値、親要素テキストに前日比・参照時刻が並ぶ。
		const html = [
			"<div>",
			"<span class='text-3xl'>12,876.90</span>",
			" 前日比 +674.36 (+5.53%) NY時間 26日 17:16 日本時間 27日 06:16",
			"</div>",
		].join("");

		it("現値・前日比・変化率・NY/JST時刻を分解する", () => {
			const q = parseUsIndex(html, SOX);
			expect(q).toMatchObject({
				key: "sox",
				price: 12876.9,
				change: 674.36,
				change_pct: 5.53,
				ny_time: "26日 17:16",
				jst_time: "27日 06:16",
			});
		});
		it("前日比ブロックが無くても price だけは返す", () => {
			const q = parseUsIndex(
				"<div><span class='text-3xl'>1,234.5</span></div>",
				SOX,
			);
			expect(q.price).toBe(1234.5);
			expect(q.change).toBeNull();
			expect(q.change_pct).toBeNull();
		});
	});

	describe("parseNikkeiFutures", () => {
		it("現値と限月を取る (前日比空欄は無視)", () => {
			const html =
				"<div><span class='text-3xl'>65,560円</span> ー 円 ー 6月限</div>";
			expect(parseNikkeiFutures(html)).toEqual({
				price: 65560,
				contract: "6月限",
			});
		});
		it("限月が無ければ contract=null", () => {
			const html = "<div><span class='text-3xl'>65,560円</span></div>";
			expect(parseNikkeiFutures(html)).toEqual({
				price: 65560,
				contract: null,
			});
		});
	});
}
