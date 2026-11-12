// judge-context 用: 株の供給が増えるイベント (売出し・公募・第三者割当・CB・分売・自己株処分・
// 大株主の異動・ロックアップ) を、適時開示・公式 IR の見出しから拾って並べる。
// 見出しの分類だけを決定論で行い、条件 (株数・ロックアップの期間と起点) は開示本文が一次情報。
// EDINET の大量保有報告書・変更報告書 (large-holdings.ts で絞ったもの) も同じ items に並べる。

import { holdingItems, type LargeHoldingRow } from "./large-holdings";

export interface SupplyArticle {
	date: string; // 発表日 YYYY-MM-DD
	title: string;
}

const KINDS: { kind: string; re: RegExp }[] = [
	{ kind: "secondary_offering", re: /売出し|売出/ },
	{ kind: "public_offering", re: /公募|新株式発行|募集株式/ },
	{ kind: "third_party_allotment", re: /第三者割当/ },
	{ kind: "convertible_bond", re: /新株予約権付社債|転換社債/ },
	{ kind: "warrant", re: /行使価額修正|新株予約権の(発行|行使|大量行使)/ },
	{ kind: "distribution", re: /立会外分売/ },
	{ kind: "treasury_disposal", re: /自己株式の処分/ },
	{ kind: "major_holder_change", re: /主要株主|親会社|その他の関係会社/ },
	{ kind: "lockup", re: /ロックアップ/ },
];
// 役員・従業員向けの株式報酬は需給に効く規模にならないので除く。
const EXCLUDE_RE = /譲渡制限|株式報酬|株式ユニット|ストック・?オプション|RSU/;
// ロックアップが付くのは売出し・公募・第三者割当。期間の目安 (発表日起点) を添える。
const LOCKUP_KINDS = new Set([
	"secondary_offering",
	"public_offering",
	"third_party_allotment",
]);
const LOOKBACK_DAYS = 400;

function addDays(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
	return Math.round(
		(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
			86400_000,
	);
}

function classifySupply(title: string): string | null {
	if (EXCLUDE_RE.test(title)) return null;
	return KINDS.find((k) => k.re.test(title))?.kind ?? null;
}

export function buildSupply(
	articles: SupplyArticle[],
	today: string,
	holdings: LargeHoldingRow[] = [],
): Record<string, unknown> {
	const since = addDays(today, -LOOKBACK_DAYS);
	const seen = new Set<string>();
	const items = articles
		.filter((a) => a.date >= since && a.date <= today)
		// 英文の重複リリースは和文と同じ材料なので落とす。
		.filter((a) => /[^\x20-\x7e]/.test(a.title))
		.flatMap((a) => {
			const kind = classifySupply(a.title);
			const key = `${a.date}|${kind}`;
			if (!kind || seen.has(key)) return [];
			seen.add(key);
			return [
				{
					date: a.date,
					kind,
					title: a.title.slice(0, 60),
					days_since: daysBetween(a.date, today),
					...(LOCKUP_KINDS.has(kind)
						? {
								lockup_90d: addDays(a.date, 90),
								lockup_180d: addDays(a.date, 180),
							}
						: {}),
				},
			];
		});
	const merged = [...items, ...holdingItems(holdings, today)]
		.sort((a, b) => (String(a.date) < String(b.date) ? 1 : -1))
		.slice(0, 8);
	return merged.length > 0
		? { status: "ok", items: merged }
		: { status: "none" };
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("classifySupply", () => {
		it("供給イベントの種類を見出しから決める", () => {
			expect(classifySupply("株式の売出しに関するお知らせ")).toBe(
				"secondary_offering",
			);
			expect(classifySupply("新株式発行及び株式売出しに関するお知らせ")).toBe(
				"secondary_offering",
			);
			expect(classifySupply("第三者割当による新株式の発行")).toBe(
				"third_party_allotment",
			);
			expect(classifySupply("主要株主の異動に関するお知らせ")).toBe(
				"major_holder_change",
			);
			expect(classifySupply("自己株式の処分に関するお知らせ")).toBe(
				"treasury_disposal",
			);
		});
		it("株式報酬・無関係な見出しは null", () => {
			expect(
				classifySupply(
					"譲渡制限付株式報酬としての自己株式の処分に関するお知らせ",
				),
			).toBeNull();
			expect(classifySupply("業績予想の修正に関するお知らせ")).toBeNull();
		});
	});

	describe("buildSupply", () => {
		it("新しい順に並べ、売出し等にはロックアップの目安日を添える", () => {
			const out = buildSupply(
				[
					{ date: "2026-09-01", title: "株式の売出しに関するお知らせ" },
					{ date: "2026-09-01", title: "Notice of Secondary Offering" },
					{ date: "2026-10-01", title: "主要株主の異動に関するお知らせ" },
					{ date: "2024-01-01", title: "株式の売出しに関するお知らせ" },
				],
				"2026-11-11",
			);
			expect(out).toEqual({
				status: "ok",
				items: [
					{
						date: "2026-10-01",
						kind: "major_holder_change",
						title: "主要株主の異動に関するお知らせ",
						days_since: 41,
					},
					{
						date: "2026-09-01",
						kind: "secondary_offering",
						title: "株式の売出しに関するお知らせ",
						days_since: 71,
						lockup_90d: "2026-11-30",
						lockup_180d: "2027-02-28",
					},
				],
			});
		});
		it("大量保有の報告を日付順に混ぜる", () => {
			const out = buildSupply(
				[{ date: "2026-09-01", title: "株式の売出しに関するお知らせ" }],
				"2026-11-11",
				[
					{
						filer: "ファンドX",
						report_kind: "new",
						special: false,
						submit_date: "2026-11-05",
						ratio: 5.3,
						prev_ratio: null,
					},
				],
			);
			expect((out.items as { kind: string }[]).map((i) => i.kind)).toEqual([
				"large_holding_new",
				"secondary_offering",
			]);
		});
		it("該当なしは none", () => {
			expect(buildSupply([], "2026-11-11")).toEqual({ status: "none" });
		});
	});
}
