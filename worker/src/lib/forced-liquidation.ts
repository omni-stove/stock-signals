// 「他プレイヤーの強制的な売買フロー」(追証売り=買い方のロスカット / 踏み上げ=売り方のロスカット)
// を決定論的に検知して D1 forced_liquidation に保存する。LLM を介さない (収集に LLM を置かない方針)。
//
// 設計:
//   - スコアは決定論で eod cron が daily(指標) + margin から算出し D1 に保存する。
//     judge-context が最新行を forced ブロックとして judge (ticker-brief=LLM) に渡し、judge は
//     stance/fuel/fire/exhaust から「投げ/踏みが今日いつ出るか」を時間帯推論する材料にする。
//     post-brief.sh も投稿時に D1 から最新行を引き、stance!=none のとき観測行を本文末尾に貼る。
//   - 着火 (急落/急騰) は固定 N% でなく ATR 比 (|change| / atr_pct ≧ 2.0) で判定する。
//     半導体のような高ボラ銘柄でも誤検知しにくく、銘柄ごとの平時ボラを自動で吸収する。
//   - ロング (買い方の追証=投げ) と ショート (売り方の追証=踏み上げ) は同一フレームの符号違い。
//     1 銘柄で両方向のスコアを出し、強い方 (fuel+fire 合計が大きい方、同点はロング優先) を採用する。
//   - 指標算出 (computeDailyIndicators) とスコアロジックは分離する。ここは「指標 + 最新足 + margin →
//     スコア」の純粋関数。指標算出は呼び出し側 (eod cron) が先に行い、ここへ注入する。
//
// 3 レイヤースコア (各 0..3):
//   fuel    投げ/踏みの「燃料」。直近 CALL_WINDOW 本の値動きで追証ラインを新たに越えた推定信用建玉が
//           20日平均出来高の何日分あるか (margin-cost.ts)。倍率や残高の増減では「下げた区間に建玉が
//           あったか」が分からないため、建値分布から数える。
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
	withMovingAverages,
} from "./indicators";
import { type CostBar, estimateCostLots, newlyCalledQty } from "./margin-cost";
import { daily, forcedLiquidation, margin } from "./schema";
import { WATCHLIST } from "./timeseries";

// 算出に使う閾値。呼び出し側から差し替え可能にしてテストしやすくする。
interface ForcedThresholds {
	fireAtrX: number; // 着火とみなす |change|/atr_pct の下限 (FL_FIRE_ATR_X=2.0)
	callLossPct: number; // 追証がかかる建値からの逆行率 (%)。保証金率 30%・維持率 20% の現金担保で 10
	fuelDays: [number, number, number]; // fuel 1/2/3 とみなす「追証圏入り建玉 ÷ 20日平均出来高」の下限
	volX: number; // 出尽くしとみなす出来高倍率の下限 (FL_VOL_X=3.0)
	rsiLow: number; // 売られすぎ RSI 上限 (FL_RSI_LOW=30)
	rsiHigh: number; // 買われすぎ RSI 下限 (FL_RSI_HIGH=70)
	settleDays: number; // 追証発生(=着火)から強制決済までの猶予営業日数 (FL_SETTLE_DAYS=2)
	fireAbsPct: number; // ATR 比に依らず単独で着火とみなす絶対変動率 (%) (FL_FIRE_ABS_PCT=12)
}

const DEFAULT_THRESHOLDS: ForcedThresholds = {
	fireAtrX: 2.0,
	callLossPct: 10,
	fuelDays: [0.05, 0.1, 0.2],
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

// 追証ラインを新たに越えた推定信用建玉 ÷ 20日平均出来高 (日分)。建値分布が組めなければ null。
interface CalledVolume {
	longDays: number | null; // 買い方 (下落で追証)
	shortDays: number | null; // 売り方 (上昇で追証)
}

// 追証ラインを越えたかを測る基準: 直前この本数の終値のうち建玉に最も有利だったもの。
// 追証から強制決済までの猶予 (settleDays) より長く取り、決済がまだ出ていない分だけを数える。
const CALL_WINDOW = 5;
// 制度信用の返済期日 (6か月) を超えて残る建玉は少ないので、これより古い週次は建値分布に使わない。
const MARGIN_WEEKS = 26;

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
	called: CalledVolume,
	thr: ForcedThresholds = DEFAULT_THRESHOLDS,
): ForcedScore {
	if (!ind) return noneScore(ticker, date);

	const { changePct: chg, close, ma25 } = bar;
	const atrPct = ind.atr_pct;
	// ATR の何倍動いたか (符号付き)。atr_pct が無い/0 なら着火判定不可。
	const atrMove =
		chg != null && atrPct != null && atrPct > 0 ? chg / atrPct : null;

	// 絶対%の単独着火: 連日の高ボラで atr_pct が膨張すると ATR 比着火 (atrMove) が機能しなくなり、
	// 一気に上げてきた直後の急落は close<ma25 もまだ立たない。そこで「ATR 比に依らず絶対 N% 動いたら
	// 着火」を別建てで足し、fire の上限内 (3) で MA25/ATR 比条件を肩代わりする 2 点を与える。
	const absFireLong = chg != null && chg <= -thr.fireAbsPct ? 2 : 0;
	const absFireShort = chg != null && chg >= thr.fireAbsPct ? 2 : 0;

	const fuelOf = (days: number | null): number =>
		days == null ? 0 : thr.fuelDays.filter((t) => days >= t).length;

	// ── ロング (買い方の追証=投げ): 下落で着火、MA25 を下抜け ──
	const longFuel = fuelOf(called.longDays);
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

	// ── ショート (売り方の追証=踏み上げ): 上昇で着火、MA25 を上抜け ──
	const shortFuel = fuelOf(called.shortDays);
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
	const calledDays = direction === "long" ? called.longDays : called.shortDays;
	const fuelNote = `追証圏入りの推定${direction === "long" ? "買残" : "売残"}≈20日平均出来高の${calledDays?.toFixed(2)}日分`;
	const summary =
		stance === "building"
			? `${dirLabel} ${ticker} ${score} 強制決済リスク↑ (~${settleWarningInDays}営業日後の前場に投げ/踏み、${fuelNote})`
			: `${dirLabel} ${ticker} ${score} 出尽くし — ${direction === "long" ? "リバ買い場の候補" : "戻り売り場の候補"} (${fuelNote})`;

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

interface MarginQtyRows {
	date: string;
	longQty: number | null;
	shortQty: number | null;
}

/**
 * 信用残 (date ASC) と daily (date ASC、最後が最新足) から、直前 CALL_WINDOW 本の終値から最新終値までに
 * 追証ラインを新たに越えた推定建玉を 20日平均出来高の日数で返す。最新足より前の足が CALL_WINDOW 本
 * 無い、出来高が取れない、建値分布が組めない方向は null。
 */
function calledVolume(
	marginAsc: MarginQtyRows[],
	barsAsc: CostBar[],
	callLossPct: number,
): CalledVolume {
	const none: CalledVolume = { longDays: null, shortDays: null };
	const cur = barsAsc.at(-1);
	const prior = barsAsc.slice(0, -1);
	const window = prior
		.slice(-CALL_WINDOW)
		.map((b) => b.close)
		.filter((c): c is number => c != null);
	if (cur?.close == null || window.length < CALL_WINDOW) return none;
	const vols = prior
		.slice(-20)
		.map((b) => b.volume)
		.filter((v): v is number => v != null && v > 0);
	if (vols.length === 0) return none;
	const avgVol = vols.reduce((s, v) => s + v, 0) / vols.length;
	const close = cur.close;
	const days = (side: "long" | "short"): number | null => {
		const lots = estimateCostLots(
			marginAsc.map((m) => ({
				date: m.date,
				qty: side === "long" ? m.longQty : m.shortQty,
			})),
			prior,
		);
		if (!lots) return null;
		const ref = side === "long" ? Math.max(...window) : Math.min(...window);
		// 信用残は千株、出来高は株
		return (
			(newlyCalledQty(lots, side, close, ref, callLossPct) * 1000) / avgVol
		);
	};
	return { longDays: days("long"), shortDays: days("short") };
}

// 1 銘柄分: D1 の daily + margin を読み、指標→スコアを算出して ForcedScore を返す。
// daily 不足や行欠落でも noneScore に倒れる (例外は投げない)。
async function scoreOne(
	env: Env,
	ticker: string,
	today: string,
): Promise<ForcedScore> {
	const d = db(env.DB);
	// 建値分布は MARGIN_WEEKS 週の信用残の手前 60 本 (margin-cost.ts の SEED_BARS) まで遡る。date DESC。
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
		.limit(MARGIN_WEEKS * 5 + 70)
		.all()) as Record<string, unknown>[];
	// 指標は ATR baseline 用の 70 本で算出する。ma25 は date DESC のまま渡して同順で付与される。
	const recent = dailyRaw.slice(0, 70);
	const withMa = withMovingAverages(recent, recent.length) as DailyRow[];
	const ind = computeDailyIndicators(withMa);
	const cur = withMa[0];

	const marginRows = await d
		.select({
			date: margin.date,
			longQty: margin.longQty,
			shortQty: margin.shortQty,
		})
		.from(margin)
		.where(eq(margin.ticker, ticker))
		.orderBy(desc(margin.date))
		.limit(MARGIN_WEEKS)
		.all();
	const called = calledVolume(
		marginRows.slice().reverse(),
		(dailyRaw as unknown as CostBar[]).slice().reverse(),
		DEFAULT_THRESHOLDS.callLossPct,
	);

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
	return computeForcedScore(ticker, today, ind, bar, called);
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
	const C = (longDays: number, shortDays: number): CalledVolume => ({
		longDays,
		shortDays,
	});

	describe("computeForcedScore", () => {
		it("long building: 追証圏入りの買残が厚い + ATR2倍超の下落 + MA25下抜け, 出尽くし無し", () => {
			// chg -8 / atr 3 => -2.66x 着火, close(99)<ma25(100), atr_vs_baseline 1.5(>1.2) → fire 3
			// 追証圏入り 0.3日分 (≥0.2) → fuel 3。vol/rsi/wick なし → exhaust 0
			const out = computeForcedScore(
				"285A",
				"2026-01-31",
				IND(),
				BAR({ changePct: -8, close: 99, ma25: 100 }),
				C(0.3, 0),
			);
			expect(out.direction).toBe("long");
			expect(out.stance).toBe("building");
			expect(out.scores.fuel).toBe(3);
			expect(out.scores.fire).toBe(3);
			expect(out.settleWarningInDays).toBe(2);
			expect(out.summary).toContain("投げ警戒");
		});

		// 285A 2026-06-23 の実データ: chg -15.1 / atr_pct 8.7 => atrMove -1.74 (>-2 で ATR 比は不成立)、
		// close 92290 > ma25 77056、atr_vs_baseline 1.1 (≤1.2)。絶対%着火 (|chg|≥12 → +2) だけで fire 2。
		const BIG_DROP = {
			ind: IND({ atr_pct: 8.7, atr_pct_baseline: 7.9, atr_vs_baseline: 1.1 }),
			bar: BAR({ changePct: -15.1, close: 92290, ma25: 77056 }),
		};

		it("long building: 高ボラで ATR 比着火が効かなくても絶対%大暴落なら着火", () => {
			const out = computeForcedScore(
				"285A",
				"2026-06-23",
				BIG_DROP.ind,
				BIG_DROP.bar,
				C(0.12, 0),
			);
			expect(out.stance).toBe("building");
			expect(out.scores.fire).toBe(2);
			expect(out.scores.fuel).toBe(2);
			expect(out.summary).toContain(
				"追証圏入りの推定買残≈20日平均出来高の0.12日分",
			);
		});

		it("none: 大暴落でも下げた区間に追証圏入りの建玉が無ければ投げは出ない (285A 2026-06-23)", () => {
			// 実データの建値分布では、この日の下げで新たに建値 -10% を割った買残は 0
			const out = computeForcedScore(
				"285A",
				"2026-06-23",
				BIG_DROP.ind,
				BIG_DROP.bar,
				C(0, 0),
			);
			expect(out.stance).toBe("none");
		});

		it("fire は絶対%着火を足しても上限 3 を超えない", () => {
			// ATR 比着火 + MA25 下抜け + ボラ拡大 (各1) に絶対%着火(+2)が重なっても clamp で 3。
			const out = computeForcedScore(
				"285A",
				"2026-01-31",
				IND({ atr_vs_baseline: 1.5 }),
				BAR({ changePct: -20, close: 80, ma25: 100 }),
				C(0.3, 0),
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
				C(0.3, 0),
			);
			expect(out.direction).toBe("long");
			expect(out.stance).toBe("exhausted");
			expect(out.scores.exhaust).toBeGreaterThanOrEqual(2);
			expect(out.settleWarningInDays).toBeNull();
		});

		it("short squeeze building: 追証圏入りの売残 + ATR2倍超の上昇 + MA25上抜け", () => {
			// chg +9 / atr 3 => +3x 着火, close(108)>ma25(100), atr_vs_baseline 1.5 → fire 3
			// 追証圏入り 0.1日分 (≥0.1) → fuel 2
			const out = computeForcedScore(
				"6920",
				"2026-01-31",
				IND(),
				BAR({ changePct: 9, close: 108, ma25: 100 }),
				C(0, 0.1),
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
				C(0.3, 0),
			);
			expect(out.stance).toBe("none");
		});

		it("none: 着火しても燃料が薄い", () => {
			// 追証圏入り 0.04日分 (<0.05) → long_fuel 0 → none
			const out = computeForcedScore(
				"6981",
				"2026-01-31",
				IND(),
				BAR({ changePct: -8, close: 80, ma25: 100 }),
				C(0.04, 0),
			);
			expect(out.stance).toBe("none");
		});

		it("指標 null (daily 不足) は none", () => {
			const out = computeForcedScore(
				"285A",
				"2026-01-31",
				null,
				BAR(),
				C(0.3, 0),
			);
			expect(out.stance).toBe("none");
			expect(out.direction).toBe("none");
		});
	});

	describe("calledVolume", () => {
		const bar = (date: string, close: number, volume = 1_000_000): CostBar => ({
			date,
			high: close,
			low: close,
			close,
			volume,
		});
		// 1000 円で 100 千株、1200 円の週に 100 千株が積まれ、その後 1050 まで下げる
		const bars = [
			bar("2026-01-08", 1000),
			bar("2026-01-09", 1000),
			bar("2026-01-13", 1200),
			bar("2026-01-14", 1200),
			bar("2026-01-15", 1200),
			bar("2026-01-16", 1200),
			bar("2026-01-19", 1100),
		];
		const marginAsc = [
			{ date: "2026-01-09", longQty: 100, shortQty: 0 },
			{ date: "2026-01-16", longQty: 200, shortQty: 0 },
		];

		it("long: 直前5本の高値では割れていなかったロットだけを、平均出来高の日数で返す", () => {
			// 1200 のロット (ライン 1080) が 1050 で割れ、直前5本の最高値 1200 では未割れ → 100 千株 = 0.1日分
			const out = calledVolume(
				marginAsc,
				[...bars, bar("2026-01-20", 1050)],
				10,
			);
			expect(out.longDays).toBeCloseTo(0.1);
			expect(out.shortDays).toBe(0);
		});

		it("long: 下げた区間に建玉が無ければ 0", () => {
			// 1000 のロットのライン 900 にも 1200 のライン 1080 にも届かない
			const out = calledVolume(
				marginAsc,
				[...bars, bar("2026-01-20", 1090)],
				10,
			);
			expect(out.longDays).toBe(0);
		});

		it("直前の足が5本に満たなければ null", () => {
			const out = calledVolume(marginAsc, bars.slice(0, 4), 10);
			expect(out).toEqual({ longDays: null, shortDays: null });
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
