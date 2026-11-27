// 信用建玉の建値分布の推定と、追証ラインを新たに割った (踏み上げ側は抜けた) 建玉量の算出。
//
// 銘柄別の信用建玉の取得価額は公表されていないので、週次の信用残の増減と daily から推定する:
//   - 信用残が増えた週の増分は、その週 (前回集計日の翌日〜今回集計日) の VWAP で建ったとみなす。
//   - 減った週は全ロットを按分で減らす (利食いと損切りのどちらが先に出るかは読めないため中立に置く)。
//   - 最初の集計日にすでにある残高は、その直前 SEED_BARS 本の VWAP で建ったとみなす。
// VWAP は典型価格 (高+安+終)/3 の出来高加重。信用残は千株、出来高は株。

export interface MarginQtyRow {
	date: string; // 集計基準日 YYYY-MM-DD
	qty: number | null; // 買残 (long) または 売残 (short)。千株
}

export interface CostBar {
	date: string;
	high: number | null;
	low: number | null;
	close: number | null;
	volume: number | null;
}

export interface CostLot {
	cost: number; // 推定建値 (円)
	qty: number; // 千株
}

const SEED_BARS = 60;

function vwap(bars: CostBar[]): number | null {
	let pv = 0;
	let v = 0;
	for (const b of bars) {
		if (b.close == null || b.volume == null || b.volume <= 0) continue;
		const typical =
			b.high != null && b.low != null
				? (b.high + b.low + b.close) / 3
				: b.close;
		pv += typical * b.volume;
		v += b.volume;
	}
	return v > 0 ? pv / v : null;
}

/**
 * 信用残 (date ASC) と daily (date ASC) から、集計日ごとの増減を VWAP で積み上げた建値ロットを返す。
 * 最初の集計日の残高を据える VWAP が取れない (それ以前の daily が無い) ときは null。
 */
export function estimateCostLots(
	marginAsc: MarginQtyRow[],
	barsAsc: CostBar[],
): CostLot[] | null {
	const rows = marginAsc.filter((r) => r.qty != null) as {
		date: string;
		qty: number;
	}[];
	if (rows.length === 0) return null;
	const first = rows[0];
	const seed = vwap(
		barsAsc.filter((b) => b.date <= first.date).slice(-SEED_BARS),
	);
	if (seed == null) return null;
	let lots: CostLot[] = first.qty > 0 ? [{ cost: seed, qty: first.qty }] : [];
	for (let i = 1; i < rows.length; i++) {
		const prev = rows[i - 1];
		const cur = rows[i];
		const total = lots.reduce((s, l) => s + l.qty, 0);
		const delta = cur.qty - total;
		if (delta > 0) {
			const week = barsAsc.filter(
				(b) => b.date > prev.date && b.date <= cur.date,
			);
			// その週の足が欠けていれば、直前の足までの VWAP で代える (増分を捨てると残高と合わなくなる)。
			const cost =
				vwap(week) ?? vwap(barsAsc.filter((b) => b.date <= cur.date).slice(-5));
			if (cost != null) lots.push({ cost, qty: delta });
		} else if (delta < 0 && total > 0) {
			const keep = cur.qty / total;
			lots = lots.map((l) => ({ cost: l.cost, qty: l.qty * keep }));
		}
	}
	return lots.filter((l) => l.qty > 0);
}

/** ロットの数量加重の平均建値 (円)。ロットが無ければ null。 */
export function avgCost(lots: CostLot[]): number | null {
	const qty = lots.reduce((s, l) => s + l.qty, 0);
	if (qty <= 0) return null;
	return lots.reduce((s, l) => s + l.cost * l.qty, 0) / qty;
}

/**
 * `refPrice` から `close` までの値動きで追証ラインを新たに越えたロットの量 (千株) を返す。
 * 買い方 (long) は終値が建値の (1 - callLossPct%) を割ったロットのうち、`refPrice` ではまだ
 * 割っていなかったもの。売り方 (short) は建値の (1 + callLossPct%) で符号を逆にして同じ。
 */
export function newlyCalledQty(
	lots: CostLot[],
	side: "long" | "short",
	close: number,
	refPrice: number,
	callLossPct: number,
): number {
	const k = callLossPct / 100;
	let qty = 0;
	for (const l of lots) {
		const called =
			side === "long"
				? close < l.cost * (1 - k) && refPrice >= l.cost * (1 - k)
				: close > l.cost * (1 + k) && refPrice <= l.cost * (1 + k);
		if (called) qty += l.qty;
	}
	return qty;
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;
	const bar = (date: string, close: number, volume = 100): CostBar => ({
		date,
		high: close,
		low: close,
		close,
		volume,
	});

	describe("estimateCostLots", () => {
		it("初回残高は直前の VWAP、増分はその週の VWAP で積む", () => {
			const lots = estimateCostLots(
				[
					{ date: "2026-01-09", qty: 100 },
					{ date: "2026-01-16", qty: 150 },
				],
				[
					bar("2026-01-08", 1000),
					bar("2026-01-09", 1000),
					bar("2026-01-15", 1200),
				],
			);
			expect(lots).toEqual([
				{ cost: 1000, qty: 100 },
				{ cost: 1200, qty: 50 },
			]);
		});

		it("出来高加重: 出来高の多い日の価格に寄る", () => {
			const lots = estimateCostLots(
				[{ date: "2026-01-09", qty: 10 }],
				[bar("2026-01-08", 1000, 100), bar("2026-01-09", 2000, 300)],
			);
			expect(lots?.[0].cost).toBe(1750);
		});

		it("減った週は全ロットを按分で減らす", () => {
			const lots = estimateCostLots(
				[
					{ date: "2026-01-09", qty: 100 },
					{ date: "2026-01-16", qty: 200 },
					{ date: "2026-01-23", qty: 100 },
				],
				[
					bar("2026-01-09", 1000),
					bar("2026-01-15", 1200),
					bar("2026-01-22", 900),
				],
			);
			expect(lots).toEqual([
				{ cost: 1000, qty: 50 },
				{ cost: 1200, qty: 50 },
			]);
		});

		it("初回集計日以前の daily が無ければ null", () => {
			expect(
				estimateCostLots(
					[{ date: "2026-01-09", qty: 100 }],
					[bar("2026-01-15", 1000)],
				),
			).toBeNull();
		});
	});

	describe("avgCost", () => {
		it("数量で加重する", () => {
			expect(
				avgCost([
					{ cost: 1000, qty: 30 },
					{ cost: 2000, qty: 10 },
				]),
			).toBe(1250);
		});
		it("ロットが無ければ null", () => {
			expect(avgCost([])).toBeNull();
		});
	});

	describe("newlyCalledQty", () => {
		const lots: CostLot[] = [
			{ cost: 1000, qty: 30 },
			{ cost: 1200, qty: 50 },
			{ cost: 1500, qty: 20 },
		];
		it("long: 今回 10% 割れに入ったロットだけ数え、前から割れていたロットは除く", () => {
			// 終値 1000: 1200 (ライン 1080) と 1500 (ライン 1350) が割れ。基準 1100 では 1500 は既に割れていた
			expect(newlyCalledQty(lots, "long", 1000, 1100, 10)).toBe(50);
		});
		it("long: 下げた区間に建玉が無ければ 0", () => {
			// 1500 のロットは基準 1300 の時点で既にライン 1350 を割っていた
			expect(
				newlyCalledQty([{ cost: 1500, qty: 20 }], "long", 1000, 1300, 10),
			).toBe(0);
		});
		it("short: 建値の 10% 上を新たに抜けたロット", () => {
			// 終値 1200: 1000 (ライン 1100) を抜け。基準 1050 ではまだ抜けていない
			expect(newlyCalledQty(lots, "short", 1200, 1050, 10)).toBe(30);
		});
	});
}
