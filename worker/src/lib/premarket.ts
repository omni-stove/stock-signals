// Cloudflare Worker: 寄り前の地合い収集 (premarket backdrop)
//
// kabutan パーサで米国指数 (SOX/Nasdaq/Dow) と CME日経225先物(ドル建て) を取得し、
// D1 テーブル premarket_backdrop に INSERT OR REPLACE で冪等に書く。
//
// 前夜の米国市場 (とくに SOX) と日経先物が寄り付きの方向をかなり決めるため、これを
// 寄り前 intake cron が取得し、ticker-brief の pre-open weighting の入力にする。
//
// ※LLM は使わない。スクレイピング・正規化のみ。kabutan は全ソース UTF-8 なので iconv 不要。

import { db } from "./db";
import { stripTags } from "./html";
import { premarketBackdrop } from "./schema";
import { fetchHtml, sleep } from "./utils";

export interface PremarketEnv {
	DB: D1Database;
	USER_AGENT: string;
	MIN_INTERVAL_MS: string;
}

// 取得対象の URL テンプレート (米国指数 / 日経先物)。
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

// 数値文字列を number へ (円/株/% や全角マイナスを吸収)。
function toNumber(raw: string | undefined | null): number | null {
	if (!raw) return null;
	const cleaned = raw.replace(/[,円株%＋+()]/g, "").trim();
	if (!cleaned || cleaned === "－" || cleaned === "ー" || cleaned === "-")
		return null;
	const n = Number(cleaned);
	return Number.isFinite(n) ? n : null;
}

// us.kabutan.jp の指数ページ。現値ブロック (.text-3xl) の周辺テキストは
//   "12,876.90 前日比 +674.36 (+5.53%) NY時間 26日 17:16 日本時間 27日 06:16"
// の形。最初の text-3xl 要素から 2KB 窓のタグを剥がしてテキスト化し (親要素テキスト相当)、
// 正規表現で分解する。レイアウトが変わったら price だけでも返す。
function textAroundPriceEl(html: string): string {
	const anchor = html.indexOf("text-3xl");
	if (anchor < 0) return "";
	const start = html.lastIndexOf("<", anchor);
	return stripTags(html.slice(start, start + 2_000));
}

function parseUsIndex(html: string, idx: UsIndexDef): IndexQuote {
	const block = textAroundPriceEl(html);

	// 窓テキストは現値そのものから始まる (.text-3xl のタグ直後のテキスト)。
	const priceMatch = block.match(/^[＋+\-－ー]?[\d,]+(?:\.\d+)?/);
	const price = toNumber(priceMatch ? priceMatch[0] : null);

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

// CME日経225先物(ドル建て)ページ。.text-3xl 周辺は "65,560円 ー 円 ー 6月限" のように
// 現値+限月。前日比は空欄のことが多いので現値と限月だけ取る。
function parseNikkeiFutures(html: string): {
	price: number | null;
	contract: string | null;
} {
	const block = textAroundPriceEl(html);
	const priceMatch = block.match(/^[\d,]+(?:\.\d+)?/);
	const price = toNumber(priceMatch ? priceMatch[0] : null);
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

// ── 出力整形 (routes が D1 から引いた premarket 行を読み手向けに整える純粋ロジック) ──
// 取得 (collectBackdrop) と読み出し整形を同じモジュールに置く。HTTP には依存しない。

// us_indexes_json (JSON 文字列) を配列へパースする。壊れた/欠損 JSON は空配列にフォールバック。
export function parseUsIndexes(json: string | null | undefined): unknown {
	if (!json) return [];
	try {
		return JSON.parse(json);
	} catch {
		return [];
	}
}

// /latest?kind=premarket 用: 行配列の us_indexes_json を us_indexes に展開し、json キーは落とす。
export function expandPremarketRows(
	results: Record<string, unknown>[],
): Record<string, unknown>[] {
	return results.map((r) => {
		const { us_indexes_json, ...rest } = r;
		return { ...rest, us_indexes: parseUsIndexes(us_indexes_json as string) };
	});
}

// ── 米国セッションの鮮度 (休場またぎ判定) ──────────────────────────────────
// kabutan は米国休場の朝も直前クローズの数字をそのまま出すため、fetched_at の鮮度 (ok/stale)
// だけでは「新しい NY か、前営業日に日本市場が既に消化した持ち越しか」を区別できない。
// us_indexes の jst_time (例 "03日 06:16"、日番号のみ) を fetched_at から遡って完全な日付に
// 解決し、直前の日本営業日と比べて fresh / carried_over を分類する。

const DAY_MS = 86400_000;

// us_indexes (パース済み配列) の jst_time 日番号を、fetched_at (JST 換算) から最大35日
// 遡って YYYY-MM-DD に解決する。指数間で日がずれる場合は最も新しい日を採る。
// jst_time が無い・fetched_at 不正なら null。
export function resolveUsCloseJstDate(
	usIndexes: unknown,
	fetchedAt: string | null | undefined,
): string | null {
	if (!fetchedAt || !Array.isArray(usIndexes)) return null;
	const t = Date.parse(fetchedAt);
	if (!Number.isFinite(t)) return null;
	const base = t + 9 * 3600_000; // JST に平行移動し getUTC* で JST フィールドを読む
	let best: string | null = null;
	for (const q of usIndexes) {
		const jstTime = (q as { jst_time?: unknown })?.jst_time;
		if (typeof jstTime !== "string") continue;
		const m = jstTime.match(/^([0-9]{1,2})日/);
		if (!m) continue;
		const day = parseInt(m[1], 10);
		for (let i = 0; i < 35; i++) {
			const d = new Date(base - i * DAY_MS);
			if (d.getUTCDate() === day) {
				const ymd = d.toISOString().slice(0, 10);
				if (best === null || ymd > best) best = ymd;
				break;
			}
		}
	}
	return best;
}

// today (JST YYYY-MM-DD) の直前の日本営業日。土日のみ除外の近似 (祝日は非考慮 —
// event-context の営業日計算と同じ方針)。
function prevJpBusinessDay(today: string): string {
	const d = new Date(`${today}T12:00:00Z`);
	do {
		d.setUTCDate(d.getUTCDate() - 1);
	} while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
	return d.toISOString().slice(0, 10);
}

export type UsSession = "fresh" | "carried_over" | "unknown";

// 米国クローズ (JST 暦日) が直前の日本営業日より後なら fresh (前夜の新しい NY)。
// 同日以前なら carried_over (米国休場などで、前営業日の東京セッションが既に消化した数字の
// 持ち越し)。日付を解決できなければ unknown。
export function classifyUsSession(
	usCloseJstDate: string | null,
	today: string,
): UsSession {
	if (!usCloseJstDate) return "unknown";
	return usCloseJstDate > prevJpBusinessDay(today) ? "fresh" : "carried_over";
}

// /market-context 用 premarket ブロック。age>20h で stale 判定。
// date は us_indexes の jst_time から解決した米国クローズの JST 暦日 (解決不能なら null)。
// us_session は fresh / carried_over / unknown (休場またぎ判定)。
//   行なし → { status: "unavailable" }
//   行あり → status (ok/stale) + age_hours + 各指数 + us_indexes
export function buildPremarketBlock(
	row: {
		fetched_at?: string | null;
		sox_change_pct?: number | null;
		nasdaq_change_pct?: number | null;
		dow_change_pct?: number | null;
		nikkei_futures_price?: number | null;
		nikkei_contract?: string | null;
		us_indexes_json?: string | null;
	} | null,
	epochNow: number,
	today: string,
): Record<string, unknown> {
	if (!row?.fetched_at) return { status: "unavailable" };
	const ageH = Math.floor(
		(epochNow - new Date(row.fetched_at).getTime()) / 3600_000,
	);
	const usIndexes = parseUsIndexes(row.us_indexes_json);
	const usCloseJst = resolveUsCloseJstDate(usIndexes, row.fetched_at);
	return {
		status: ageH > 20 ? "stale" : "ok",
		age_hours: ageH,
		date: usCloseJst,
		us_session: classifyUsSession(usCloseJst, today),
		sox_change_pct: row.sox_change_pct ?? null,
		nasdaq_change_pct: row.nasdaq_change_pct ?? null,
		dow_change_pct: row.dow_change_pct ?? null,
		nikkei_futures_price: row.nikkei_futures_price ?? null,
		nikkei_contract: row.nikkei_contract ?? null,
		us_indexes: usIndexes,
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

	describe("parseUsIndexes", () => {
		it("JSON 配列をパースする", () => {
			expect(parseUsIndexes('[{"key":"sox","change_pct":1.2}]')).toEqual([
				{ key: "sox", change_pct: 1.2 },
			]);
		});
		it("null/空文字/壊れた JSON は空配列", () => {
			expect(parseUsIndexes(null)).toEqual([]);
			expect(parseUsIndexes("")).toEqual([]);
			expect(parseUsIndexes("{not json")).toEqual([]);
		});
	});

	describe("expandPremarketRows", () => {
		it("us_indexes_json を us_indexes に展開し json キーは落とす", () => {
			const out = expandPremarketRows([
				{ fetched_at: "t", us_indexes_json: "[1]" },
			]);
			expect(out).toEqual([{ fetched_at: "t", us_indexes: [1] }]);
			expect(out[0]).not.toHaveProperty("us_indexes_json");
		});
		it("複数行を各行独立に展開 (壊れ行は空配列)", () => {
			const out = expandPremarketRows([
				{ us_indexes_json: "[1]" },
				{ us_indexes_json: "broken" },
			]);
			expect(out[0].us_indexes).toEqual([1]);
			expect(out[1].us_indexes).toEqual([]);
		});
	});

	describe("resolveUsCloseJstDate", () => {
		// fetched_at 2026-07-05T23:30Z = JST 7/6 08:30。
		const FETCHED = "2026-07-05T23:30:00Z";
		it("jst_time の日番号を fetched_at から遡って解決する", () => {
			expect(resolveUsCloseJstDate([{ jst_time: "03日 06:16" }], FETCHED)).toBe(
				"2026-07-03",
			);
			// 当日朝の日番号 (通常営業日) は当日に解決。
			expect(resolveUsCloseJstDate([{ jst_time: "06日 06:16" }], FETCHED)).toBe(
				"2026-07-06",
			);
		});
		it("月またぎの日番号も前月へ遡って解決する", () => {
			expect(resolveUsCloseJstDate([{ jst_time: "30日 06:16" }], FETCHED)).toBe(
				"2026-06-30",
			);
		});
		it("指数間で日がずれたら最も新しい日を採る", () => {
			expect(
				resolveUsCloseJstDate(
					[{ jst_time: "02日 06:16" }, { jst_time: "03日 05:42" }],
					FETCHED,
				),
			).toBe("2026-07-03");
		});
		it("jst_time なし・配列以外・fetched_at 不正は null", () => {
			expect(resolveUsCloseJstDate([{ jst_time: null }], FETCHED)).toBeNull();
			expect(resolveUsCloseJstDate(null, FETCHED)).toBeNull();
			expect(resolveUsCloseJstDate([{ jst_time: "03日" }], "junk")).toBeNull();
		});
	});

	describe("prevJpBusinessDay", () => {
		it("月曜は前週金曜、火曜は月曜", () => {
			expect(prevJpBusinessDay("2026-07-06")).toBe("2026-07-03"); // 月→金
			expect(prevJpBusinessDay("2026-07-07")).toBe("2026-07-06"); // 火→月
		});
	});

	describe("classifyUsSession", () => {
		it("通常営業日: 前夜クローズは fresh", () => {
			// 火曜 7/7 の朝、クローズは 7/7 早朝 (前営業日 7/6 より後)。
			expect(classifyUsSession("2026-07-07", "2026-07-07")).toBe("fresh");
		});
		it("通常の週末明け月曜: 金曜 NY クローズ (JST 土曜早朝) は fresh", () => {
			// 月曜 6/29、クローズ JST 6/27(土) > 前営業日 6/26(金)。
			expect(classifyUsSession("2026-06-27", "2026-06-29")).toBe("fresh");
		});
		it("米国休場明け: 前営業日以前のクローズ持ち越しは carried_over", () => {
			// 月曜 7/6、クローズ JST 7/3(金) 早朝 = 金曜の東京セッションが消化済み。
			expect(classifyUsSession("2026-07-03", "2026-07-06")).toBe(
				"carried_over",
			);
		});
		it("日付を解決できなければ unknown", () => {
			expect(classifyUsSession(null, "2026-07-06")).toBe("unknown");
		});
	});

	describe("buildPremarketBlock", () => {
		const NOW = new Date("2026-06-24T00:00:00Z").getTime();
		const TODAY = "2026-06-24";

		it("行が無ければ unavailable", () => {
			expect(buildPremarketBlock(null, NOW, TODAY)).toEqual({
				status: "unavailable",
			});
			expect(buildPremarketBlock({ fetched_at: null }, NOW, TODAY)).toEqual({
				status: "unavailable",
			});
		});
		it("age<=20h は ok、各指数と us_indexes を展開", () => {
			const row = {
				fetched_at: new Date(NOW - 5 * 3600_000).toISOString(),
				sox_change_pct: 1.5,
				nikkei_futures_price: 38000,
				us_indexes_json: '[{"key":"sox"}]',
			};
			const b = buildPremarketBlock(row, NOW, TODAY);
			expect(b.status).toBe("ok");
			expect(b.age_hours).toBe(5);
			expect(b.date).toBeNull(); // jst_time なし → 解決不能
			expect(b.us_session).toBe("unknown");
			expect(b.sox_change_pct).toBe(1.5);
			expect(b.us_indexes).toEqual([{ key: "sox" }]);
		});
		it("jst_time があれば date を解決し fresh/carried_over を分類する", () => {
			// NOW = 水曜 6/24 09:00 JST。前夜クローズ (JST 24日早朝) は fresh。
			const fresh = buildPremarketBlock(
				{
					fetched_at: new Date(NOW).toISOString(),
					us_indexes_json: '[{"key":"sox","jst_time":"24日 06:16"}]',
				},
				NOW,
				TODAY,
			);
			expect(fresh.date).toBe("2026-06-24");
			expect(fresh.us_session).toBe("fresh");
			// 前営業日 (6/23) 早朝のクローズ持ち越しは carried_over。
			const carried = buildPremarketBlock(
				{
					fetched_at: new Date(NOW).toISOString(),
					us_indexes_json: '[{"key":"sox","jst_time":"23日 06:16"}]',
				},
				NOW,
				TODAY,
			);
			expect(carried.date).toBe("2026-06-23");
			expect(carried.us_session).toBe("carried_over");
		});
		it("age>20h は stale", () => {
			const row = { fetched_at: new Date(NOW - 21 * 3600_000).toISOString() };
			expect(buildPremarketBlock(row, NOW, TODAY).status).toBe("stale");
		});
		it("欠損フィールドは null 埋め", () => {
			const row = { fetched_at: new Date(NOW).toISOString() };
			const b = buildPremarketBlock(row, NOW, TODAY);
			expect(b.sox_change_pct).toBeNull();
			expect(b.nikkei_contract).toBeNull();
			expect(b.us_indexes).toEqual([]);
		});
	});
}
