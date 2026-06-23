// テクニカル指標の決定論的な算出を 1 ヶ所に集約する純粋関数群。
//
// 設計の意図:
//   - これまで指標 (RSI14 / ATR14 系列 / 20日レンジ位置 / 出来高倍率 / MA乖離率) は
//     scripts/judge-context.sh の jq の中で計算していた。bash/jq に判断材料の算出ロジックが
//     埋もれると、forced-liquidation など別の読み手から再利用できず二重実装になる。
//     そこで算出を TS の純粋関数に集約し、judge-context.sh も forced-liquidation も
//     「同じ TS の計算結果を読むだけ」にできる土台にする。
//   - ここは D1 にも HTTP にも依存しない。入力は daily 行の配列 (date 昇順/降順どちらも吸収)。
//     in-source test (vitest.config.ts 参照) で judge-context.sh の jq と数値一致を保証する。
//   - **judge-context.sh の jq と完全に同じ丸め・同じ近似式**にすること。bash 側は jq の
//     `(x*10|floor)/10` 等で「小数第1位を切り捨て」、RSI は Wilder ではなく SMA 版、
//     ATR baseline は「最新を除いた過去 atr_pct 系列の (長さ/2 floor) 番目」を中央値とする。
//     この関数群を変えるときは judge-context.sh 側のテスト (judge-context.bats) と突き合わせる。

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

// 算出済み指標。judge-context.sh の daily ブロックと同じキー・同じ意味。
export interface DailyIndicators {
	range_high_20d: number | null;
	range_low_20d: number | null;
	range_pct: number | null; // 0=安値圏 100=高値圏 (整数。floor)
	vol_x_20d: number | null; // 最新 volume / 直近20日平均 volume (小数1桁)
	rsi_14: number | null; // SMA 版 RSI (整数。floor)
	atr_pct: number | null; // 最新の ATR14/close*100 (小数1桁)
	atr_pct_baseline: number | null; // 最新を除いた過去 atr_pct の中央値 (小数1桁)
	atr_vs_baseline: number | null; // atr_pct / baseline (小数2桁)
}

// jq の `(x * 10 | floor) / 10` = 小数第1位までを切り捨て (負値は floor なので下方向)。
function floor1(x: number): number {
	return Math.floor(x * 10) / 10;
}
// jq の `(x * 100 | floor) / 100` = 小数第2位までを切り捨て。
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
// judge-context.sh と同じく True Range = max(high-low, |high-prevClose|, |low-prevClose|)、
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
	// baseline: 最新を除いた過去系列を昇順 sort し、(length/2 floor) 番目を中央値とする (jq と同一)。
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
	return {
		range_high_20d: rv.range_high_20d,
		range_low_20d: rv.range_low_20d,
		range_pct: rv.range_pct,
		vol_x_20d: rv.vol_x_20d,
		rsi_14: rsi14(asc),
		atr_pct: at.atr_pct,
		atr_pct_baseline: at.atr_pct_baseline,
		atr_vs_baseline: at.atr_vs_baseline,
	};
}

// in-source tests (本番ビルドでは tree-shake される。vitest.config.ts 参照)。
// judge-context.sh の jq 計算と数値一致することを、合成系列で検証する。
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
