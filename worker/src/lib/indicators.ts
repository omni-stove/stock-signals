// テクニカル指標の決定論的な算出を 1 ヶ所に集約する純粋関数群。
//
// 設計:
//   - 指標 (RSI14 / ATR14 系列 / 20日レンジ位置 / 出来高倍率 / MA乖離率) を 1 ヶ所に集約し、
//     judge-context も forced-liquidation も「同じ計算結果を読むだけ」にする。
//   - ここは D1 にも HTTP にも依存しない。入力は daily 行の配列 (date 昇順/降順どちらも吸収)。
//   - 丸め・近似式: `(x*10|floor)/10` 等で「小数第1位を切り捨て」、RSI は Wilder ではなく SMA 版、
//     ATR baseline は「最新を除いた過去 atr_pct 系列の (長さ/2 floor) 番目」を中央値とする。

// daily 1 行が持つ最小フィールド。余分なキーがあっても無視する。
export interface DailyRow {
	date: string;
	open?: number | null;
	high: number | null;
	low: number | null;
	close: number | null;
	changePct?: number | null; // 前日比 (%)。指標計算では未使用、forced-liquidation の着火判定が読む
	volume?: number | null;
	ma25?: number | null; // withMovingAverages が付与。乖離率の素 (指標計算自体は別途 close vs ma)
	// MA は /latest が withMovingAverages で付与済み。指標計算では参照しない (乖離率は close vs ma を別途渡す)。
	[key: string]: unknown;
}

// 算出済み指標。
export interface DailyIndicators {
	range_high_20d: number | null;
	range_low_20d: number | null;
	range_pct: number | null; // 0=安値圏 100=高値圏 (整数。floor)
	vol_x_20d: number | null; // 最新 volume / 直近20日平均 volume (小数1桁)
	rsi_14: number | null; // SMA 版 RSI (整数。floor)
	atr_pct: number | null; // 最新の ATR14/close*100 (小数1桁)
	atr_pct_baseline: number | null; // 最新を除いた過去 atr_pct の中央値 (小数1桁)
	atr_vs_baseline: number | null; // atr_pct / baseline (小数2桁)
	// アキュムレーション/薄商い判別系。「上げたのに出来薄」が大口の蓄積か板薄かを読むための素材。
	vol_pctile_60d: number | null; // 最新出来高の過去60日順位 (0=最小 100=最大、整数。floor)。低い+急騰=売り物枯渇
	move_per_vol: number | null; // |最新 changePct| / vol_x_20d (小数2桁)。大=薄い板で価格が飛んだ
	obv_trend: "rising" | "flat" | "falling" | null; // OBV 直近10本の傾き符号。価格に先行 rising=裏で蓄積
	ad_trend: "rising" | "flat" | "falling" | null; // A/D ライン直近10本の傾き符号。高値引け×出来高で増=資金流入
	cmf_20d: number | null; // Chaikin Money Flow 20日 (小数2桁)。プラス圏=買い優勢
	// 上記を集約した判定。上げ+出来薄 (vol_x_20d<1) の局面でのみ accumulation/thin/mixed を出す。
	// それ以外 (下げ・出来高十分) は na = この読みは無関係。素材が欠ければ insufficient。
	volume_quality:
		| "accumulation"
		| "thin"
		| "mixed"
		| "na"
		| "insufficient"
		| null;
	// 過熱が利確に転じる閾値判定。high-in-range かつ出来高が細った = cracked (転換の芽)。
	// high-in-range だが出来高が伴う = extended (トレンド継続中の過熱)。高値圏でなければ na。
	momentum_state: "cracking" | "extended" | "na" | null;
}

// `(x * 10 | floor) / 10` = 小数第1位までを切り捨て (負値は floor なので下方向)。
function floor1(x: number): number {
	return Math.floor(x * 10) / 10;
}
// `(x * 100 | floor) / 100` = 小数第2位までを切り捨て。
function floor2(x: number): number {
	return Math.floor(x * 100) / 100;
}

// 入力 rows を date 昇順 (古→新) に正規化する。judge-context.sh は `sort_by(.date)` で昇順化する。
function toAsc(rows: DailyRow[]): DailyRow[] {
	return rows
		.slice()
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// 20日レンジ位置・出来高倍率。直近20本 (昇順末尾20本) に窓を絞る。
// judge-context.sh: range_pct = (close-lo)/(hi-lo)*100 | floor、vol_x = cur.volume/avgvol を floor1。
function rangeAndVolume(asc: DailyRow[]): {
	range_high_20d: number | null;
	range_low_20d: number | null;
	range_pct: number | null;
	vol_x_20d: number | null;
} {
	const win = asc.slice(-20);
	const cur = asc[asc.length - 1];
	const highs = win.map((r) => r.high).filter((v): v is number => v != null);
	const lows = win.map((r) => r.low).filter((v): v is number => v != null);
	const vols = win.map((r) => r.volume).filter((v): v is number => v != null);
	const hi = highs.length ? Math.max(...highs) : null;
	const lo = lows.length ? Math.min(...lows) : null;
	const avgvol = vols.length ? vols.reduce((a, b) => a + b, 0) / win.length : 0;
	const close = cur?.close ?? null;
	const range_pct =
		hi != null && lo != null && close != null && hi - lo > 0
			? Math.floor(((close - lo) / (hi - lo)) * 100)
			: null;
	const vol_x_20d =
		avgvol > 0 && cur?.volume != null ? floor1(cur.volume / avgvol) : null;
	return { range_high_20d: hi, range_low_20d: lo, range_pct, vol_x_20d };
}

// RSI14 (SMA 版)。直近14本の前日比 close 差から gain/loss の単純平均を取る。
// judge-context.sh: close 差15本以上 (= diffs14本) で計算可。loss==0 なら 100。最後に floor。
function rsi14(asc: DailyRow[]): number | null {
	const closes = asc.map((r) => r.close).filter((v): v is number => v != null);
	if (closes.length < 15) return null;
	const diffs: number[] = [];
	for (let i = 1; i < closes.length; i++) diffs.push(closes[i] - closes[i - 1]);
	if (diffs.length < 14) return null;
	const d14 = diffs.slice(-14);
	const gain = d14.reduce((a, d) => a + (d > 0 ? d : 0), 0) / 14;
	const loss = d14.reduce((a, d) => a + (d < 0 ? -d : 0), 0) / 14;
	if (loss === 0) return 100;
	return Math.floor(100 - 100 / (1 + gain / loss));
}

// ATR14 を atr_pct (= ATR14/その日のclose*100) のローリング系列として作り、
// 最新値・過去中央値 (baseline)・最新/baseline 比を返す。
// True Range = max(high-low, |high-prevClose|, |low-prevClose|)、
// 14本移動平均、atr_pct は floor1、baseline は「最新を除いた過去系列を sort して (len/2 floor) 番目」。
function atr(asc: DailyRow[]): {
	atr_pct: number | null;
	atr_pct_baseline: number | null;
	atr_vs_baseline: number | null;
} {
	// TR 系列 (各日1本、asc[i] は asc[i-1] を前日として使う)。high/low/close が欠ける日は計算不能。
	const trs: number[] = [];
	for (let i = 1; i < asc.length; i++) {
		const cur = asc[i];
		const prev = asc[i - 1];
		if (cur.high == null || cur.low == null || prev.close == null) {
			trs.push(Number.NaN);
			continue;
		}
		const hl = cur.high - cur.low;
		const hc = Math.abs(cur.high - prev.close);
		const lc = Math.abs(cur.low - prev.close);
		trs.push(Math.max(hl, hc, lc));
	}
	// atr_pct 系列: j は trs のインデックス、trs[j] は asc[j+1] の TR に対応するので close は asc[j+1].close。
	const atrPctSeries: number[] = [];
	for (let j = 13; j < trs.length; j++) {
		const window = trs.slice(j - 13, j + 1);
		if (window.some((v) => Number.isNaN(v))) continue;
		const a = window.reduce((x, y) => x + y, 0) / 14;
		const c = asc[j + 1]?.close;
		if (c != null && c > 0) atrPctSeries.push(floor1((a / c) * 100));
	}
	const atr_pct = atrPctSeries.length
		? atrPctSeries[atrPctSeries.length - 1]
		: null;
	// baseline: 最新を除いた過去系列を昇順 sort し、(length/2 floor) 番目を中央値とする。
	const hist = atrPctSeries
		.slice(0, -1)
		.slice()
		.sort((x, y) => x - y);
	const atr_pct_baseline =
		hist.length >= 5 ? floor1(hist[Math.floor(hist.length / 2)]) : null;
	const atr_vs_baseline =
		atr_pct != null && atr_pct_baseline != null && atr_pct_baseline > 0
			? floor2(atr_pct / atr_pct_baseline)
			: null;
	return { atr_pct, atr_pct_baseline, atr_vs_baseline };
}

// 系列の傾きを符号で返す (最初と最後を比べ、|相対変化| が 1% 未満は flat)。OBV/AD の方向だけを LLM に渡す。
function trendSign(series: number[]): "rising" | "flat" | "falling" | null {
	if (series.length < 2) return null;
	const first = series[0];
	const last = series[series.length - 1];
	const denom = Math.abs(first) || Math.abs(last);
	if (denom === 0)
		return last > first ? "rising" : last < first ? "falling" : "flat";
	const rel = (last - first) / denom;
	if (rel > 0.01) return "rising";
	if (rel < -0.01) return "falling";
	return "flat";
}

// money flow multiplier = ((close-low)-(high-close))/(high-low)。高値引けで +1、安値引けで -1。
function mfMultiplier(r: DailyRow): number | null {
	if (r.high == null || r.low == null || r.close == null) return null;
	const span = r.high - r.low;
	if (span <= 0) return 0; // 値幅ゼロの日は資金方向を測れない
	return (r.close - r.low - (r.high - r.close)) / span;
}

// アキュムレーション系: 出来高分位・値幅/出来高・OBV/AD 傾き・CMF20。
// asc は date 昇順。出来高や high/low/close が欠ける日は各指標内で個別にスキップする。
function accumulation(asc: DailyRow[]): {
	vol_pctile_60d: number | null;
	move_per_vol: number | null;
	obv_trend: "rising" | "flat" | "falling" | null;
	ad_trend: "rising" | "flat" | "falling" | null;
	cmf_20d: number | null;
	volume_quality: DailyIndicators["volume_quality"];
} {
	const cur = asc[asc.length - 1];

	// 出来高 60日分位: 過去60本 (最新含む) のうち最新がどの順位か。同値以下の本数 / 全体。
	const vol60 = asc
		.slice(-60)
		.map((r) => r.volume)
		.filter((v): v is number => v != null);
	const curVol = cur?.volume ?? null;
	const vol_pctile_60d =
		curVol != null && vol60.length >= 5
			? Math.floor(
					(vol60.filter((v) => v <= curVol).length / vol60.length) * 100,
				)
			: null;

	// 値幅あたり出来高: |最新 changePct| / vol_x_20d。vol_x は rangeAndVolume と同じ式で再計算。
	const volWin = asc
		.slice(-20)
		.map((r) => r.volume)
		.filter((v): v is number => v != null);
	const avgvol = volWin.length
		? volWin.reduce((a, b) => a + b, 0) / asc.slice(-20).length
		: 0;
	const volX = avgvol > 0 && curVol != null ? curVol / avgvol : null;
	const chgPct = typeof cur?.changePct === "number" ? cur.changePct : null;
	const move_per_vol =
		chgPct != null && volX != null && volX > 0
			? floor2(Math.abs(chgPct) / volX)
			: null;

	// OBV: 終値が上げた日は +volume、下げた日は -volume を累積。直近10点の傾き符号。
	const obv: number[] = [];
	let acc = 0;
	for (let i = 1; i < asc.length; i++) {
		const c = asc[i].close;
		const p = asc[i - 1].close;
		const v = asc[i].volume;
		if (c == null || p == null || v == null) continue;
		acc += c > p ? v : c < p ? -v : 0;
		obv.push(acc);
	}
	const obv_trend = obv.length >= 2 ? trendSign(obv.slice(-10)) : null;

	// A/D ライン: money flow multiplier × volume を累積。直近10点の傾き符号。
	const ad: number[] = [];
	let adAcc = 0;
	for (const r of asc) {
		const m = mfMultiplier(r);
		if (m == null || r.volume == null) continue;
		adAcc += m * r.volume;
		ad.push(adAcc);
	}
	const ad_trend = ad.length >= 2 ? trendSign(ad.slice(-10)) : null;

	// CMF20: 直近20本の Σ(mfm×volume) / Σ(volume)。プラス圏=買い優勢。
	const cmfWin = asc.slice(-20);
	let mfvSum = 0;
	let vSum = 0;
	for (const r of cmfWin) {
		const m = mfMultiplier(r);
		if (m == null || r.volume == null) continue;
		mfvSum += m * r.volume;
		vSum += r.volume;
	}
	const cmf_20d = vSum > 0 && cmfWin.length >= 5 ? floor2(mfvSum / vSum) : null;

	const volume_quality = classifyVolumeQuality({
		chgPct,
		volX,
		vol_pctile_60d,
		obv_trend,
		ad_trend,
		cmf_20d,
	});

	return {
		vol_pctile_60d,
		move_per_vol,
		obv_trend,
		ad_trend,
		cmf_20d,
		volume_quality,
	};
}

// 出来薄急騰の質を1ラベルに集約する決定論的分類。上げ+出来薄 (vol_x<1) の局面でのみ判定し、
// それ以外は na。蓄積 (売り物枯渇かつ資金流入) と薄商い (枯れていない/資金流出) を、
// vol_pctile_60d・OBV/AD 傾き・CMF の合議で振り分け、整合しなければ mixed。
function classifyVolumeQuality(x: {
	chgPct: number | null;
	volX: number | null;
	vol_pctile_60d: number | null;
	obv_trend: "rising" | "flat" | "falling" | null;
	ad_trend: "rising" | "flat" | "falling" | null;
	cmf_20d: number | null;
}): "accumulation" | "thin" | "mixed" | "na" | "insufficient" | null {
	if (x.chgPct == null || x.volX == null) return null;
	// 上げ + 出来薄でなければこの読みは無関係。
	if (x.chgPct <= 0 || x.volX >= 1) return "na";
	if (x.vol_pctile_60d == null || x.cmf_20d == null) return "insufficient";

	// 各論点に強気 (+1) / 弱気 (-1) / 中立 (0) を振り、多数決。
	const flow =
		x.obv_trend === "rising" || x.ad_trend === "rising"
			? 1
			: x.obv_trend === "falling" && x.ad_trend === "falling"
				? -1
				: 0;
	const exhaust = x.vol_pctile_60d <= 30 ? 1 : x.vol_pctile_60d >= 60 ? -1 : 0;
	const cmf = x.cmf_20d > 0.05 ? 1 : x.cmf_20d < -0.05 ? -1 : 0;
	const net = flow + exhaust + cmf;
	if (net >= 2) return "accumulation";
	if (net <= -2) return "thin";
	return "mixed";
}

// 過熱が利確に転じる芽を判定する決定論的分類。高値圏 (range_pct≧80) でなければ na。
// 高値圏かつ出来高が細った (vol_x<1) = cracking、出来高が伴う = extended。
function classifyMomentumState(
	range_pct: number | null,
	vol_x_20d: number | null,
): "cracking" | "extended" | "na" | null {
	if (range_pct == null || vol_x_20d == null) return null;
	if (range_pct < 80) return "na";
	return vol_x_20d < 1 ? "cracking" : "extended";
}

// daily 行 (date DESC = 新しい順) に終値の移動平均 ma5/ma25 を付与し、新しい順の最新 n 件を返す。
// 各日について「その日を含む過去 w 日」の終値平均を出す。期間に満たない古い日は null。
// /latest の daily 応答 (ma 同梱) と forced-liquidation の eod 算出が同じ MA を共有するためここに置く。
// 入力 rows は破壊しない。ma は四捨五入 (Math.round) で小数2桁 (range/atr の floor とは別系統)。
export function withMovingAverages(
	rows: Record<string, unknown>[],
	n: number,
): Record<string, unknown>[] {
	const asc = rows.slice().reverse(); // 古い順
	const closes = asc.map((r) => Number(r.close));
	const ma = (i: number, w: number): number | null => {
		if (i + 1 < w) return null; // 期間に満たない古い日は null
		const sum = closes.slice(i + 1 - w, i + 1).reduce((a, b) => a + b, 0);
		return Math.round((sum / w) * 100) / 100;
	};
	const withMa = asc.map((r, i) => ({ ...r, ma5: ma(i, 5), ma25: ma(i, 25) }));
	return withMa.reverse().slice(0, n); // 新しい順に戻し、要求件数へ
}

// MA からの乖離率 (%)。judge-context.sh: (close-ma)/ma*1000 | floor / 10 = floor1。
export function maDevPct(
	close: number | null,
	ma: number | null,
): number | null {
	if (close == null || ma == null || ma <= 0) return null;
	return floor1(((close - ma) / ma) * 100);
}

// daily 行配列 (昇順/降順どちらでも可) から全指標を算出する。5本未満は null だらけの insufficient。
export function computeDailyIndicators(
	rows: DailyRow[],
): DailyIndicators | null {
	if (rows.length < 5) return null;
	const asc = toAsc(rows);
	const rv = rangeAndVolume(asc);
	const at = atr(asc);
	const ac = accumulation(asc);
	return {
		range_high_20d: rv.range_high_20d,
		range_low_20d: rv.range_low_20d,
		range_pct: rv.range_pct,
		vol_x_20d: rv.vol_x_20d,
		rsi_14: rsi14(asc),
		atr_pct: at.atr_pct,
		atr_pct_baseline: at.atr_pct_baseline,
		atr_vs_baseline: at.atr_vs_baseline,
		vol_pctile_60d: ac.vol_pctile_60d,
		move_per_vol: ac.move_per_vol,
		obv_trend: ac.obv_trend,
		ad_trend: ac.ad_trend,
		cmf_20d: ac.cmf_20d,
		volume_quality: ac.volume_quality,
		momentum_state: classifyMomentumState(rv.range_pct, rv.vol_x_20d),
	};
}

// in-source tests (本番ビルドでは tree-shake される)。合成系列で数値を検証する。
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	// close=base からの単純な系列を date 昇順で作るヘルパ。high/low は close±spread。
	const series = (
		closes: number[],
		opts: { spread?: number; volume?: number[] } = {},
	): DailyRow[] => {
		const spread = opts.spread ?? 1;
		return closes.map((c, i) => ({
			date: `2026-01-${String(i + 1).padStart(2, "0")}`,
			high: c + spread,
			low: c - spread,
			close: c,
			volume: opts.volume ? opts.volume[i] : 1000,
		}));
	};

	describe("computeDailyIndicators", () => {
		it("5本未満は null (insufficient)", () => {
			expect(computeDailyIndicators(series([1, 2, 3, 4]))).toBeNull();
		});

		it("range_pct: 最新が高値圏なら ~100、安値圏なら ~0", () => {
			// 末尾20本に窓。最新 close=最大 → range_pct 高い。
			const up = computeDailyIndicators(series([10, 11, 12, 13, 14, 15]));
			expect(up?.range_pct).toBeGreaterThan(80);
			const down = computeDailyIndicators(series([15, 14, 13, 12, 11, 10]));
			expect(down?.range_pct).toBeLessThan(20);
		});

		it("range は直近20本に窓を絞る (古い極値は無視)", () => {
			// 先頭に飛び値 100 を置いても、末尾20本に入らなければ range_high に効かない。
			const closes = [100, ...Array.from({ length: 25 }, (_, i) => 10 + i)];
			const out = computeDailyIndicators(series(closes));
			// 末尾20本の最大は 34 (=10+24) + spread1 = 35。100 は窓外。
			expect(out?.range_high_20d).toBe(35);
		});

		it("vol_x_20d: 最新出来高が平均の2倍なら ~2.0", () => {
			const vols = [...Array(19).fill(1000), 2000];
			const closes = Array.from({ length: 20 }, (_, i) => 10 + i);
			const out = computeDailyIndicators(series(closes, { volume: vols }));
			// 平均 = (19*1000 + 2000)/20 = 1050。2000/1050 = 1.904... → floor1 = 1.9
			expect(out?.vol_x_20d).toBe(1.9);
		});

		it("rsi_14: 単調上昇は loss=0 で 100", () => {
			const out = computeDailyIndicators(
				series(Array.from({ length: 20 }, (_, i) => 10 + i)),
			);
			expect(out?.rsi_14).toBe(100);
		});

		it("rsi_14: 単調下落は gain=0 で 0", () => {
			const out = computeDailyIndicators(
				series(Array.from({ length: 20 }, (_, i) => 40 - i)),
			);
			expect(out?.rsi_14).toBe(0);
		});

		it("rsi_14: 15本未満 (close14本) では null", () => {
			const out = computeDailyIndicators(
				series(Array.from({ length: 14 }, (_, i) => 10 + i)),
			);
			expect(out?.rsi_14).toBeNull();
		});

		it("atr_pct: 一定 spread の系列で TR が安定し atr_pct が出る", () => {
			// spread=2 → high-low=4 が毎日。close~10台。atr_pct = 4/close*100 前後。
			const out = computeDailyIndicators(
				series(
					Array.from({ length: 30 }, () => 100),
					{ spread: 2 },
				),
			);
			// TR=4 (high-low), close=100 → atr_pct = 4/100*100 = 4.0
			expect(out?.atr_pct).toBe(4);
		});

		it("atr baseline: 系列が短い (過去5本未満) と baseline は null", () => {
			// 20本 → atr_pct 系列は 20-14 = 6本程度。最新除くと5本 → ちょうど境界。15本なら baseline null。
			const out = computeDailyIndicators(
				series(
					Array.from({ length: 16 }, () => 100),
					{ spread: 2 },
				),
			);
			expect(out?.atr_pct_baseline).toBeNull();
		});

		it("入力配列を破壊しない / 降順入力も吸収する", () => {
			const descInput = series(Array.from({ length: 20 }, (_, i) => 10 + i))
				.slice()
				.reverse();
			const snapshot = JSON.stringify(descInput);
			const out = computeDailyIndicators(descInput);
			expect(JSON.stringify(descInput)).toBe(snapshot);
			// 降順入力でも昇順正規化して同じ結果になる (range_pct 高い = 最新が高値)
			expect(out?.range_pct).toBeGreaterThan(80);
		});

		it("vol_pctile_60d: 最新が最大出来高なら 100、最小なら低い", () => {
			const closes = Array.from({ length: 30 }, (_, i) => 10 + i);
			const top = computeDailyIndicators(
				series(closes, { volume: [...Array(29).fill(1000), 9999] }),
			);
			expect(top?.vol_pctile_60d).toBe(100); // 最新が全体で最大 → 全本が <= 自分
			const bottom = computeDailyIndicators(
				series(closes, { volume: [...Array(29).fill(1000), 1] }),
			);
			// 最新=1 のみが自分以下 → 1/30 = 3.3% → floor 3
			expect(bottom?.vol_pctile_60d as number).toBeLessThan(10);
		});

		it("move_per_vol: changePct/vol_x。薄い出来 (vol_x<1) で上げると大きくなる", () => {
			const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
			const rows = series(closes, {
				volume: [...Array(19).fill(2000), 1000], // 最新だけ平均の約半分 → vol_x ~0.5
			});
			// 最新日の changePct を +12 に手で付与 (series は changePct を作らないため)
			rows[rows.length - 1].changePct = 12;
			const out = computeDailyIndicators(rows);
			// vol_x ~ 1000/avg。avg=(19*2000+1000)/20=1950 → vol_x=0.51。12/0.51 ≈ 23.5
			expect(out?.move_per_vol as number).toBeGreaterThan(15);
		});

		it("obv_trend / ad_trend: 単調上昇 (高値引け) は rising", () => {
			// close を high 寄りに置く: high=close+0.1, low=close-2 で money flow multiplier > 0。
			const closes = Array.from({ length: 30 }, (_, i) => 10 + i);
			const rows = closes.map((c, i) => ({
				date: `2026-01-${String(i + 1).padStart(2, "0")}`,
				high: c + 0.1,
				low: c - 2,
				close: c,
				volume: 1000,
			}));
			const out = computeDailyIndicators(rows);
			expect(out?.obv_trend).toBe("rising"); // 連日上げ → OBV 累積増
			expect(out?.ad_trend).toBe("rising"); // 高値引け → A/D 累積増
		});

		it("cmf_20d: 高値引け継続はプラス、安値引け継続はマイナス", () => {
			const closes = Array.from({ length: 25 }, () => 100);
			const high = closes.map((c, i) => ({
				date: `2026-01-${String(i + 1).padStart(2, "0")}`,
				high: c + 0.1, // 高値引け寄り
				low: c - 4,
				close: c,
				volume: 1000,
			}));
			expect(computeDailyIndicators(high)?.cmf_20d as number).toBeGreaterThan(
				0,
			);
			const low = closes.map((c, i) => ({
				date: `2026-01-${String(i + 1).padStart(2, "0")}`,
				high: c + 4,
				low: c - 0.1, // 安値引け寄り
				close: c,
				volume: 1000,
			}));
			expect(computeDailyIndicators(low)?.cmf_20d as number).toBeLessThan(0);
		});

		describe("volume_quality", () => {
			// 上げ+出来薄を作る土台: 高値引けで連日上昇、最新日だけ出来高を平均より絞り changePct を付与。
			const upThin = (
				lows: number[], // 各日の low (close との差で money flow / cmf の符号を作る)
				latestVolume: number,
			): DailyRow[] => {
				const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
				const rows: DailyRow[] = closes.map((c, i) => ({
					date: `2026-01-${String(i + 1).padStart(2, "0")}`,
					high: c + 0.1,
					low: c - lows[i % lows.length],
					close: c,
					volume: i === closes.length - 1 ? latestVolume : 2000,
				}));
				rows[rows.length - 1].changePct = 3; // 上げ
				return rows;
			};

			it("売り物枯渇+資金流入 (高値引け・薄商い) は accumulation", () => {
				// 最新出来高を極端に絞る → vol_x<1 かつ vol_pctile 低い。高値引け継続で OBV/AD rising・CMF+。
				const out = computeDailyIndicators(upThin([3], 200));
				expect(out?.volume_quality).toBe("accumulation");
			});

			it("上げでも出来高十分 (vol_x>=1) なら na", () => {
				const out = computeDailyIndicators(upThin([3], 5000));
				expect(out?.volume_quality).toBe("na");
			});

			it("下げ日は na", () => {
				const rows = upThin([3], 200);
				rows[rows.length - 1].changePct = -3;
				expect(computeDailyIndicators(rows)?.volume_quality).toBe("na");
			});

			it("changePct/vol_x の素材が無ければ null", () => {
				// series ヘルパは changePct を付けない → chgPct null。
				const out = computeDailyIndicators(
					series(Array.from({ length: 30 }, (_, i) => 100 + i)),
				);
				expect(out?.volume_quality).toBeNull();
			});
		});

		describe("momentum_state", () => {
			it("高値圏+出来薄 (最新出来高が平均未満) は cracking", () => {
				const closes = Array.from({ length: 25 }, (_, i) => 10 + i); // 単調上昇=高値圏
				const out = computeDailyIndicators(
					series(closes, { volume: [...Array(24).fill(2000), 500] }), // 最新を絞る
				);
				expect(out?.range_pct as number).toBeGreaterThanOrEqual(80);
				expect(out?.momentum_state).toBe("cracking");
			});

			it("高値圏+出来高十分は extended", () => {
				const closes = Array.from({ length: 25 }, (_, i) => 10 + i);
				const out = computeDailyIndicators(
					series(closes, { volume: [...Array(24).fill(2000), 6000] }), // 最新が平均超
				);
				expect(out?.momentum_state).toBe("extended");
			});

			it("高値圏でなければ na", () => {
				const closes = Array.from({ length: 25 }, (_, i) => 40 - i); // 単調下降=安値圏
				expect(computeDailyIndicators(series(closes))?.momentum_state).toBe(
					"na",
				);
			});
		});
	});

	describe("withMovingAverages", () => {
		// date DESC (新しい順) の終値列を作る。close=1..N で新しいものほど大きい。
		const rowsDesc = (n: number) =>
			Array.from({ length: n }, (_, i) => ({
				date: `d${n - i}`,
				close: n - i,
			}));

		it("ma5 は直近5日の終値平均、満たない最古日は null", () => {
			const out = withMovingAverages(rowsDesc(6), 6);
			expect(out[0].ma5).toBe(4); // 最新 close=6: (2+3+4+5+6)/5
			expect(out[1].ma5).toBe(3);
			expect(out[out.length - 1].ma5).toBeNull();
		});

		it("25日に満たないと ma25 は全行 null", () => {
			const out = withMovingAverages(rowsDesc(10), 10);
			expect(out.every((r) => r.ma25 === null)).toBe(true);
		});

		it("ma25 は 25 日揃った日から算出される", () => {
			const out = withMovingAverages(rowsDesc(30), 30);
			expect(out[0].ma25).not.toBeNull();
			expect(out[out.length - 1].ma25).toBeNull();
		});

		it("新しい順を保ち、要求件数 n に切り詰める", () => {
			const out = withMovingAverages(rowsDesc(30), 5);
			expect(out).toHaveLength(5);
			expect(out[0].close).toBe(30);
			expect(out[4].close).toBe(26);
		});

		it("入力配列を破壊しない", () => {
			const input = rowsDesc(3);
			const snapshot = JSON.stringify(input);
			withMovingAverages(input, 3);
			expect(JSON.stringify(input)).toBe(snapshot);
		});
	});

	describe("maDevPct", () => {
		it("close>ma は正、close<ma は負、floor1 で丸める", () => {
			expect(maDevPct(110, 100)).toBe(10); // (110-100)/100*100 = 10.0
			expect(maDevPct(95, 100)).toBe(-5); // -5.0
			// floor 方向: 103.7/100... → 3.7、負は下方向に floor
			expect(maDevPct(1037, 1000)).toBe(3.7);
		});
		it("ma が null / 0 以下なら null", () => {
			expect(maDevPct(100, null)).toBeNull();
			expect(maDevPct(100, 0)).toBeNull();
		});
	});
}
