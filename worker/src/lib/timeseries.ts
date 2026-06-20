// Cloudflare Worker: 時系列データ収集 (prices / daily / fundamentals)
//
// ローカルの scripts/fetch-prices.ts / fetch-daily.ts / fetch-fundamentals.ts と
// 同じ kabutan パーサを Worker に移植したもの。結果は jsonl ではなく D1 テーブル
// (prices / daily / fundamentals) に INSERT OR IGNORE / REPLACE で冪等に書く。
//
// watchlist と URL テンプレートはローカル config/watchlist.yaml・sources.yaml の
// 該当部分をここに写している (Worker は読み取り専用 FS で yaml を持てないため)。
// 銘柄追加時は WATCHLIST を更新する。

import * as cheerio from "cheerio";
import { db } from "./db";
import { daily, fundamentals, prices } from "./schema";
import { fetchHtml, sleep } from "./utils";

export interface TimeseriesEnv {
	DB: D1Database;
	USER_AGENT: string;
	MIN_INTERVAL_MS: string;
}

// ローカル config/watchlist.yaml の tickers と対応。Worker 内の全モジュールが
// この定義を import して使う唯一の出所 (銘柄追加時はここ + watchlist.yaml だけ直す)。
export const WATCHLIST: string[] = ["285A", "6857", "6920", "6981"];

// ローカル config/sources.yaml の url_template と対応。
const URL_PRICES = (code: string) => `https://kabutan.jp/stock/?code=${code}`;
const URL_DAILY = (code: string) =>
	`https://kabutan.jp/stock/kabuka?code=${code}`;
const URL_FUNDAMENTALS = (code: string) =>
	`https://kabutan.jp/stock/?code=${code}`;
const SITE = "kabutan";

function toNumber(raw: string | undefined | null): number | null {
	if (!raw) return null;
	const cleaned = raw.replace(/[,倍円株%％]/g, "").trim();
	if (!cleaned || cleaned === "－" || cleaned === "-") return null;
	const n = Number(cleaned);
	return Number.isFinite(n) ? n : null;
}

// ISO8601 を5分枠に丸めたキー。「5分毎 cron で1枠1行」にするための冪等キー。
//   quote_time(例 2026-06-18T12:51+09:00)も fetched_at も同じ規則で丸める。
//   分を5刻みに落とし、秒・ミリ秒・タイムゾーン表記は捨てて "YYYY-MM-DDTHH:MM" にする。
//   quote_time はJST(+09:00)、fetched_atはUTC(Z)だが、どちらも「自分の時計の5分枠」を
//   表せれば冪等には十分 (両者を混ぜて使うことはない)。
function slot5min(iso: string): string {
	const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
	if (!m) return iso; // 想定外フォーマットはそのままキーにする (安全側)
	const floored = Math.floor(parseInt(m[3], 10) / 5) * 5;
	return `${m[1]}T${m[2]}:${String(floored).padStart(2, "0")}`;
}

// ── prices ────────────────────────────────────────────────────────────────
type PriceParsed = {
	price: number | null;
	change: number | null;
	change_pct: number | null;
	volume: number | null;
	quote_time: string | null;
	pts_price: number | null;
	pts_time: string | null;
};

// scripts/fetch-prices.ts の parseKabutanPrice と同じ。
function parseKabutanPrice(html: string): PriceParsed {
	const $ = cheerio.load(html);
	const block = $(".si_i1_2").first();

	const price = toNumber(block.find(".kabuka").first().text());

	const dds = block.find(".si_i1_dl1 dd");
	const change = toNumber(dds.eq(0).find("span").first().text());
	const change_pct = toNumber(dds.eq(1).find("span").first().text());

	let volume: number | null = null;
	$("th").each((_, th) => {
		if (volume !== null) return;
		if ($(th).text().trim() === "出来高") {
			volume = toNumber($(th).next("td").text());
		}
	});

	const quote_time = $("#stockinfo_i1 time").first().attr("datetime") || null;

	const ptsBlock = $(".si_i1_3").first();
	let pts_price: number | null = null;
	let pts_time: string | null = null;
	if (
		ptsBlock.length > 0 &&
		ptsBlock.find(".kabuka1").text().trim().includes("PTS")
	) {
		pts_price = toNumber(ptsBlock.find(".kabuka2").text());
		pts_time =
			ptsBlock.find(".kabuka3").text().replace(/\s+/g, " ").trim() || null;
	}

	return { price, change, change_pct, volume, quote_time, pts_price, pts_time };
}

async function collectPricesOne(
	env: TimeseriesEnv,
	code: string,
): Promise<{ written: number; skipped: number }> {
	const html = await fetchHtml(URL_PRICES(code), env);
	const p = parseKabutanPrice(html);
	const fetched_at = new Date().toISOString();
	// 値付き時刻があればそれを、無ければ取得時刻を5分枠に丸めて冪等キーにする。
	const slot = slot5min(p.quote_time || fetched_at);
	// INSERT OR IGNORE 相当 = onConflictDoNothing。(ticker, slot) が既存なら無視。
	const r = await db(env.DB)
		.insert(prices)
		.values({
			ticker: code,
			slot,
			source: `${SITE}:${code}`,
			price: p.price,
			change: p.change,
			changePct: p.change_pct,
			volume: p.volume,
			quoteTime: p.quote_time,
			ptsPrice: p.pts_price,
			ptsTime: p.pts_time,
			fetchedAt: fetched_at,
		})
		.onConflictDoNothing()
		.run();
	const written = r.meta.changes ?? 0;
	return { written, skipped: written ? 0 : 1 };
}

// ── daily ─────────────────────────────────────────────────────────────────
type DailyBar = {
	date: string;
	open: number | null;
	high: number | null;
	low: number | null;
	close: number | null;
	change: number | null;
	change_pct: number | null;
	volume: number | null;
};

// scripts/fetch-daily.ts の parseKabutanDaily と同じ (本日表 + 過去表)。
function parseKabutanDaily(html: string): DailyBar[] {
	const $ = cheerio.load(html);
	const rows: DailyBar[] = [];

	const harvest = (selector: string) => {
		$(`${selector} tbody tr`).each((_, tr) => {
			const $tr = $(tr);
			const date = $tr.find("th time").first().attr("datetime");
			if (!date) return;
			const tds = $tr.find("td");
			if (tds.length < 7) return;
			rows.push({
				date,
				open: toNumber(tds.eq(0).text()),
				high: toNumber(tds.eq(1).text()),
				low: toNumber(tds.eq(2).text()),
				close: toNumber(tds.eq(3).text()),
				change: toNumber(tds.eq(4).text()),
				change_pct: toNumber(tds.eq(5).text()),
				volume: toNumber(tds.eq(6).text()),
			});
		});
	};

	harvest("table.stock_kabuka0");
	harvest("table.stock_kabuka_dwm");
	return rows;
}

async function collectDailyOne(
	env: TimeseriesEnv,
	code: string,
): Promise<{ written: number; skipped: number }> {
	const html = await fetchHtml(URL_DAILY(code), env);
	const bars = parseKabutanDaily(html);
	if (bars.length === 0) return { written: 0, skipped: 0 };
	const fetched_at = new Date().toISOString();
	const source = `${SITE}:${code}`;

	// (ticker, date) PK の INSERT OR IGNORE で重複日付を自動スキップ。
	// 1文に全行をまとめると D1/SQLite のバインド変数上限 (100個) を超えるため、旧コードの
	// env.DB.batch() と同じく「1行=1ステートメント」を db.batch() で一括投入する。
	const d = db(env.DB);
	const stmts = bars.map((b) =>
		d
			.insert(daily)
			.values({
				ticker: code,
				date: b.date,
				source,
				open: b.open,
				high: b.high,
				low: b.low,
				close: b.close,
				change: b.change,
				changePct: b.change_pct,
				volume: b.volume,
				fetchedAt: fetched_at,
			})
			.onConflictDoNothing(),
	);
	// batch() は最低1要素を要求する (型上 [first, ...rest])。bars.length===0 は冒頭で return 済み。
	const results = await d.batch(
		stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]],
	);
	let written = 0;
	for (const r of results) written += r.meta.changes ?? 0;
	return { written, skipped: bars.length - written };
}

// ── fundamentals ────────────────────────────────────────────────────────────
type FundParsed = {
	per: number | null;
	pbr: number | null;
	dividend_yield: number | null;
	forecast_eps: number | null;
	forecast_period: string | null;
	actual_eps: number | null;
	actual_period: string | null;
};

function normalizePeriod(label: string): string | null {
	const m = label.match(/(\d{4}\.\d{2})/);
	return m ? m[1] : null;
}
function isForecastRow(label: string): boolean {
	return /予/.test(label);
}

// scripts/fetch-fundamentals.ts の parseKabutanFundamentals と同じ。
function parseKabutanFundamentals(html: string): FundParsed {
	const $ = cheerio.load(html);

	let per: number | null = null;
	let pbr: number | null = null;
	let dividend_yield: number | null = null;

	$("table").each((_, table) => {
		if (per !== null) return;
		const $t = $(table);
		const headers = $t
			.find("thead th")
			.map((_, th) => $(th).text().trim())
			.get();
		if (headers.includes("PER") && headers.includes("PBR")) {
			const tds = $t.find("tbody tr").first().find("td");
			per = toNumber(tds.eq(0).text());
			pbr = toNumber(tds.eq(1).text());
			dividend_yield = toNumber(tds.eq(2).text());
		}
	});

	let forecast_eps: number | null = null;
	let forecast_period: string | null = null;
	let actual_eps: number | null = null;
	let actual_period: string | null = null;

	$("table").each((_, table) => {
		if (forecast_period !== null || actual_period !== null) return;
		const $t = $(table);
		const headers = $t
			.find("thead th")
			.map((_, th) => $(th).text().trim())
			.get();
		const epsCol = headers.findIndex(
			(h) => h.includes("１株益") || h.includes("1株益"),
		);
		if (!headers.includes("決算期") || epsCol < 0) return;

		$t.find("tbody tr").each((_, tr) => {
			const cells = $(tr).find("th, td");
			const label = cells
				.first()
				.text()
				.replace(/ /g, " ")
				.replace(/　/g, " ")
				.trim();
			const period = normalizePeriod(label);
			if (!period) return;
			const eps = toNumber(cells.eq(epsCol).text());
			if (isForecastRow(label)) {
				if (forecast_period === null) {
					forecast_eps = eps;
					forecast_period = period;
				}
			} else {
				actual_eps = eps;
				actual_period = period;
			}
		});
	});

	return {
		per,
		pbr,
		dividend_yield,
		forecast_eps,
		forecast_period,
		actual_eps,
		actual_period,
	};
}

async function collectFundamentalsOne(
	env: TimeseriesEnv,
	code: string,
): Promise<{ written: number; skipped: number }> {
	const html = await fetchHtml(URL_FUNDAMENTALS(code), env);
	const f = parseKabutanFundamentals(html);
	const fetched_at = new Date().toISOString();
	const date = fetched_at.slice(0, 10);
	// 同日複数回は最新値で上書きしたいので、PK (ticker, date) 衝突時に全カラム上書き
	// (旧 INSERT OR REPLACE と同じ「最新が勝つ」効果)。
	const row = {
		ticker: code,
		date,
		source: `${SITE}:${code}`,
		per: f.per,
		pbr: f.pbr,
		dividendYield: f.dividend_yield,
		forecastEps: f.forecast_eps,
		forecastPeriod: f.forecast_period,
		actualEps: f.actual_eps,
		actualPeriod: f.actual_period,
		fetchedAt: fetched_at,
	};
	await db(env.DB)
		.insert(fundamentals)
		.values(row)
		.onConflictDoUpdate({
			target: [fundamentals.ticker, fundamentals.date],
			set: {
				source: row.source,
				per: row.per,
				pbr: row.pbr,
				dividendYield: row.dividendYield,
				forecastEps: row.forecastEps,
				forecastPeriod: row.forecastPeriod,
				actualEps: row.actualEps,
				actualPeriod: row.actualPeriod,
				fetchedAt: row.fetchedAt,
			},
		})
		.run();
	return { written: 1, skipped: 0 };
}

// ── オーケストレーション ───────────────────────────────────────────────────
type Kind = "prices" | "daily" | "fundamentals";

const COLLECTORS: Record<
	Kind,
	(
		env: TimeseriesEnv,
		code: string,
	) => Promise<{ written: number; skipped: number }>
> = {
	prices: collectPricesOne,
	daily: collectDailyOne,
	fundamentals: collectFundamentalsOne,
};

// 全 watchlist 銘柄を順次取得 (min_interval を空ける)。1銘柄が落ちても他は続行。
export async function collectTimeseries(
	env: TimeseriesEnv,
	kind: Kind,
	codeFilter: string | null,
): Promise<Record<string, unknown>> {
	const codes = WATCHLIST.filter((c) => !codeFilter || c === codeFilter);
	const interval = parseInt(env.MIN_INTERVAL_MS, 10) || 5000;
	const collect = COLLECTORS[kind];
	const results: Record<string, unknown> = {};
	let first = true;
	for (const code of codes) {
		if (!first) await sleep(interval);
		first = false;
		try {
			results[code] = await collect(env, code);
		} catch (e) {
			results[code] = { error: (e as Error).message };
		}
	}
	return results;
}

// in-source tests (本番ビルドでは tree-shake される。vitest.config.ts 参照)
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("toNumber", () => {
		it("通貨・単位記号を除いてパースする", () => {
			expect(toNumber("1,234")).toBe(1234);
			expect(toNumber("12.5倍")).toBe(12.5);
			expect(toNumber("3.2%")).toBe(3.2);
			expect(toNumber("1,000円")).toBe(1000);
		});
		it("欠損値 (空 / 全角ダッシュ / ハイフン) は null", () => {
			expect(toNumber("")).toBeNull();
			expect(toNumber("－")).toBeNull();
			expect(toNumber("-")).toBeNull();
			expect(toNumber(null)).toBeNull();
			expect(toNumber(undefined)).toBeNull();
		});
		it("数値でない文字列は null", () => {
			expect(toNumber("N/A")).toBeNull();
		});
	});

	describe("slot5min", () => {
		it("分を 5 分枠に切り下げ、秒・TZ を捨てる", () => {
			expect(slot5min("2026-06-18T12:51:30+09:00")).toBe("2026-06-18T12:50");
			expect(slot5min("2026-06-18T12:55:00Z")).toBe("2026-06-18T12:55");
			expect(slot5min("2026-06-18T00:04:59.999Z")).toBe("2026-06-18T00:00");
		});
		it("想定外フォーマットはそのまま返す (安全側)", () => {
			expect(slot5min("not-a-date")).toBe("not-a-date");
		});
	});

	describe("parseKabutanPrice", () => {
		const html = `
			<div id="stockinfo_i1">
				<div class="si_i1_2">
					<span class="kabuka">1,234.5</span>
					<dl class="si_i1_dl1">
						<dd><span>+12.5</span></dd>
						<dd><span>+1.02%</span></dd>
					</dl>
				</div>
				<div class="si_i1_3">
					<span class="kabuka1">PTS</span>
					<span class="kabuka2">1,240</span>
					<span class="kabuka3">  18:30 </span>
				</div>
				<time datetime="2026-06-18T15:00:00+09:00"></time>
			</div>
			<table><tr><th>出来高</th><td>1,000,000</td></tr></table>`;

		it("価格・前日比・出来高・時刻を抽出する", () => {
			const p = parseKabutanPrice(html);
			expect(p.price).toBe(1234.5);
			expect(p.change).toBe(12.5);
			expect(p.change_pct).toBe(1.02);
			expect(p.volume).toBe(1000000);
			expect(p.quote_time).toBe("2026-06-18T15:00:00+09:00");
		});

		it("PTS ブロックがあれば pts_price / pts_time を抽出する", () => {
			const p = parseKabutanPrice(html);
			expect(p.pts_price).toBe(1240);
			expect(p.pts_time).toBe("18:30");
		});

		it("空 HTML では全フィールド null", () => {
			const p = parseKabutanPrice("<html></html>");
			expect(p.price).toBeNull();
			expect(p.volume).toBeNull();
			expect(p.pts_price).toBeNull();
		});
	});

	describe("parseKabutanDaily", () => {
		const html = `
			<table class="stock_kabuka0"><tbody>
				<tr>
					<th><time datetime="2026-06-18">06/18</time></th>
					<td>100</td><td>110</td><td>95</td><td>105</td>
					<td>+5</td><td>+5.0%</td><td>1,000</td>
				</tr>
			</tbody></table>
			<table class="stock_kabuka_dwm"><tbody>
				<tr>
					<th><time datetime="2026-06-17">06/17</time></th>
					<td>90</td><td>101</td><td>88</td><td>100</td>
					<td>-2</td><td>-1.9%</td><td>2,000</td>
				</tr>
			</tbody></table>`;

		it("本日表と過去表の両方から OHLCV 行を拾う", () => {
			const bars = parseKabutanDaily(html);
			expect(bars).toHaveLength(2);
			expect(bars[0]).toMatchObject({
				date: "2026-06-18",
				open: 100,
				high: 110,
				low: 95,
				close: 105,
				volume: 1000,
			});
			expect(bars[1].date).toBe("2026-06-17");
		});

		it("datetime や td 不足の行はスキップする", () => {
			const broken = `<table class="stock_kabuka0"><tbody>
				<tr><th>日付なし</th><td>1</td></tr>
			</tbody></table>`;
			expect(parseKabutanDaily(broken)).toHaveLength(0);
		});

		it("該当テーブルが無ければ空配列", () => {
			expect(parseKabutanDaily("<html></html>")).toHaveLength(0);
		});
	});
}
