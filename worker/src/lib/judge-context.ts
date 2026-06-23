// signal-judge / crash-scenario / slack-reply に渡す「数値コンテキスト」を組み立てる純粋関数群。
//
// 設計 (旧 scripts/judge-context.sh の jq 正規化を TS に移植):
//   - 取得 (D1 read) は routes/judge-context.ts が行い、ここは「生 rows → 正規化済みブロック」の
//     純粋関数に徹する。指標 (RSI/ATR/レンジ/MA) は indicators.ts を再利用し二重実装しない。
//   - 出力キーは旧 judge-context.sh と完全一致 (snake_case)。SKILL.md の読み手が依存する。
//   - 丸めは judge-context.sh の jq と同一: long_chg/short_chg は floor1 (小数第1位切り捨て)。
//
// judge-context.bats の earnings/premarket/daily/margin/prices ブロック検証と一致させること。

import {
	computeDailyIndicators,
	type DailyRow,
	maDevPct,
	withMovingAverages,
} from "./indicators";

// jq の (x*10|floor)/10。負値も下方向に floor。
function floor1(x: number): number {
	return Math.floor(x * 10) / 10;
}

// --- earnings: days_to_earnings ---------------------------------------------
export interface EarningsBlock {
	status: "ok" | "unknown";
	next_date: string | null;
	days_to_earnings: number | null;
}

// next_date と today (YYYY-MM-DD) の暦日差。next_date が無ければ unknown。
export function buildEarnings(
	nextDate: string | null | undefined,
	today: string,
): EarningsBlock {
	if (!nextDate) {
		return { status: "unknown", next_date: null, days_to_earnings: null };
	}
	const ms =
		new Date(`${nextDate}T12:00:00Z`).getTime() -
		new Date(`${today}T12:00:00Z`).getTime();
	return {
		status: "ok",
		next_date: nextDate,
		days_to_earnings: Math.round(ms / 86400_000),
	};
}

// --- premarket: 鮮度判定 (age>20h で stale) ---------------------------------
export interface PremarketRow {
	fetched_at?: string | null;
	sox_change_pct?: number | null;
	nasdaq_change_pct?: number | null;
	dow_change_pct?: number | null;
	nikkei_futures_price?: number | null;
	nikkei_contract?: string | null;
	[key: string]: unknown;
}

export function buildPremarket(
	row: PremarketRow | null | undefined,
	epochNow: number,
): Record<string, unknown> {
	if (!row || !row.fetched_at) return { status: "unavailable" };
	const ageH = Math.floor(
		(epochNow - new Date(row.fetched_at).getTime()) / 3600_000,
	);
	return {
		status: ageH > 20 ? "stale" : "ok",
		age_hours: ageH,
		sox_change_pct: row.sox_change_pct ?? null,
		nasdaq_change_pct: row.nasdaq_change_pct ?? null,
		dow_change_pct: row.dow_change_pct ?? null,
		nikkei_futures_price: row.nikkei_futures_price ?? null,
		nikkei_contract: row.nikkei_contract ?? null,
	};
}

// --- margin: WoW 増減 (rows は date DESC, [0]=最新週 [1]=前週) ---------------
export interface MarginRow {
	date: string;
	long_qty?: number | null;
	short_qty?: number | null;
	ratio?: number | null;
}

export function buildMargin(rows: MarginRow[]): Record<string, unknown> {
	if (!rows || rows.length < 1) return { status: "unavailable" };
	const cur = rows[0];
	const prev = rows[1] ?? null;
	const wow = (
		c: number | null | undefined,
		p: number | null | undefined,
	): number | null => (prev && c != null && p != null ? floor1(c - p) : null);
	return {
		status: "ok",
		rows_n: rows.length,
		latest_date: cur.date,
		long_qty: cur.long_qty ?? null,
		short_qty: cur.short_qty ?? null,
		ratio: cur.ratio ?? null,
		long_chg: wow(cur.long_qty, prev?.long_qty),
		short_chg: wow(cur.short_qty, prev?.short_qty),
		prev_date: prev?.date ?? null,
	};
}

// --- daily: indicators.ts を使い 20日レンジ/MA位置/RSI/ATR を組む -------------
// rows は date DESC (新しい順)。withMovingAverages で ma5/ma25 を付与してから指標を計算する。
export function buildDaily(rowsDesc: DailyRow[]): Record<string, unknown> {
	const n = rowsDesc?.length ?? 0;
	if (n < 5) return { status: "insufficient", rows_n: n };
	// ma を付与した最新行を「現在地」とする。n と同数を要求して全行に ma を載せる。
	const withMa = withMovingAverages(
		rowsDesc as Record<string, unknown>[],
		n,
	) as DailyRow[];
	const cur = withMa[0];
	const ind = computeDailyIndicators(rowsDesc);
	if (!ind) return { status: "insufficient", rows_n: n };

	const close = (cur.close as number | null) ?? null;
	const ma5 = (cur.ma5 as number | null) ?? null;
	const ma25 = (cur.ma25 as number | null) ?? null;
	const maPosition =
		ma5 != null && ma25 != null && close != null && close > ma5 && close > ma25
			? "above"
			: ma5 != null &&
					ma25 != null &&
					close != null &&
					close < ma5 &&
					close < ma25
				? "below"
				: "between";

	return {
		status: "ok",
		rows_n: n,
		latest_date: cur.date,
		close,
		range_high_20d: ind.range_high_20d,
		range_low_20d: ind.range_low_20d,
		range_pct: ind.range_pct,
		ma5,
		ma25,
		ma_position: maPosition,
		ma25_dev_pct: maDevPct(close, ma25),
		ma5_dev_pct: maDevPct(close, ma5),
		vol_x_20d: ind.vol_x_20d,
		rsi_14: ind.rsi_14,
		atr_pct: ind.atr_pct,
		atr_pct_baseline: ind.atr_pct_baseline,
		atr_vs_baseline: ind.atr_vs_baseline,
	};
}

// --- prices: トレンド素材 + 鮮度 (age>2h で closed) --------------------------
export interface PriceRow {
	slot?: string | null;
	change_pct?: number | null;
	volume?: number | null;
	quote_time?: string | null;
	[key: string]: unknown;
}

export function buildPrices(
	rows: PriceRow[],
	epochNow: number,
): Record<string, unknown> {
	if (!rows || rows.length === 0) return { status: "unavailable" };
	const latest = rows[0];
	const fetchedAt = (latest as { fetched_at?: string }).fetched_at;
	let quoteStatus: "live" | "closed" | "unavailable";
	let ageH = 0;
	if (fetchedAt) {
		ageH = Math.floor((epochNow - new Date(fetchedAt).getTime()) / 3600_000);
		quoteStatus = ageH > 2 ? "closed" : "live";
	} else {
		quoteStatus = "unavailable";
	}
	return {
		status: "ok",
		quote_status: quoteStatus,
		age_hours: ageH,
		rows_n: rows.length,
		latest,
		series: rows.map((r) => ({
			slot: r.slot ?? null,
			change_pct: r.change_pct ?? null,
			volume: r.volume ?? null,
			quote_time: r.quote_time ?? null,
		})),
	};
}

// in-source tests (judge-context.bats と一致させる)。
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("buildEarnings", () => {
		it("next_date があれば暦日差を出す", () => {
			expect(buildEarnings("2026-06-30", "2026-06-20")).toEqual({
				status: "ok",
				next_date: "2026-06-30",
				days_to_earnings: 10,
			});
		});
		it("next_date 無しは unknown/null", () => {
			expect(buildEarnings(null, "2026-06-20")).toEqual({
				status: "unknown",
				next_date: null,
				days_to_earnings: null,
			});
		});
	});

	describe("buildPremarket", () => {
		const now = Date.parse("2026-06-20T00:00:00Z");
		it("1時間前は ok、値を載せる", () => {
			const out = buildPremarket(
				{
					fetched_at: new Date(now - 3600_000).toISOString(),
					sox_change_pct: 1.2,
				},
				now,
			);
			expect(out.status).toBe("ok");
			expect(out.sox_change_pct).toBe(1.2);
		});
		it("24時間前は stale (>20h)", () => {
			const out = buildPremarket(
				{ fetched_at: new Date(now - 24 * 3600_000).toISOString() },
				now,
			);
			expect(out.status).toBe("stale");
		});
		it("行なしは unavailable", () => {
			expect(buildPremarket(null, now)).toEqual({ status: "unavailable" });
		});
	});

	describe("buildMargin", () => {
		it("2週分で WoW を出す (floor1)", () => {
			const out = buildMargin([
				{ date: "2026-06-19", long_qty: 150.0, short_qty: 40.0, ratio: 3.75 },
				{ date: "2026-06-12", long_qty: 100.0, short_qty: 50.0, ratio: 2.0 },
			]);
			expect(out.status).toBe("ok");
			expect(out.long_chg).toBe(50);
			expect(out.short_chg).toBe(-10);
			expect(out.prev_date).toBe("2026-06-12");
		});
		it("1週分は WoW null", () => {
			const out = buildMargin([
				{ date: "2026-06-19", long_qty: 150.0, short_qty: 40.0, ratio: 3.75 },
			]);
			expect(out.status).toBe("ok");
			expect(out.long_chg).toBeNull();
			expect(out.prev_date).toBeNull();
		});
		it("行なしは unavailable", () => {
			expect(buildMargin([])).toEqual({ status: "unavailable" });
		});
	});

	describe("buildDaily", () => {
		// ma は生 daily 行には無く withMovingAverages が付与する (本番 /latest と同じ)。
		// bats は ma 列を注入していたが、Worker 化後は ma を内部計算するのでこのテストもそれに合わせる。
		// 新しい順 (DESC) の系列を close 配列から作る (i=0 が最古)。high/low は close±spread。
		const desc = (
			closes: number[],
			opts: { spread?: number; volume?: number[] } = {},
		): DailyRow[] => {
			const spread = opts.spread ?? 1;
			const asc = closes.map((c, i) => ({
				date: `2026-06-${String(i + 1).padStart(2, "0")}`,
				high: c + spread,
				low: c - spread,
				close: c,
				volume: opts.volume ? opts.volume[i] : 1000,
			}));
			return asc.reverse();
		};

		it("5本未満は insufficient", () => {
			const out = buildDaily(desc([100]));
			expect(out.status).toBe("insufficient");
			expect(out.rows_n).toBe(1);
		});
		it("高値圏 (単調上昇) は range_pct≧80 / ma above", () => {
			// ma_position は ma25 が要る = 25本以上。単調上昇 → close は ma5/ma25 より上 → above。
			const out = buildDaily(
				desc(Array.from({ length: 30 }, (_, i) => 10 + i)),
			);
			expect(out.status).toBe("ok");
			expect(out.range_pct as number).toBeGreaterThanOrEqual(80);
			expect(out.ma_position).toBe("above");
		});
		it("安値圏 (単調下降) は range_pct≦20 / ma below", () => {
			const out = buildDaily(
				desc(Array.from({ length: 30 }, (_, i) => 40 - i)),
			);
			expect(out.range_pct as number).toBeLessThanOrEqual(20);
			expect(out.ma_position).toBe("below");
		});
		it("出来高倍率: 最新が平均の約2倍 → 1.9", () => {
			const vols = [...Array(19).fill(1000), 2000];
			const closes = Array.from({ length: 20 }, (_, i) => 10 + i);
			const out = buildDaily(desc(closes, { volume: vols }));
			// indicators.ts の vol_x_20d テストと同じ: (19*1000+2000)/20=1050, 2000/1050=1.9
			expect(out.vol_x_20d).toBe(1.9);
		});
		it("15本未満は rsi/atr が null", () => {
			const out = buildDaily(
				desc(Array.from({ length: 14 }, (_, i) => 10 + i)),
			);
			expect(out.rsi_14).toBeNull();
			expect(out.atr_pct).toBeNull();
		});
	});

	describe("buildPrices", () => {
		const now = Date.parse("2026-06-20T05:00:00Z");
		it("3時間前は closed", () => {
			const out = buildPrices(
				[
					{
						slot: "regular",
						change_pct: 1.2,
						volume: 100,
						quote_time: "t",
						fetched_at: new Date(now - 3 * 3600_000).toISOString(),
					},
				],
				now,
			);
			expect(out.quote_status).toBe("closed");
			expect(out.status).toBe("ok");
		});
		it("1時間前は live、series を整形", () => {
			const out = buildPrices(
				[
					{
						slot: "regular",
						change_pct: 1.2,
						volume: 100,
						quote_time: "t",
						fetched_at: new Date(now - 3600_000).toISOString(),
					},
				],
				now,
			);
			expect(out.quote_status).toBe("live");
			expect((out.series as unknown[]).length).toBe(1);
		});
		it("行なしは unavailable", () => {
			expect(buildPrices([], now)).toEqual({ status: "unavailable" });
		});
	});
}
