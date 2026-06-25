// 「他プレイヤーの強制的な売買フロー」(追証売り=買い方のロスカット / 踏み上げ=売り方のロスカット)
// を決定論的に検知して D1 forced_liquidation に保存する。LLM を介さない (収集に LLM を置かない方針)。
//
// 設計 (docs/forced-flow-strategy.md と同一思想):
//   - 判定は決定論なので judge は不要。eod cron で daily(指標) + margin から算出し D1 に保存。
//     judge (signal-judge=LLM) には渡さない (daily 指標から自前で読めるので判断材料として冗長)。
//     post-signal.sh が投稿時に D1 から最新行を引き、stance!=none のとき観測行を本文末尾に貼るだけ。
//   - 着火 (急落/急騰) は固定 N% でなく ATR 比 (|change| / atr_pct ≧ 2.0) で判定する。
//     半導体のような高ボラ銘柄でも誤検知しにくく、銘柄ごとの平時ボラを自動で吸収する。
//   - ロング (買い方の追証=投げ) と ショート (売り方の追証=踏み上げ) は同一フレームの符号違い。
//     1 銘柄で両方向のスコアを出し、強い方 (fuel+fire 合計が大きい方、同点はロング優先) を採用する。
//   - 指標算出 (computeDailyIndicators) とスコアロジックは分離する。ここは「指標 + 最新足 + margin →
//     スコア」の純粋関数。指標算出は呼び出し側 (eod cron) が先に行い、ここへ注入する。
//
// 3 レイヤースコア (各 0..3):
//   fuel    投げ/踏みの「燃料」。含み損を抱えた信用建玉の積み上がり (静的)。
//   fire    「着火」。ATR 比の異常変動 + 平均建値(MA25)割れ/抜け + ボラ急拡大 (動的・当日)。
//   exhaust 「出尽くし」。出来高急増 + RSI 過熱/売られすぎ + 長いヒゲ (投げ/踏みを吸収した跡)。
//
// stance:
//   building   fuel≧2 × fire≧2 × exhaust<2  → これから出る。順張り側はまだ待ち。
//   exhausted  fuel≧2 × fire≧2 × exhaust≧2  → 出尽くし。ロング=リバ買い場 / ショート=戻り売り場。
//   none       それ以外。ただの値動き。

import { desc, eq } from "drizzle-orm";
import { db } from "./db";
import type { Env } from "./env";
import {
	computeDailyIndicators,
	type DailyIndicators,
	type DailyRow,
	maDevPct,
	withMovingAverages,
} from "./indicators";
import { daily, forcedLiquidation, margin } from "./schema";
import { WATCHLIST } from "./timeseries";

// 算出に使う閾値。呼び出し側から差し替え可能にしてテストしやすくする。
interface ForcedThresholds {
	fireAtrX: number; // 着火とみなす |change|/atr_pct の下限 (FL_FIRE_ATR_X=2.0)
	ratioHi: number; // 買い長とみなす信用倍率の下限 (FL_RATIO_HI=3.0)
	ratioLo: number; // 売り長とみなす信用倍率の上限 (FL_RATIO_LO=1.0)
	volX: number; // 出尽くしとみなす出来高倍率の下限 (FL_VOL_X=3.0)
	rsiLow: number; // 売られすぎ RSI 上限 (FL_RSI_LOW=30)
	rsiHigh: number; // 買われすぎ RSI 下限 (FL_RSI_HIGH=70)
	settleDays: number; // 追証発生(=着火)から強制決済までの猶予営業日数 (FL_SETTLE_DAYS=2)
	fireAbsPct: number; // ATR 比に依らず単独で着火とみなす絶対変動率 (%) (FL_FIRE_ABS_PCT=12)
}

const DEFAULT_THRESHOLDS: ForcedThresholds = {
	fireAtrX: 2.0,
	ratioHi: 3.0,
	ratioLo: 1.0,
	volX: 3.0,
	rsiLow: 30,
	rsiHigh: 70,
	settleDays: 2,
	fireAbsPct: 12,
};

// スコア算出に必要な「最新の確定足」フィールド (指標とは別に渡す当日の生値)。
interface LatestBar {
	changePct: number | null; // 当日前日比 (%)。着火の符号と大きさに使う
	close: number | null;
	ma25: number | null; // /latest が付与する 25日移動平均。平均建値の目安
	hasLowerWick: boolean; // 安値から戻して引けた (= 投げを吸収)。close が当日レンジ上半分
	hasUpperWick: boolean; // 高値から押し戻された (= 踏みを吸収)。close が当日レンジ下半分
}

// 最新の margin の正規化済み値。
interface MarginSnapshot {
	ratio: number | null;
	longChg: number | null; // WoW 信用買残増減 (千株)。新規高値掴みの積み上がり
	shortChg: number | null; // WoW 信用売残増減 (千株)
}

type Direction = "long" | "short" | "none";
type Stance = "building" | "exhausted" | "none";

interface ForcedScore {
	ticker: string;
	date: string;
	direction: Direction;
	stance: Stance;
	scores: { fuel: number; fire: number; exhaust: number };
	settleWarningInDays: number | null;
	summary: string;
}

// daily 行から「下ヒゲ/上ヒゲ (= 投げ/踏みの吸収跡)」を読むヘルパ。呼び出し側が LatestBar を組む前に使う。
//   下ヒゲ: close が当日レンジの上半分に引ける (安値から戻した)。
//   上ヒゲ: close が下半分に引ける (高値から押し戻された)。
function readWicks(
	high: number | null,
	low: number | null,
	close: number | null,
): { hasLowerWick: boolean; hasUpperWick: boolean } {
	if (high == null || low == null || close == null || high - low <= 0) {
		return { hasLowerWick: false, hasUpperWick: false };
	}
	const range = high - low;
	return {
		hasLowerWick: (close - low) / range > 0.5,
		hasUpperWick: (high - close) / range > 0.5,
	};
}

const noneScore = (ticker: string, date: string): ForcedScore => ({
	ticker,
	date,
	direction: "none",
	stance: "none",
	scores: { fuel: 0, fire: 0, exhaust: 0 },
	settleWarningInDays: null,
	summary: `⚪ ${ticker} 強制フロー: 該当なし`,
});

// 指標 + 最新足 + margin から強制決済スコアを算出する純粋関数。指標が null (daily 不足) なら none。
function computeForcedScore(
	ticker: string,
	date: string,
	ind: DailyIndicators | null,
	bar: LatestBar,
	margin: MarginSnapshot,
	thr: ForcedThresholds = DEFAULT_THRESHOLDS,
): ForcedScore {
	if (!ind) return noneScore(ticker, date);

	const { changePct: chg, close, ma25 } = bar;
	const atrPct = ind.atr_pct;
	// ATR の何倍動いたか (符号付き)。atr_pct が無い/0 なら着火判定不可。
	const atrMove =
		chg != null && atrPct != null && atrPct > 0 ? chg / atrPct : null;
	const ma25Dev = maDevPct(close, ma25);

	// 絶対%の単独着火: 連日の高ボラで atr_pct が膨張すると ATR 比着火 (atrMove) が機能しなくなり、
	// 一気に上げてきた直後の急落は close<ma25 もまだ立たない。そこで「ATR 比に依らず絶対 N% 動いたら
	// 着火」を別建てで足し、fire の上限内 (3) で MA25/ATR 比条件を肩代わりする 2 点を与える。
	const absFireLong = chg != null && chg <= -thr.fireAbsPct ? 2 : 0;
	const absFireShort = chg != null && chg >= thr.fireAbsPct ? 2 : 0;

	// ── ロング (買い方の追証=投げ): 下落で着火、MA25 を下抜け、買い長 (ratio高) ──
	const longFuel =
		(margin.ratio != null && margin.ratio >= thr.ratioHi ? 1 : 0) +
		(margin.longChg != null && margin.longChg > 0 ? 1 : 0) +
		(ma25Dev != null && ma25Dev > -3 ? 1 : 0);
	const longFire = Math.min(
		3,
		(atrMove != null && atrMove <= -thr.fireAtrX ? 1 : 0) +
			(close != null && ma25 != null && close < ma25 ? 1 : 0) +
			(ind.atr_vs_baseline != null && ind.atr_vs_baseline > 1.2 ? 1 : 0) +
			absFireLong,
	);
	const longExhaust =
		(ind.vol_x_20d != null && ind.vol_x_20d >= thr.volX ? 1 : 0) +
		(ind.rsi_14 != null && ind.rsi_14 < thr.rsiLow ? 1 : 0) +
		(chg != null && chg < 0 && bar.hasLowerWick ? 1 : 0);

	// ── ショート (売り方の追証=踏み上げ): 上昇で着火、MA25 を上抜け、売り長 (ratio低) ──
	const shortFuel =
		(margin.ratio != null && margin.ratio <= thr.ratioLo ? 1 : 0) +
		(margin.shortChg != null && margin.shortChg > 0 ? 1 : 0) +
		(ma25Dev != null && ma25Dev < 3 ? 1 : 0);
	const shortFire = Math.min(
		3,
		(atrMove != null && atrMove >= thr.fireAtrX ? 1 : 0) +
			(close != null && ma25 != null && close > ma25 ? 1 : 0) +
			(ind.atr_vs_baseline != null && ind.atr_vs_baseline > 1.2 ? 1 : 0) +
			absFireShort,
	);
	const shortExhaust =
		(ind.vol_x_20d != null && ind.vol_x_20d >= thr.volX ? 1 : 0) +
		(ind.rsi_14 != null && ind.rsi_14 > thr.rsiHigh ? 1 : 0) +
		(chg != null && chg > 0 && bar.hasUpperWick ? 1 : 0);

	// 強い方向を採用 (fuel+fire 合計が大きい方。同点はロング優先=投げ警戒を優先)。
	const direction: Direction =
		shortFuel + shortFire > longFuel + longFire ? "short" : "long";
	const fuel = direction === "long" ? longFuel : shortFuel;
	const fire = direction === "long" ? longFire : shortFire;
	const exhaust = direction === "long" ? longExhaust : shortExhaust;

	// stance: 着火(fire≧2) かつ 燃料(fuel≧2) が揃って初めて意味を持つ。出尽くしの有無で building/exhausted。
	let stance: Stance = "none";
	if (fuel >= 2 && fire >= 2) stance = exhaust >= 2 ? "exhausted" : "building";

	if (stance === "none") return noneScore(ticker, date);

	const settleWarningInDays = stance === "building" ? thr.settleDays : null;
	const dirLabel = direction === "long" ? "🔻投げ警戒" : "🔺踏み上げ警戒";
	const score = `[fuel${fuel}/fire${fire}/exhaust${exhaust}]`;
	const summary =
		stance === "building"
			? `${dirLabel} ${ticker} ${score} 強制決済リスク↑ (~${settleWarningInDays}営業日後の前場に投げ/踏み)`
			: `${dirLabel} ${ticker} ${score} 出尽くし — ${direction === "long" ? "リバ買い場の候補" : "戻り売り場の候補"}`;

	return {
		ticker,
		date,
		direction,
		stance,
		scores: { fuel, fire, exhaust },
		settleWarningInDays,
		summary,
	};
}

// 最新2本の margin 行 (date DESC) から WoW 増減 (long_chg/short_chg) と最新 ratio を組む。
// 最新-前週、千株単位 (floor1 相当はかけず生値)。
function marginSnapshotFromRows(
	rows: {
		longQty: number | null;
		shortQty: number | null;
		ratio: number | null;
	}[],
): MarginSnapshot {
	const cur = rows[0];
	const prev = rows[1];
	if (!cur) return { ratio: null, longChg: null, shortChg: null };
	const wow = (
		c: number | null | undefined,
		p: number | null | undefined,
	): number | null => (c != null && p != null ? c - p : null);
	return {
		ratio: cur.ratio ?? null,
		longChg: prev ? wow(cur.longQty, prev.longQty) : null,
		shortChg: prev ? wow(cur.shortQty, prev.shortQty) : null,
	};
}

// 1 銘柄分: D1 の daily(70本) + margin(2本) を読み、指標→スコアを算出して ForcedScore を返す。
// daily 不足や行欠落でも noneScore に倒れる (例外は投げない)。
async function scoreOne(
	env: Env,
	ticker: string,
	today: string,
): Promise<ForcedScore> {
	const d = db(env.DB);
	// daily は ATR baseline 用に多めに 70 本。date DESC。
	const dailyRaw = (await d
		.select({
			date: daily.date,
			high: daily.high,
			low: daily.low,
			close: daily.close,
			changePct: daily.changePct,
			volume: daily.volume,
		})
		.from(daily)
		.where(eq(daily.ticker, ticker))
		.orderBy(desc(daily.date))
		.limit(70)
		.all()) as Record<string, unknown>[];
	// ma25 を付与 (date DESC のまま全件渡す → 同順で ma 付き)。
	const withMa = withMovingAverages(dailyRaw, dailyRaw.length) as DailyRow[];
	const ind = computeDailyIndicators(withMa);
	const cur = withMa[0]; // date DESC 先頭 = 最新足

	const marginRows = await d
		.select({
			longQty: margin.longQty,
			shortQty: margin.shortQty,
			ratio: margin.ratio,
		})
		.from(margin)
		.where(eq(margin.ticker, ticker))
		.orderBy(desc(margin.date))
		.limit(2)
		.all();
	const m = marginSnapshotFromRows(marginRows);

	const wicks =
		cur != null
			? readWicks(cur.high, cur.low, cur.close)
			: { hasLowerWick: false, hasUpperWick: false };
	const bar: LatestBar = {
		changePct: cur?.changePct ?? null,
		close: cur?.close ?? null,
		ma25: cur?.ma25 ?? null,
		hasLowerWick: wicks.hasLowerWick,
		hasUpperWick: wicks.hasUpperWick,
	};
	return computeForcedScore(ticker, today, ind, bar, m);
}

// watchlist 全銘柄 (codeFilter 指定時はその1銘柄) の強制決済スコアを算出し D1 に upsert する。
// eod cron (daily/margin が揃った後) から呼ぶ。1銘柄が落ちても他は続行する。
// today は算出基準日 (= 冪等キー date)。省略時は UTC の暦日 (eod は JST 16:00 = UTC 07:00 なので同日)。
export async function collectForcedLiquidation(
	env: Env,
	codeFilter: string | null,
	today?: string,
): Promise<{ results: Record<string, unknown> }> {
	const date = today ?? new Date().toISOString().slice(0, 10);
	const fetchedAt = new Date().toISOString();
	const codes = WATCHLIST.filter((c) => !codeFilter || c === codeFilter);
	const results: Record<string, unknown> = {};
	const d = db(env.DB);
	for (const ticker of codes) {
		try {
			const s = await scoreOne(env, ticker, date);
			await d
				.insert(forcedLiquidation)
				.values({
					ticker,
					date,
					direction: s.direction,
					stance: s.stance,
					fuel: s.scores.fuel,
					fire: s.scores.fire,
					exhaust: s.scores.exhaust,
					settleWarningInDays: s.settleWarningInDays,
					summary: s.summary,
					fetchedAt,
				})
				.onConflictDoUpdate({
					target: [forcedLiquidation.ticker, forcedLiquidation.date],
					set: {
						direction: s.direction,
						stance: s.stance,
						fuel: s.scores.fuel,
						fire: s.scores.fire,
						exhaust: s.scores.exhaust,
						settleWarningInDays: s.settleWarningInDays,
						summary: s.summary,
						fetchedAt,
					},
				})
				.run();
			results[ticker] = { direction: s.direction, stance: s.stance };
		} catch (e) {
			results[ticker] = { error: (e as Error).message };
		}
	}
	return { results };
}

// in-source tests (本番ビルドでは tree-shake される)。
// 指標を直接注入してスコアロジックの分岐を検証する (指標算出は indicators.ts のテストが担保)。
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	// 全フィールドを揃えた指標の素 (各テストで効かせたい値だけ上書きする)。
	const IND = (over: Partial<DailyIndicators> = {}): DailyIndicators => ({
		range_high_20d: 110,
		range_low_20d: 90,
		range_pct: 50,
		vol_x_20d: 1,
		rsi_14: 50,
		atr_pct: 3,
		atr_pct_baseline: 2,
		atr_vs_baseline: 1.5,
		vol_pctile_60d: null,
		move_per_vol: null,
		obv_trend: null,
		ad_trend: null,
		cmf_20d: null,
		volume_quality: null,
		momentum_state: null,
		...over,
	});
	const BAR = (over: Partial<LatestBar> = {}): LatestBar => ({
		changePct: 0,
		close: 100,
		ma25: 100,
		hasLowerWick: false,
		hasUpperWick: false,
		...over,
	});
	const M = (
		ratio: number,
		longChg: number,
		shortChg: number,
	): MarginSnapshot => ({ ratio, longChg, shortChg });

	describe("computeForcedScore", () => {
		it("long building: 買い長 + ATR2倍超の下落 + MA25下抜け, 出尽くし無し", () => {
			// chg -8 / atr 3 => -2.66x 着火, close(99)<ma25(100), atr_vs_baseline 1.5(>1.2) → fire 3
			// ratio4(≥3) + long_chg+ + ma25_dev=-1(> -3) → fuel 3。vol/rsi/wick なし → exhaust 0
			const out = computeForcedScore(
				"285A",
				"2026-01-31",
				IND(),
				BAR({ changePct: -8, close: 99, ma25: 100 }),
				M(4, 5000, 0),
			);
			expect(out.direction).toBe("long");
			expect(out.stance).toBe("building");
			expect(out.scores.fuel).toBe(3);
			expect(out.scores.fire).toBe(3);
			expect(out.settleWarningInDays).toBe(2);
			expect(out.summary).toContain("投げ警戒");
		});

		it("long building: 高ボラで ATR 比着火が効かなくても絶対%大暴落なら着火 (285A 2026-06-23 相当)", () => {
			// 実データ: chg -15.1 / atr_pct 8.7 => atrMove -1.74 (>-2 で ATR 比は不成立)、
			// close 92290 > ma25 77055 (乖離 +19.7 → 平均建値割れも未成立)、atr_vs_baseline 1.1 (≤1.2)。
			// 旧ロジックでは fire 0 で none。絶対%着火 (|chg|≥12 → +2) で fire 2 に底上げ。
			// fuel: ratio 12(≥3) + long_chg<0 + ma25_dev +19.7(> -3) → 2。fire 2 × fuel 2 → building。
			const out = computeForcedScore(
				"285A",
				"2026-06-23",
				IND({ atr_pct: 8.7, atr_pct_baseline: 7.9, atr_vs_baseline: 1.1 }),
				BAR({ changePct: -15.1, close: 92290, ma25: 77056 }),
				M(12, -691, 0),
			);
			expect(out.direction).toBe("long");
			expect(out.stance).toBe("building");
			expect(out.scores.fire).toBe(2);
			expect(out.scores.fuel).toBe(2);
			expect(out.summary).toContain("投げ警戒");
		});

		it("fire は絶対%着火を足しても上限 3 を超えない", () => {
			// ATR 比着火 + MA25 下抜け + ボラ拡大 (各1) に絶対%着火(+2)が重なっても clamp で 3。
			const out = computeForcedScore(
				"285A",
				"2026-01-31",
				IND({ atr_vs_baseline: 1.5 }),
				BAR({ changePct: -20, close: 80, ma25: 100 }),
				M(4, 5000, 0),
			);
			expect(out.scores.fire).toBe(3);
		});

		it("long exhausted: 同じ fuel+fire + 出来高急増 + RSI売られすぎ", () => {
			// exhaust: vol_x 4(≥3) + rsi 25(<30) → 2 → exhausted
			const out = computeForcedScore(
				"285A",
				"2026-01-31",
				IND({ vol_x_20d: 4, rsi_14: 25 }),
				BAR({ changePct: -8, close: 99, ma25: 100, hasLowerWick: true }),
				M(4, 5000, 0),
			);
			expect(out.direction).toBe("long");
			expect(out.stance).toBe("exhausted");
			expect(out.scores.exhaust).toBeGreaterThanOrEqual(2);
			expect(out.settleWarningInDays).toBeNull();
		});

		it("short squeeze building: 売り長 + ATR2倍超の上昇 + MA25上抜け", () => {
			// chg +9 / atr 3 => +3x 着火, close(108)>ma25(100), atr_vs_baseline 1.5 → fire 3
			// ratio0.8(≤1) + short_chg+ + ma25_dev=+8(<3 は不成立) → fuel 2
			const out = computeForcedScore(
				"6920",
				"2026-01-31",
				IND(),
				BAR({ changePct: 9, close: 108, ma25: 100 }),
				M(0.8, 0, 3000),
			);
			expect(out.direction).toBe("short");
			expect(out.stance).toBe("building");
			expect(out.scores.fuel).toBeGreaterThanOrEqual(2);
		});

		it("none: ATR 内の小さな動きは着火しない", () => {
			// chg -2 / atr 3 => -0.66x (着火せず)。fuel はあっても fire<2 → none
			const out = computeForcedScore(
				"6857",
				"2026-01-31",
				IND({ atr_vs_baseline: 1.0 }),
				BAR({ changePct: -2, close: 99, ma25: 100 }),
				M(4, 5000, 0),
			);
			expect(out.stance).toBe("none");
		});

		it("none: 着火しても燃料が無い (薄い信用)", () => {
			// 着火はするが ratio低・long_chg<=0・乖離マイナス大 → long_fuel 0 → none
			const out = computeForcedScore(
				"6981",
				"2026-01-31",
				IND(),
				BAR({ changePct: -8, close: 80, ma25: 100 }),
				M(1.0, -5000, 0),
			);
			expect(out.stance).toBe("none");
		});

		it("指標 null (daily 不足) は none", () => {
			const out = computeForcedScore(
				"285A",
				"2026-01-31",
				null,
				BAR(),
				M(4, 5000, 0),
			);
			expect(out.stance).toBe("none");
			expect(out.direction).toBe("none");
		});
	});

	describe("marginSnapshotFromRows", () => {
		it("最新-前週で WoW 増減、ratio は最新", () => {
			const out = marginSnapshotFromRows([
				{ longQty: 360, shortQty: 120, ratio: 3 },
				{ longQty: 330, shortQty: 110, ratio: 3 },
			]);
			expect(out.ratio).toBe(3);
			expect(out.longChg).toBe(30);
			expect(out.shortChg).toBe(10);
		});
		it("前週が無ければ chg は null", () => {
			const out = marginSnapshotFromRows([
				{ longQty: 360, shortQty: 120, ratio: 3 },
			]);
			expect(out.longChg).toBeNull();
			expect(out.shortChg).toBeNull();
			expect(out.ratio).toBe(3);
		});
		it("行が無ければ全 null", () => {
			expect(marginSnapshotFromRows([])).toEqual({
				ratio: null,
				longChg: null,
				shortChg: null,
			});
		});
	});

	describe("readWicks", () => {
		it("close が上半分なら下ヒゲ", () => {
			// high100 low80 close95 → (95-80)/20 = 0.75 > 0.5
			expect(readWicks(100, 80, 95).hasLowerWick).toBe(true);
			expect(readWicks(100, 80, 95).hasUpperWick).toBe(false);
		});
		it("close が下半分なら上ヒゲ", () => {
			expect(readWicks(100, 80, 85).hasUpperWick).toBe(true);
			expect(readWicks(100, 80, 85).hasLowerWick).toBe(false);
		});
		it("レンジ 0 / null は両方 false", () => {
			expect(readWicks(100, 100, 100)).toEqual({
				hasLowerWick: false,
				hasUpperWick: false,
			});
			expect(readWicks(null, 80, 95)).toEqual({
				hasLowerWick: false,
				hasUpperWick: false,
			});
		});
	});
}
