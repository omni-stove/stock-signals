// Cloudflare Worker: 寄り前の地合い収集 (premarket backdrop)
//
// kabutan パーサで米国指数 (SOX/Nasdaq/Dow/VIX)・海外ピア個別株・CME日経225先物(ドル建て)・ドル円を、
// 米財務省の日次イールド CSV で米10年債利回りを取得し、D1 テーブル premarket_backdrop に
// INSERT OR REPLACE で冪等に書く。
//
// 前夜の米国市場 (とくに SOX)・日経先物・ドル円・米金利が寄り付きの方向をかなり決めるため、これを
// 寄り前 intake cron が取得し、ticker-brief / market-brief の pre-open の入力にする。
//
// ※LLM は使わない。スクレイピング・正規化のみ。kabutan は全ソース UTF-8 なので iconv 不要。

import { db } from "./db";
import { stripTags } from "./html";
import { parseKabutanIndex } from "./live-indexes";
import { type PeerRelease, SOX_PEERS } from "./peer-earnings";
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
	{
		key: "vix",
		label: "VIX(恐怖指数)",
		url: "https://us.kabutan.jp/indexes/%5EVIX",
	},
];
// 株探のドル円ページ (code=0950)。日経平均ページと同じ .si_i1_2 ブロック構造。
const USDJPY_URL = "https://kabutan.jp/stock/?code=0950";
// 米財務省の日次イールドカーブ CSV (当年分、新しい日付が先頭)。
const TREASURY_CSV_URL = (year: number) =>
	`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&_format=csv`;
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

// us.kabutan.jp の個別株ページ。アイコンにも text-3xl が付くので、現値ブロックは
// "$787.89 前日比 -23.41 ( -2.89 %) NY時間 12日 16:00 日本時間 13日 06:00" の並びで探す。
const US_STOCK_URL = (ticker: string) =>
	`https://us.kabutan.jp/stocks/${ticker}`;

type PeerQuote = {
	ticker: string;
	change_pct: number | null;
	jst_time: string | null;
};

function parseUsStock(html: string, ticker: string): PeerQuote {
	const m = stripTags(html).match(
		/\$[\d,]+(?:\.\d+)?\s*前日比\s*[+\-－ー]?[\d,]+(?:\.\d+)?\s*\(\s*([+\-－ー]?[\d.]+)\s*%\s*\)\s*NY時間\s*[0-9]{1,2}日\s*[0-9:]{4,5}\s*日本時間\s*([0-9]{1,2}日\s*[0-9:]{4,5})/,
	);
	return {
		ticker,
		change_pct: m ? toNumber(m[1]) : null,
		jst_time: m ? m[2].replace(/\s+/g, " ") : null,
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

type Us10y = {
	yield: number | null;
	change_bp: number | null;
	date: string | null; // 米国日付 YYYY-MM-DD
};

// 財務省 CSV から 10 Yr 列の最新値と前日差 (bp) を取る。列は見出し名で引く。
// 当年の行が 1 行しか無い (年初) ときは change_bp を null にする。
function parseTreasury10y(csv: string): Us10y {
	const lines = csv.trim().split(/\r?\n/);
	const header = (lines[0] ?? "").split(",").map((h) => h.replace(/"/g, ""));
	const col = header.indexOf("10 Yr");
	const rows = lines
		.slice(1)
		.map((l) => l.split(","))
		.filter((r) => /^\d{2}\/\d{2}\/\d{4}$/.test(r[0] ?? ""));
	if (col < 0 || rows.length === 0)
		return { yield: null, change_bp: null, date: null };
	const num = (r: string[] | undefined) => {
		const n = Number(r?.[col]);
		return r?.[col] && Number.isFinite(n) ? n : null;
	};
	const cur = num(rows[0]);
	const prev = num(rows[1]);
	const [mm, dd, yyyy] = rows[0][0].split("/");
	return {
		yield: cur,
		change_bp:
			cur != null && prev != null ? Math.round((cur - prev) * 100) : null,
		date: `${yyyy}-${mm}-${dd}`,
	};
}

// 米国指数 (SOX/Nasdaq/Dow/VIX)・海外ピア個別株・日経先物・ドル円・米10年債を取得し、premarket_backdrop に1行 INSERT する (append-only)。
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

	const us_peers: PeerQuote[] = [];
	for (const peer of SOX_PEERS) {
		await sleep(interval);
		try {
			us_peers.push(
				parseUsStock(
					await fetchHtml(US_STOCK_URL(peer.ticker), env),
					peer.ticker,
				),
			);
		} catch (e) {
			us_peers.push({ ticker: peer.ticker, change_pct: null, jst_time: null });
			console.error(
				`premarket [${peer.ticker}] error: ${(e as Error).message}`,
			);
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

	let usdjpy: { price: number | null; change: number | null } = {
		price: null,
		change: null,
	};
	try {
		await sleep(interval);
		usdjpy = await parseKabutanIndex(await fetchHtml(USDJPY_URL, env));
	} catch (e) {
		console.error(`premarket [usdjpy] error: ${(e as Error).message}`);
	}

	let us10y: Us10y = { yield: null, change_bp: null, date: null };
	try {
		await sleep(interval);
		us10y = parseTreasury10y(
			await fetchHtml(TREASURY_CSV_URL(new Date().getUTCFullYear()), env),
		);
	} catch (e) {
		console.error(`premarket [us10y] error: ${(e as Error).message}`);
	}

	const quote = (key: string) => us_indexes.find((q) => q.key === key);
	const pick = (key: string) => quote(key)?.change_pct ?? null;
	const fetched_at = new Date().toISOString();
	const macro = macroFields({
		vix_price: quote("vix")?.price,
		vix_change_pct: pick("vix"),
		usdjpy_price: usdjpy.price,
		usdjpy_change: usdjpy.change,
		us10y_yield: us10y.yield,
		us10y_change_bp: us10y.change_bp,
		us10y_date: us10y.date,
	});

	const backdropRow = {
		fetchedAt: fetched_at,
		soxChangePct: pick("sox"),
		nasdaqChangePct: pick("ndx"),
		dowChangePct: pick("dji"),
		nikkeiFuturesPrice: nikkei.price,
		nikkeiContract: nikkei.contract,
		vixPrice: macro.vix_price,
		vixChangePct: macro.vix_change_pct,
		usdjpyPrice: macro.usdjpy_price,
		usdjpyChange: macro.usdjpy_change,
		us10yYield: macro.us10y_yield,
		us10yChangeBp: macro.us10y_change_bp,
		us10yDate: macro.us10y_date,
		usIndexesJson: JSON.stringify(us_indexes),
		usPeersJson: JSON.stringify(us_peers),
	};
	await db(env.DB)
		.insert(premarketBackdrop)
		.values(backdropRow)
		.onConflictDoUpdate({
			target: premarketBackdrop.fetchedAt,
			set: (({ fetchedAt: _, ...rest }) => rest)(backdropRow),
		})
		.run();

	return {
		fetched_at,
		sox_change_pct: pick("sox"),
		nasdaq_change_pct: pick("ndx"),
		dow_change_pct: pick("dji"),
		nikkei_futures_price: nikkei.price,
		nikkei_contract: nikkei.contract,
		...macro,
	};
}

// ── 読み出し (routes が D1 から最新 1 行を引くときの列と、マクロ指標の整形) ─────
// judge-context と market-context が同じ列を同じ名前で引く。
export const PREMARKET_COLUMNS = {
	fetched_at: premarketBackdrop.fetchedAt,
	sox_change_pct: premarketBackdrop.soxChangePct,
	nasdaq_change_pct: premarketBackdrop.nasdaqChangePct,
	dow_change_pct: premarketBackdrop.dowChangePct,
	nikkei_futures_price: premarketBackdrop.nikkeiFuturesPrice,
	nikkei_contract: premarketBackdrop.nikkeiContract,
	vix_price: premarketBackdrop.vixPrice,
	vix_change_pct: premarketBackdrop.vixChangePct,
	usdjpy_price: premarketBackdrop.usdjpyPrice,
	usdjpy_change: premarketBackdrop.usdjpyChange,
	us10y_yield: premarketBackdrop.us10yYield,
	us10y_change_bp: premarketBackdrop.us10yChangeBp,
	us10y_date: premarketBackdrop.us10yDate,
	us_indexes_json: premarketBackdrop.usIndexesJson,
	us_peers_json: premarketBackdrop.usPeersJson,
};

export type MacroRow = {
	vix_price?: number | null;
	vix_change_pct?: number | null;
	usdjpy_price?: number | null;
	usdjpy_change?: number | null;
	us10y_yield?: number | null;
	us10y_change_bp?: number | null;
	us10y_date?: string | null;
};

// VIX・ドル円・米10年債を premarket ブロックに載せる形に揃える (欠損は null)。
export function macroFields(row: MacroRow): Required<MacroRow> {
	return {
		vix_price: row.vix_price ?? null,
		vix_change_pct: row.vix_change_pct ?? null,
		usdjpy_price: row.usdjpy_price ?? null,
		usdjpy_change: row.usdjpy_change ?? null,
		us10y_yield: row.us10y_yield ?? null,
		us10y_change_bp: row.us10y_change_bp ?? null,
		us10y_date: row.us10y_date ?? null,
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
	row:
		| (MacroRow & {
				fetched_at?: string | null;
				sox_change_pct?: number | null;
				nasdaq_change_pct?: number | null;
				dow_change_pct?: number | null;
				nikkei_futures_price?: number | null;
				nikkei_contract?: string | null;
				us_indexes_json?: string | null;
		  })
		| null,
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
		...macroFields(row),
		us_indexes: usIndexes,
	};
}

// ── 海外ピアの前夜の騰落 (/market-context 用) ───────────────────────────────
// market-brief だけが読む。銘柄ブリーフには渡さない (市場全体の材料は market-brief 経由)。
// 米国セッションの終値日 (SOX と同じ JST 暦日) と揃わない銘柄は落とし、決算日に当たる銘柄にだけ
// earnings を付ける: after_this_close = この終値の後に発表 (終値に未反映、反応は時間外と次の
// セッション) / in_close = この終値に反映済み (寄り前発表、または前営業日の引け後発表)。

export type PeerEarningsRow = { kind?: string | null; date: string };

function addDaysIso(date: string, days: number): string {
	const d = new Date(`${date}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

function prevWeekday(date: string): string {
	let d = addDaysIso(date, -1);
	while ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()))
		d = addDaysIso(d, -1);
	return d;
}

function peerEarnings(
	release: PeerRelease,
	usDate: string,
	reportDates: Set<string>,
): "after_this_close" | "in_close" | null {
	if (reportDates.has(usDate))
		return release === "after_close" ? "after_this_close" : "in_close";
	if (release === "after_close" && reportDates.has(prevWeekday(usDate)))
		return "in_close";
	return null;
}

// usCloseJstDate は buildPremarketBlock の date (SOX 等の米国終値の JST 暦日)。
export function buildUsPeersBlock(
	json: string | null | undefined,
	fetchedAt: string | null | undefined,
	usCloseJstDate: string | null,
	earningsRows: PeerEarningsRow[],
): Record<string, unknown> {
	const quotes = parseUsIndexes(json);
	if (!usCloseJstDate || !Array.isArray(quotes) || quotes.length === 0)
		return { status: "unavailable" };
	// 米国の引け (16:00 ET) は JST の翌朝なので、米国の取引日は JST 暦日の前日。
	const usDate = addDaysIso(usCloseJstDate, -1);
	const peers = SOX_PEERS.flatMap((peer) => {
		const q = (quotes as PeerQuote[]).find((x) => x?.ticker === peer.ticker);
		if (q?.change_pct == null) return [];
		if (resolveUsCloseJstDate([q], fetchedAt) !== usCloseJstDate) return [];
		const dates = new Set(
			earningsRows
				.filter((r) => r.kind === `peer_earnings:${peer.ticker}`)
				.map((r) => r.date),
		);
		const earnings = peerEarnings(peer.release, usDate, dates);
		return [
			{
				ticker: peer.ticker,
				role: peer.role,
				change_pct: q.change_pct,
				...(earnings ? { earnings } : {}),
			},
		];
	});
	return peers.length > 0
		? { status: "ok", us_date: usDate, peers }
		: { status: "unavailable" };
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

	describe("parseTreasury10y", () => {
		const CSV = [
			'Date,"1 Mo","2 Yr","10 Yr","30 Yr"',
			"11/10/2026,4.05,4.73,4.98,5.35",
			"11/09/2026,4.04,4.56,4.88,5.26",
		].join("\r\n");
		it("10 Yr 列の最新値と前日差 (bp)、米国日付を返す", () => {
			expect(parseTreasury10y(CSV)).toEqual({
				yield: 4.98,
				change_bp: 10,
				date: "2026-11-10",
			});
		});
		it("当年 1 行だけなら change_bp は null", () => {
			const one = CSV.split("\r\n").slice(0, 2).join("\n");
			expect(parseTreasury10y(one)).toEqual({
				yield: 4.98,
				change_bp: null,
				date: "2026-11-10",
			});
		});
		it("10 Yr 列が無い・データ行が無いなら全て null", () => {
			const empty = { yield: null, change_bp: null, date: null };
			expect(parseTreasury10y('Date,"1 Mo"\n11/10/2026,4.05')).toEqual(empty);
			expect(parseTreasury10y("<html>error</html>")).toEqual(empty);
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
				usdjpy_price: 152.3,
				us10y_change_bp: -4,
				us_indexes_json: '[{"key":"sox"}]',
			};
			const b = buildPremarketBlock(row, NOW, TODAY);
			expect(b.status).toBe("ok");
			expect(b.age_hours).toBe(5);
			expect(b.date).toBeNull(); // jst_time なし → 解決不能
			expect(b.us_session).toBe("unknown");
			expect(b.sox_change_pct).toBe(1.5);
			expect(b.us_indexes).toEqual([{ key: "sox" }]);
			expect(b.usdjpy_price).toBe(152.3);
			expect(b.us10y_change_bp).toBe(-4);
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
			expect(b.vix_price).toBeNull();
			expect(b.us10y_date).toBeNull();
			expect(b.us_indexes).toEqual([]);
		});
	});

	describe("parseUsStock", () => {
		it("アイコンの text-3xl を飛ばし、現値ブロックから騰落率と JST 時刻を取る", () => {
			const html = [
				'<i class="fa-regular fa-chart-line text-3xl !block !w-6"></i> 株価情報',
				'<div class="flex-1 text-right text-3xl mr-1">$787.89</div>',
				"<div> 前日比 -23.41 ( -2.89 %) NY時間 12日 16:00 日本時間 13日 06:00 &nbsp; PER 10.6 倍</div>",
			].join("");
			expect(parseUsStock(html, "MU")).toEqual({
				ticker: "MU",
				change_pct: -2.89,
				jst_time: "13日 06:00",
			});
		});
		it("現値ブロックが無ければ null", () => {
			expect(parseUsStock("<div>maintenance</div>", "MU")).toEqual({
				ticker: "MU",
				change_pct: null,
				jst_time: null,
			});
		});
	});

	describe("buildUsPeersBlock", () => {
		// JST 11/13 (金) 08:30 取得。米国の終値は JST 11/13 06:00 = 米国 11/12 (木)。
		const FETCHED = "2026-11-12T23:30:00Z";
		const json = (rows: Partial<PeerQuote>[]) =>
			JSON.stringify(rows.map((r) => ({ jst_time: "13日 06:00", ...r })));

		it("終値日が揃った銘柄だけを SOX_PEERS の順に並べる", () => {
			const b = buildUsPeersBlock(
				json([
					{ ticker: "NVDA", change_pct: 1.2 },
					{ ticker: "MU", change_pct: -2.9 },
					{ ticker: "AMAT", change_pct: 0.4, jst_time: "12日 06:00" },
					{ ticker: "KLAC", change_pct: null },
				]),
				FETCHED,
				"2026-11-13",
				[],
			);
			expect(b).toEqual({
				status: "ok",
				us_date: "2026-11-12",
				peers: [
					{ ticker: "MU", role: "メモリ", change_pct: -2.9 },
					{ ticker: "NVDA", role: "GPU", change_pct: 1.2 },
				],
			});
		});

		it("決算日に当たる銘柄に、終値に反映済みかを付ける", () => {
			const b = buildUsPeersBlock(
				json([
					{ ticker: "MU", change_pct: -2.9 }, // 当日引け後 → 未反映
					{ ticker: "NVDA", change_pct: 1.2 }, // 前営業日の引け後 → 反映済み
					{ ticker: "TSM", change_pct: 3.1 }, // 当日寄り前 → 反映済み
				]),
				FETCHED,
				"2026-11-13",
				[
					{ kind: "peer_earnings:MU", date: "2026-11-12" },
					{ kind: "peer_earnings:NVDA", date: "2026-11-11" },
					{ kind: "peer_earnings:TSM", date: "2026-11-12" },
				],
			);
			expect(b.peers).toEqual([
				{
					ticker: "MU",
					role: "メモリ",
					change_pct: -2.9,
					earnings: "after_this_close",
				},
				{ ticker: "NVDA", role: "GPU", change_pct: 1.2, earnings: "in_close" },
				{
					ticker: "TSM",
					role: "ファウンドリ",
					change_pct: 3.1,
					earnings: "in_close",
				},
			]);
		});

		it("週明けの朝は金曜の終値を基準に、木曜引け後の決算を反映済みとする", () => {
			// JST 11/16 (月) 朝。終値は JST 11/14 06:00 = 米国 11/13 (金)。
			const b = buildUsPeersBlock(
				JSON.stringify([
					{ ticker: "MU", change_pct: 1, jst_time: "14日 06:00" },
				]),
				"2026-11-15T23:30:00Z",
				"2026-11-14",
				[{ kind: "peer_earnings:MU", date: "2026-11-12" }],
			);
			expect(b.peers).toEqual([
				{ ticker: "MU", role: "メモリ", change_pct: 1, earnings: "in_close" },
			]);
		});

		it("終値日が無い・データが無ければ unavailable", () => {
			expect(buildUsPeersBlock(null, FETCHED, "2026-11-13", [])).toEqual({
				status: "unavailable",
			});
			expect(
				buildUsPeersBlock(
					json([{ ticker: "MU", change_pct: 1 }]),
					FETCHED,
					null,
					[],
				),
			).toEqual({ status: "unavailable" });
		});
	});
}
