// ユーザーの好み・特記事項を slack-reply 用に整形する純粋関数。
//
// 設計: signal-judge / crash-scenario は汎用判定のまま据え置き、プロフィールは positions と同じく
// slack-reply だけが読む。/thread-context が user_profiles の当該ユーザー行を渡し、ここで Slack へ
// 返す形に整える。判断 (この好みをどう効かせるか) は LLM に委ね、ここは整形に徹する。

// user_profiles テーブルの 1 行 (routes が select したもの)。全フィールド任意。
export interface ProfileRow {
	riskTolerance: string | null;
	holdStyle: string | null;
	maxPositionPct: number | null;
	cashBalance: number | null; // 投資余力 (現金残高、円)。任意
	note: string | null;
}

// profile ブロックを組む。登録が無い (row=null) か全フィールド空なら status: "none"。
export function buildProfile(
	row: ProfileRow | null | undefined,
): Record<string, unknown> {
	if (!row) return { status: "none" };
	const hasAny =
		row.riskTolerance != null ||
		row.holdStyle != null ||
		row.maxPositionPct != null ||
		row.cashBalance != null ||
		(row.note != null && row.note !== "");
	if (!hasAny) return { status: "none" };
	return {
		status: "ok",
		risk_tolerance: row.riskTolerance ?? null,
		hold_style: row.holdStyle ?? null,
		max_position_pct: row.maxPositionPct ?? null,
		cash_balance: row.cashBalance ?? null,
		note: row.note ?? null,
	};
}

// in-source tests。
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("buildProfile", () => {
		it("row なしは none", () => {
			expect(buildProfile(null)).toEqual({ status: "none" });
			expect(buildProfile(undefined)).toEqual({ status: "none" });
		});
		it("全フィールド空も none", () => {
			expect(
				buildProfile({
					riskTolerance: null,
					holdStyle: null,
					maxPositionPct: null,
					cashBalance: null,
					note: null,
				}),
			).toEqual({ status: "none" });
			expect(
				buildProfile({
					riskTolerance: null,
					holdStyle: null,
					maxPositionPct: null,
					cashBalance: null,
					note: "",
				}),
			).toEqual({ status: "none" });
		});
		it("一部でも埋まっていれば ok で全フィールドを返す", () => {
			expect(
				buildProfile({
					riskTolerance: "high",
					holdStyle: "swing",
					maxPositionPct: 20,
					cashBalance: 1000000,
					note: "玉は分割で建てる",
				}),
			).toEqual({
				status: "ok",
				risk_tolerance: "high",
				hold_style: "swing",
				max_position_pct: 20,
				cash_balance: 1000000,
				note: "玉は分割で建てる",
			});
		});
		it("note だけでも ok", () => {
			expect(
				buildProfile({
					riskTolerance: null,
					holdStyle: null,
					maxPositionPct: null,
					cashBalance: null,
					note: "決算跨ぎは持たない",
				}),
			).toEqual({
				status: "ok",
				risk_tolerance: null,
				hold_style: null,
				max_position_pct: null,
				cash_balance: null,
				note: "決算跨ぎは持たない",
			});
		});
		it("現金残高だけでも ok", () => {
			expect(
				buildProfile({
					riskTolerance: null,
					holdStyle: null,
					maxPositionPct: null,
					cashBalance: 500000,
					note: null,
				}),
			).toEqual({
				status: "ok",
				risk_tolerance: null,
				hold_style: null,
				max_position_pct: null,
				cash_balance: 500000,
				note: null,
			});
		});
	});
}
