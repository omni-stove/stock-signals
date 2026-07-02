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

// 追証 (追加保証金) 判定。信用建玉が現値まで下落したときの委託保証金維持率を出す純粋関数。
//
// モデル (本人が保有する建玉だけで完結。証券会社の実残高は参照しない近似):
//   委託保証金 = 現金 (cashBalance)
//              + 現物建玉の代用評価額 (現値 × 掛目 SUBSTITUTE_HAIRCUT)   ← 現物も代用差入れとみなす
//              + 信用建玉の評価損益合計 (long は price-avg、short は avg-price、× 株数)
//   建代金     = 信用建玉の建代金 (avgPrice × qty) 合計
//   維持率     = 委託保証金 / 建代金
//   追証ライン = 維持率が MAINTENANCE_MIN を割る水準。委託保証金 - 建代金×MAINTENANCE_MIN が
//                「あと耐えられる評価損」。これが 0 以下なら既に追証。
// 信用建玉が無ければ判定対象なし (null)。現値が引けない建玉は評価損益・代用評価に算入しない。

const SUBSTITUTE_HAIRCUT = 0.8; // 代用有価証券の掛目 (現物評価額の 80% を保証金に算入)
export const MAINTENANCE_MIN = 0.2; // これを割ると追証 (委託保証金維持率 20%)

// 銘柄ごとの「あと株価がいくら動くと追証か」。委託保証金は現値に線形連動するので、
// その銘柄の全建玉 (現物代用 + 信用評価損益) の株価 1 円あたりの保証金感応度から逆算する。
interface MarginTrigger {
	ticker: string;
	price: number; // 現値
	drop: number; // 追証到達までの株価変化幅 (現値 - 追証株価。正なら「あとこれだけ下がると」)
	triggerPrice: number; // 追証に到達する株価
	dropPct: number; // drop / price × 100 (下落率%、四捨五入小数第1位)
}

export interface MarginCallView {
	maintenanceRate: number | null; // 現在の委託保証金維持率 (建代金 0 は null)
	deposit: number; // 委託保証金 (現金 + 代用評価 + 信用評価損益)
	marginNotional: number; // 信用建玉の建代金合計
	room: number; // あと耐えられる評価損 (deposit - 建代金×MAINTENANCE_MIN)。負なら既に追証
	inCall: boolean; // 現時点で追証発生中か (維持率 < MAINTENANCE_MIN)
	triggers: MarginTrigger[]; // 銘柄ごとの追証到達株価 (感応度が出せる銘柄のみ、drop 小さい順=近い順)
}

// 追証判定に使う 1 建玉 (現値つき)。account: cash|margin, side: long|short。
interface MarginCallInput {
	ticker: string;
	account: string;
	side: string;
	avgPrice: number;
	qty: number;
	price: number | null;
}

// 本人の全建玉 + 現金残高から委託保証金維持率と追証余力を算出する。
// 信用建玉が 1 つも無ければ null (追証の概念がない)。
export function computeMarginCall(
	positions: MarginCallInput[],
	cashBalance: number | null,
): MarginCallView | null {
	const margins = positions.filter((p) => p.account === "margin");
	if (margins.length === 0) return null;

	let marginNotional = 0; // 信用建代金 (avg×qty)
	let marginPnl = 0; // 信用評価損益 (現値がある建玉のみ)
	for (const p of margins) {
		if (!Number.isFinite(p.avgPrice) || p.avgPrice <= 0) continue;
		if (!Number.isFinite(p.qty) || p.qty <= 0) continue;
		marginNotional += p.avgPrice * p.qty;
		const amt = pnlAmount(p.side, p.avgPrice, p.qty, p.price);
		if (amt != null) marginPnl += amt;
	}
	if (marginNotional <= 0) return null;

	// 現物建玉の代用評価額 (現値 × 株数 × 掛目)。現値が引けない行は算入しない。
	let substitute = 0;
	for (const p of positions) {
		if (p.account !== "cash") continue;
		if (p.price == null || !Number.isFinite(p.price) || p.price <= 0) continue;
		if (!Number.isFinite(p.qty) || p.qty <= 0) continue;
		substitute += p.price * p.qty * SUBSTITUTE_HAIRCUT;
	}

	const deposit = (cashBalance ?? 0) + substitute + marginPnl;
	const maintenanceRate = deposit / marginNotional;
	const room = deposit - marginNotional * MAINTENANCE_MIN;

	// 銘柄ごとの「株価 1 円下落あたりの委託保証金の減少額」(感応度 slope) を集計する。
	//   現物 long : 現値が 1 円下がると代用評価が qty×掛目 だけ減る → slope += qty×掛目
	//   信用 long : 現値が 1 円下がると評価損が qty だけ増える     → slope += qty
	//   short     : 下落で益 (保証金が増える) なので slope は負。追証は「株価上昇で」到達する。
	// slope が正なら下落方向、負なら上昇方向に room 分動くと追証。drop = room / slope。
	const slopeByTicker = new Map<string, { price: number; slope: number }>();
	for (const p of positions) {
		if (p.price == null || !Number.isFinite(p.price) || p.price <= 0) continue;
		if (!Number.isFinite(p.qty) || p.qty <= 0) continue;
		let s = 0;
		if (p.account === "cash") {
			// 現物は代用差入れ (long のみ保証金に効く。現物 short は想定外なので無視)。
			if (p.side !== "short") s = p.qty * SUBSTITUTE_HAIRCUT;
		} else if (p.account === "margin") {
			s = p.side === "short" ? -p.qty : p.qty;
		}
		if (s === 0) continue;
		const cur = slopeByTicker.get(p.ticker) ?? { price: p.price, slope: 0 };
		cur.slope += s;
		slopeByTicker.set(p.ticker, cur);
	}

	const triggers: MarginTrigger[] = [];
	for (const [ticker, { price, slope }] of slopeByTicker) {
		if (slope === 0) continue; // 現物 short 等で相殺 (株価が動いても保証金不変)
		// 現時点で既に追証 (room<0) なら drop は負 (株価が戻る方向)。表示側でハンドリング。
		const drop = room / slope; // 追証株価までの株価変化幅 (slope>0 なら正=下落)
		const triggerPrice = price - drop;
		if (triggerPrice < 0) continue; // 株価 0 まで下げても追証に届かない (現金厚い) → 出さない
		triggers.push({
			ticker,
			price,
			drop: Math.round(drop),
			triggerPrice: Math.round(triggerPrice),
			dropPct: round1((drop / price) * 100),
		});
	}
	// 追証に近い順 (drop が小さい=わずかな変動で到達する銘柄を上に)。
	triggers.sort((a, b) => Math.abs(a.drop) - Math.abs(b.drop));

	return {
		maintenanceRate, // 比率のまま (表示側で %・丸め)
		deposit: Math.round(deposit),
		marginNotional: Math.round(marginNotional),
		room: Math.round(room),
		inCall: maintenanceRate < MAINTENANCE_MIN,
		triggers,
	};
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

	describe("computeMarginCall", () => {
		const P = (
			account: string,
			side: string,
			avgPrice: number,
			qty: number,
			price: number | null,
			ticker = "T",
		): MarginCallInput => ({ ticker, account, side, avgPrice, qty, price });

		it("信用建玉が無ければ null", () => {
			expect(
				computeMarginCall([P("cash", "long", 1000, 100, 1100)], 500000),
			).toBeNull();
			expect(computeMarginCall([], 500000)).toBeNull();
		});

		it("現金のみ: 維持率 = (現金 + 評価損益) / 建代金", () => {
			// 建代金 100万、現金 40万、評価損益 0 → deposit 40万、維持率 0.4
			const out = computeMarginCall(
				[P("margin", "long", 1000, 1000, 1000)],
				400000,
			);
			expect(out?.marginNotional).toBe(1_000_000);
			expect(out?.deposit).toBe(400_000);
			expect(out?.maintenanceRate).toBeCloseTo(0.4, 5);
			expect(out?.inCall).toBe(false);
			// room = 40万 - 100万×0.2 = 20万
			expect(out?.room).toBe(200_000);
		});

		it("評価損で維持率が下がり 20% 割れで追証", () => {
			// 建代金 100万 (建値1000×1000株)、現値 700 → 評価損 -30万、現金 40万 → deposit 10万
			// 維持率 0.1 (<0.2) → 追証。room = 10万 - 20万 = -10万
			const out = computeMarginCall(
				[P("margin", "long", 1000, 1000, 700)],
				400000,
			);
			expect(out?.maintenanceRate).toBeCloseTo(0.1, 5);
			expect(out?.inCall).toBe(true);
			expect(out?.room).toBe(-100_000);
		});

		it("現物を代用有価証券として掛目 80% で保証金に算入", () => {
			// 信用建代金 100万、現金 0、現物 現値1000×500株 → 代用 50万×0.8 = 40万 → deposit 40万
			const out = computeMarginCall(
				[
					P("margin", "long", 1000, 1000, 1000),
					P("cash", "long", 900, 500, 1000),
				],
				0,
			);
			expect(out?.deposit).toBe(400_000);
			expect(out?.maintenanceRate).toBeCloseTo(0.4, 5);
		});

		it("short 建玉は上昇で評価損 (deposit を削る)", () => {
			// 売り建 建値1000×1000株、現値1200 → 評価損 -20万、現金 40万 → deposit 20万、維持率 0.2
			const out = computeMarginCall(
				[P("margin", "short", 1000, 1000, 1200)],
				400000,
			);
			expect(out?.maintenanceRate).toBeCloseTo(0.2, 5);
			// ちょうど 0.2 は割っていない (< 判定なので false)
			expect(out?.inCall).toBe(false);
		});

		it("現値が引けない信用建玉は評価損益 0 (建代金には算入)", () => {
			const out = computeMarginCall(
				[P("margin", "long", 1000, 1000, null)],
				400000,
			);
			expect(out?.marginNotional).toBe(1_000_000);
			expect(out?.deposit).toBe(400_000); // 評価損益 0
		});

		it("現値が引けない現物は代用評価に算入しない", () => {
			const out = computeMarginCall(
				[
					P("margin", "long", 1000, 1000, 1000),
					P("cash", "long", 900, 500, null),
				],
				400000,
			);
			expect(out?.deposit).toBe(400_000); // 代用 0
		});

		it("cashBalance 未登録 (null) は現金 0 とみなす", () => {
			const out = computeMarginCall(
				[P("margin", "long", 1000, 1000, 1000)],
				null,
			);
			expect(out?.deposit).toBe(0);
			expect(out?.maintenanceRate).toBe(0);
			expect(out?.inCall).toBe(true);
		});

		describe("triggers (銘柄ごとの追証到達株価)", () => {
			it("信用 long 単独: room / qty だけ下がると追証", () => {
				// 建代金 100万 (建値1000×1000株)、現金 40万、現値 1000 → room 20万
				// slope = 1000 (信用 long qty)。drop = 20万/1000 = 200 → 追証株価 800
				const out = computeMarginCall(
					[P("margin", "long", 1000, 1000, 1000, "AAA")],
					400000,
				);
				expect(out?.triggers).toHaveLength(1);
				const t = out?.triggers[0];
				expect(t?.ticker).toBe("AAA");
				expect(t?.drop).toBe(200);
				expect(t?.triggerPrice).toBe(800);
				expect(t?.dropPct).toBe(20);
			});

			it("現物 + 信用が同一銘柄: 両建玉の感応度を合算 (掛目 0.8 含む)", () => {
				// キオクシア相当。現金 0。
				//   信用 long 91,910×400、現物 long 65,410×400、現値 77,010
				//   slope = 400 (信用) + 400×0.8 (現物代用) = 720
				//   建代金 = 91,910×400 = 36,764,000
				//   代用 = 77,010×400×0.8 = 24,643,200、信用評価損 = (77,010-91,910)×400 = -5,960,000
				//   deposit = 18,683,200、room = 18,683,200 - 36,764,000×0.2 = 11,330,400
				//   drop = 11,330,400 / 720 = 15,736.67 → 追証株価 77,010 - 15,736.67 = 61,273.33
				const out = computeMarginCall(
					[
						P("margin", "long", 91910, 400, 77010, "285A"),
						P("cash", "long", 65410, 400, 77010, "285A"),
					],
					0,
				);
				expect(out?.room).toBe(11_330_400);
				expect(out?.triggers).toHaveLength(1);
				const t = out?.triggers[0];
				expect(t?.ticker).toBe("285A");
				expect(t?.drop).toBe(15737);
				expect(t?.triggerPrice).toBe(61273);
				expect(t?.dropPct).toBe(round1((11_330_400 / 720 / 77010) * 100));
			});

			it("複数銘柄: 追証に近い順 (drop 小さい順) にソート", () => {
				// A: 信用 long 1000株、B: 信用 long 800株。現値=建値で評価損益0 → deposit=現金。
				// 建代金 = (1000+800)×1000 = 180万。現金40万 → room = 40万 - 180万×0.2 = 4万。
				// A drop = 4万/1000 = 40 (追証株価960)、B drop = 4万/800 = 50 (追証株価950)。
				// slope が大きい A の方が drop 小さい → A が先。両方 triggerPrice>0 で出る。
				const out = computeMarginCall(
					[
						P("margin", "long", 1000, 1000, 1000, "A"),
						P("margin", "long", 1000, 800, 1000, "B"),
					],
					400000,
				);
				const ts = out?.triggers ?? [];
				expect(ts.map((t) => t.ticker)).toEqual(["A", "B"]);
				expect(ts[0].drop).toBe(40);
				expect(ts[1].drop).toBe(50);
			});

			it("short 建玉は上昇で追証 (drop は負)", () => {
				// 売り建 建値1000×1000株、現値1000、現金40万 → deposit40万、room20万
				// slope = -1000 (short)。drop = 20万 / -1000 = -200 → 上昇で追証、追証株価1200
				const out = computeMarginCall(
					[P("margin", "short", 1000, 1000, 1000, "S")],
					400000,
				);
				const t = out?.triggers[0];
				expect(t?.drop).toBe(-200);
				expect(t?.triggerPrice).toBe(1200);
			});

			it("現金が厚く株価 0 でも追証に届かない銘柄は出さない", () => {
				// 信用 long 100株、現金 1000万 → room が建玉評価損の最大 (株価0で -10万) を超える
				const out = computeMarginCall(
					[P("margin", "long", 1000, 100, 1000, "R")],
					10_000_000,
				);
				expect(out?.triggers).toHaveLength(0);
			});

			it("現値が引けない銘柄は感応度を出せないので trigger なし", () => {
				const out = computeMarginCall(
					[P("margin", "long", 1000, 1000, null, "N")],
					400000,
				);
				expect(out?.triggers).toHaveLength(0);
			});
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
