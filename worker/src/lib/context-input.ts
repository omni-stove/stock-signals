// context-input ルートの純粋ロジック。ルート (routes/context-input.ts) は D1/R2 を引いて
// これらを呼ぶだけにし、テストはここに同伴させる。

import type { PullRow } from "./articles";

// rows (fetched_at ASC) の最大 fetched_at。0 件なら現行カーソルを据え置く。
export function nextCursor(
	rows: PullRow[],
	current: string | null,
): string | null {
	if (rows.length === 0) return current;
	return rows.reduce(
		(max, r) => (r.fetched_at > max ? r.fetched_at : max),
		rows[0].fetched_at,
	);
}

// in-source tests (vitest.config.ts 参照)
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	// nextCursor は fetched_at しか見ないので、テストは最小形で渡す。
	const row = (fetched_at: string) => ({ fetched_at }) as PullRow;

	describe("nextCursor", () => {
		it("0 件なら現行カーソルを据え置く (null も維持)", () => {
			expect(nextCursor([], "2026-06-01T00:00:00Z")).toBe(
				"2026-06-01T00:00:00Z",
			);
			expect(nextCursor([], null)).toBeNull();
		});

		it("行の最大 fetched_at を返す (入力順に依存しない)", () => {
			const rows = [
				row("2026-06-01T00:00:00Z"),
				row("2026-06-03T00:00:00Z"),
				row("2026-06-02T00:00:00Z"),
			];
			expect(nextCursor(rows, null)).toBe("2026-06-03T00:00:00Z");
		});

		it("現行カーソルより新しい行があれば前進する", () => {
			const rows = [row("2026-06-05T00:00:00Z")];
			expect(nextCursor(rows, "2026-06-01T00:00:00Z")).toBe(
				"2026-06-05T00:00:00Z",
			);
		});

		it("1 件ならその値", () => {
			expect(nextCursor([row("2026-06-02T00:00:00Z")], null)).toBe(
				"2026-06-02T00:00:00Z",
			);
		});
	});
}
