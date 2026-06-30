// ユーザー保有ポジションを slack-reply 用に整形する純粋関数。
//
// 設計: signal-judge / crash-scenario は汎用判定のまま据え置き、ポジションは slack-reply だけが
// 読む。/thread-context が positions テーブルの当該銘柄行 + 参照現値を渡し、ここで「平均建値からの
// 含み損益%」を決定論的に計算して返す。判断 (利確/損切り/ホールド) は LLM に委ね、ここは数値整形に
// 徹する (judge-context.ts と同じ流儀)。
//
// 含み損益の符号は side で決まる:
//   long  (買い建て): (price - avg) / avg
//   short (売り建て): (avg - price) / avg   ← 下がると益
// 現値が無い (場が開く前で prices 未取得 等) ときは pnl_pct=null で行だけ返す。

// positions テーブルの 1 行 (routes が select したもの)。
export interface PositionRow {
	account: string; // cash | margin
	side: string; // long | short
	avgPrice: number; // 平均建値
	qty: number; // 株数
}

interface PositionView {
	account: string;
	side: string;
	avg_price: number;
	qty: number;
	pnl_pct: number | null; // 含み損益% (現値が無ければ null)
}

// (x*10|floor)/10 相当だが含み損益は四捨五入で十分 (judge-context の floor1 は WoW 差分用)。
function round1(x: number): number {
	return Math.round(x * 10) / 10;
}

// 1 行分の含み損益%。avg<=0 や price 無しは null。
// /me (slack-command.ts) も全建玉の含み損益表示に使うので export する。
export function pnlPct(
	side: string,
	avgPrice: number,
	price: number | null | undefined,
): number | null {
	if (price == null || !Number.isFinite(price)) return null;
	if (!Number.isFinite(avgPrice) || avgPrice <= 0) return null;
	const raw =
		side === "short"
			? (avgPrice - price) / avgPrice
			: (price - avgPrice) / avgPrice;
	return round1(raw * 100);
}

// 1 建玉の含み損益額 (円)。建値・株数・現値が揃わなければ null。
// long は (price - avg)*qty、short は (avg - price)*qty (下がると益)。1 円単位に丸める。
// /me (slack-command.ts) が金額表示に使うので export する。
export function pnlAmount(
	side: string,
	avgPrice: number,
	qty: number,
	price: number | null | undefined,
): number | null {
	if (price == null || !Number.isFinite(price)) return null;
	if (!Number.isFinite(avgPrice) || avgPrice <= 0) return null;
	if (!Number.isFinite(qty) || qty <= 0) return null;
	const diff = side === "short" ? avgPrice - price : price - avgPrice;
	return Math.round(diff * qty);
}

// /trade の約定反映 (純粋関数)。既存建玉 (なければ null) に約定を加減して新しい建玉を返す。
//   add    (増し)   : 平均建値 = (旧建値×旧株数 + 約定単価×約定株数)/(旧株数+約定株数)、株数 += 約定株数。
//                     既存なしなら約定単価をそのまま平均建値にした新規建玉。
//   reduce (減らし) : 平均建値は据え置き (移動平均法の手仕舞い)、株数 -= 約定株数。
//                     0 株になれば qty:0 を返す (routes が行削除)。
// 戻り値: 成功は {ok:true, avgPrice, qty}、検証エラーは {ok:false, reason}。
// reason: "no_position" (減らす建玉がない) / "over_reduce" (保有を超える減らし) / "bad_input" (約定が不正)。
export type TradeAction = "add" | "reduce";
export type TradeResult =
	| { ok: true; avgPrice: number; qty: number }
	| { ok: false; reason: "no_position" | "over_reduce" | "bad_input" };

export function applyTrade(
	current: { avgPrice: number; qty: number } | null,
	action: TradeAction,
	execPrice: number,
	execQty: number,
): TradeResult {
	if (!Number.isFinite(execPrice) || execPrice <= 0)
		return { ok: false, reason: "bad_input" };
	if (!Number.isInteger(execQty) || execQty <= 0)
		return { ok: false, reason: "bad_input" };

	const curQty = current?.qty ?? 0;
	const curAvg = current?.avgPrice ?? 0;

	if (action === "add") {
		const qty = curQty + execQty;
		// 新規 (curQty=0) は約定単価がそのまま平均建値になる。
		const avgPrice = round1((curAvg * curQty + execPrice * execQty) / qty);
		return { ok: true, avgPrice, qty };
	}

	// reduce: 減らす建玉が無い / 保有を超える減らしは弾く。
	if (curQty <= 0) return { ok: false, reason: "no_position" };
	if (execQty > curQty) return { ok: false, reason: "over_reduce" };
	// 平均建値は据え置き。全数なら qty:0 (行削除は routes 側)。
	return { ok: true, avgPrice: curAvg, qty: curQty - execQty };
}

// positions ブロックを組む。行が無ければ status: "none" (= ユーザー未登録)。
// price は判定対象の参照現値 (直近 close か live 現値)。各行に含み損益%を載せる。
export function buildPositions(
	rows: PositionRow[],
	price: number | null | undefined,
): Record<string, unknown> {
	if (!rows || rows.length === 0) return { status: "none" };
	return {
		status: "ok",
		ref_price: price ?? null,
		positions: rows.map(
			(r): PositionView => ({
				account: r.account,
				side: r.side,
				avg_price: r.avgPrice,
				qty: r.qty,
				pnl_pct: pnlPct(r.side, r.avgPrice, price),
			}),
		),
	};
}

// in-source tests。
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("pnlPct", () => {
		it("long は上昇で益", () => {
			expect(pnlPct("long", 1000, 1100)).toBe(10);
		});
		it("long は下落で損", () => {
			expect(pnlPct("long", 1000, 900)).toBe(-10);
		});
		it("short は下落で益", () => {
			expect(pnlPct("short", 1000, 900)).toBe(10);
		});
		it("short は上昇で損", () => {
			expect(pnlPct("short", 1000, 1100)).toBe(-10);
		});
		it("現値なしは null", () => {
			expect(pnlPct("long", 1000, null)).toBeNull();
			expect(pnlPct("long", 1000, undefined)).toBeNull();
		});
		it("avg<=0 は null (0除算回避)", () => {
			expect(pnlPct("long", 0, 100)).toBeNull();
		});
		it("avg<0 も null (負の建値はあり得ないが防御)", () => {
			expect(pnlPct("long", -100, 100)).toBeNull();
		});
		it("price が非有限 (NaN/Infinity) は null", () => {
			expect(pnlPct("long", 1000, Number.NaN)).toBeNull();
			expect(pnlPct("long", 1000, Number.POSITIVE_INFINITY)).toBeNull();
			expect(pnlPct("long", 1000, Number.NEGATIVE_INFINITY)).toBeNull();
		});
		it("avg が非有限 (NaN/Infinity) は null", () => {
			expect(pnlPct("long", Number.NaN, 1000)).toBeNull();
			expect(pnlPct("long", Number.POSITIVE_INFINITY, 1000)).toBeNull();
		});
		it("price=0 は long で -100%、short で +100%", () => {
			expect(pnlPct("long", 1000, 0)).toBe(-100);
			expect(pnlPct("short", 1000, 0)).toBe(100);
		});
		it("側名は short 以外すべて long 扱い (空文字・未知値)", () => {
			expect(pnlPct("", 1000, 1100)).toBe(10);
			expect(pnlPct("buy", 1000, 1100)).toBe(10);
		});
	});

	describe("pnlAmount", () => {
		it("long は値幅 × 株数", () => {
			expect(pnlAmount("long", 1000, 100, 1100)).toBe(10000);
			expect(pnlAmount("long", 1000, 100, 900)).toBe(-10000);
		});
		it("short は下落で益", () => {
			expect(pnlAmount("short", 1000, 100, 900)).toBe(10000);
			expect(pnlAmount("short", 1000, 100, 1100)).toBe(-10000);
		});
		it("現値なしは null", () => {
			expect(pnlAmount("long", 1000, 100, null)).toBeNull();
			expect(pnlAmount("long", 1000, 100, undefined)).toBeNull();
		});
		it("avg<=0 / qty<=0 は null", () => {
			expect(pnlAmount("long", 0, 100, 1100)).toBeNull();
			expect(pnlAmount("long", 1000, 0, 1100)).toBeNull();
		});
		it("非有限は null", () => {
			expect(pnlAmount("long", 1000, 100, Number.NaN)).toBeNull();
			expect(pnlAmount("long", Number.NaN, 100, 1100)).toBeNull();
			expect(pnlAmount("long", 1000, Number.NaN, 1100)).toBeNull();
		});
		it("1 円単位に丸める", () => {
			expect(pnlAmount("long", 1000.4, 3, 1001.1)).toBe(2);
		});
	});

	describe("applyTrade", () => {
		it("add: 既存に買い増しすると加重平均建値・合算株数になる", () => {
			expect(
				applyTrade({ avgPrice: 1000, qty: 200 }, "add", 1010, 100),
			).toEqual({ ok: true, avgPrice: 1003.3, qty: 300 });
		});
		it("add: 既存なしは約定単価がそのまま平均建値の新規建玉", () => {
			expect(applyTrade(null, "add", 1500, 100)).toEqual({
				ok: true,
				avgPrice: 1500,
				qty: 100,
			});
		});
		it("reduce: 平均建値据え置きで株数だけ減る", () => {
			expect(
				applyTrade({ avgPrice: 1000, qty: 300 }, "reduce", 1100, 100),
			).toEqual({ ok: true, avgPrice: 1000, qty: 200 });
		});
		it("reduce: 全数決済は qty:0 (行削除は routes 側)", () => {
			expect(
				applyTrade({ avgPrice: 1000, qty: 100 }, "reduce", 1100, 100),
			).toEqual({ ok: true, avgPrice: 1000, qty: 0 });
		});
		it("reduce: 建玉が無ければ no_position", () => {
			expect(applyTrade(null, "reduce", 1100, 100)).toEqual({
				ok: false,
				reason: "no_position",
			});
		});
		it("reduce: 保有を超える減らしは over_reduce", () => {
			expect(
				applyTrade({ avgPrice: 1000, qty: 100 }, "reduce", 1100, 200),
			).toEqual({ ok: false, reason: "over_reduce" });
		});
		it("約定単価・株数が不正なら bad_input", () => {
			expect(applyTrade(null, "add", 0, 100).ok).toBe(false);
			expect(applyTrade(null, "add", -1, 100).ok).toBe(false);
			expect(applyTrade(null, "add", 1000, 0).ok).toBe(false);
			expect(applyTrade(null, "add", 1000, 1.5).ok).toBe(false);
			expect(applyTrade(null, "add", 1000, Number.NaN).ok).toBe(false);
		});
	});

	describe("round1", () => {
		it("小数第1位で四捨五入する", () => {
			expect(round1(10.04)).toBe(10);
			expect(round1(10.05)).toBe(10.1);
			expect(round1(10.15)).toBe(10.2);
		});
		it("負数も四捨五入する (Math.round は +∞ 方向丸めなので -10.05→-10.0)", () => {
			expect(round1(-10.04)).toBe(-10);
			expect(round1(-10.05)).toBe(-10);
			expect(round1(-10.06)).toBe(-10.1);
		});
		it("0 と整数はそのまま", () => {
			expect(round1(0)).toBe(0);
			expect(round1(42)).toBe(42);
		});
	});

	describe("buildPositions", () => {
		it("行なしは none", () => {
			expect(buildPositions([], 1000)).toEqual({ status: "none" });
		});
		it("複数口座を含み損益つきで返す", () => {
			const out = buildPositions(
				[
					{ account: "cash", side: "long", avgPrice: 1000, qty: 100 },
					{ account: "margin", side: "short", avgPrice: 1200, qty: 50 },
				],
				1100,
			);
			expect(out.status).toBe("ok");
			expect(out.ref_price).toBe(1100);
			const ps = out.positions as PositionView[];
			expect(ps[0].pnl_pct).toBe(10); // long 1000→1100
			expect(ps[1].pnl_pct).toBe(round1(((1200 - 1100) / 1200) * 100)); // short
		});
		it("現値なしは pnl_pct=null だが行は返す", () => {
			const out = buildPositions(
				[{ account: "cash", side: "long", avgPrice: 1000, qty: 100 }],
				null,
			);
			const ps = out.positions as PositionView[];
			expect(ps[0].pnl_pct).toBeNull();
			expect(out.ref_price).toBeNull();
		});
	});
}
