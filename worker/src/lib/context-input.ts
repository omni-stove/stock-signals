// context-input ルートの純粋ロジック。ルート (routes/context-input.ts) は D1/R2 を引いて
// これらを呼ぶだけにし、テストはここに同伴させる。

import type { PullRow } from "./articles";
import { matchTickers } from "./watchlist";

// rows の最大 fetched_at。0 件なら現行カーソルを据え置く。
export function nextCursor(
	rows: { fetched_at: string }[],
	current: string | null,
): string | null {
	if (rows.length === 0) return current;
	return rows.reduce(
		// biome-ignore lint/complexity/useMathMinMax: compares ISO timestamp strings
		(max, r) => (r.fetched_at > max ? r.fetched_at : max),
		rows[0].fetched_at,
	);
}

// news_items の 1 行。ticker = 銘柄ページのニュース (articles)、market = 見出しが当該銘柄に当たる市場テーマニュース。
export type NewsItem = PullRow & { source: "ticker" | "market" };

// 1 系統ぶんの取得結果。rows は fetched_at ASC、full は D1 の limit で打ち切られたか (= 続きが残る)。
export interface NewsPull {
	rows: PullRow[];
	full: boolean;
}

// 銘柄ニュースと市場テーマニュースを 1 本の news カーソルで読むために混ぜる。
//   market は matchTickers(title) に code を含む行だけ残し、同じ URL が両方にあれば ticker を残す。
//   打ち切られた系統は最後の行より先が未読なので、両系統とも読み切った時刻 (bound) までに絞ってから
//   fetched_at ASC で limit 件に切る。next は返した行の最大 fetched_at だが、limit で切らずに bound が
//   あれば bound まで進める (market 側が全行不一致でもカーソルが止まらないように)。
export function mergeNews(
	code: string,
	ticker: NewsPull,
	market: NewsPull,
	current: string | null,
	limit: number,
): { items: NewsItem[]; next: string | null } {
	const bounds = [ticker, market]
		.filter((p) => p.full && p.rows.length > 0)
		.map((p) => nextCursor(p.rows, null) as string);
	const bound = bounds.length > 0 ? bounds.sort()[0] : null;

	const tickerUrls = new Set(ticker.rows.map((r) => r.url));
	const merged: NewsItem[] = [
		...ticker.rows.map((r) => ({ ...r, source: "ticker" as const })),
		...market.rows
			.filter(
				(r) =>
					!tickerUrls.has(r.url) && matchTickers(r.title).includes(code),
			)
			.map((r) => ({ ...r, source: "market" as const })),
	]
		.filter((r) => bound === null || r.fetched_at <= bound)
		.sort((a, b) =>
			a.fetched_at < b.fetched_at ? -1 : a.fetched_at > b.fetched_at ? 1 : 0,
		);

	const items = merged.slice(0, limit);
	if (merged.length > limit || bound === null)
		return { items, next: nextCursor(items, current) };
	return { items, next: bound };
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

	describe("mergeNews", () => {
		const POLICY = "米、対中半導体製造装置の輸出規制を拡大";
		const news = (url: string, title: string, day: number): PullRow => ({
			url,
			title,
			published_at: "2026-06-01",
			ir_category: null,
			fetched_at: `2026-06-${String(day).padStart(2, "0")}T00:00:00.000Z`,
			body: `${title} 本文`,
		});
		const pull = (rows: PullRow[], full = false): NewsPull => ({ rows, full });
		const at = (day: number) =>
			`2026-06-${String(day).padStart(2, "0")}T00:00:00.000Z`;

		it("当該銘柄に当たる市場ニュースを source=market で fetched_at 順に混ぜる", () => {
			const r = mergeNews(
				"6857",
				pull([
					news("t1", "アドバンテスト続伸", 1),
					news("t3", "アドバンテスト", 3),
				]),
				pull([news("m2", POLICY, 2)]),
				null,
				20,
			);
			expect(r.items.map((i) => [i.url, i.source])).toEqual([
				["t1", "ticker"],
				["m2", "market"],
				["t3", "ticker"],
			]);
			expect(r.items[1].body).toBe(`${POLICY} 本文`);
			expect(r.next).toBe(at(3));
		});

		it("当該銘柄に当たらない市場ニュースは混ぜない", () => {
			const r = mergeNews(
				"285A",
				pull([]),
				pull([news("m2", POLICY, 2)]),
				null,
				20,
			);
			expect(r.items).toEqual([]);
			expect(r.next).toBeNull();
		});

		it("市場ニュースだけでもカーソルが両方をまたいで進む", () => {
			const r = mergeNews(
				"6857",
				pull([]),
				pull([news("m5", POLICY, 5)]),
				at(1),
				20,
			);
			expect(r.items.map((i) => i.source)).toEqual(["market"]);
			expect(r.next).toBe(at(5));
		});

		it("同じ URL が両方にあれば銘柄ニュースだけ残す", () => {
			const r = mergeNews(
				"6857",
				pull([news("u", POLICY, 2)]),
				pull([news("u", POLICY, 2)]),
				null,
				20,
			);
			expect(r.items.map((i) => i.source)).toEqual(["ticker"]);
		});

		it("打ち切られた系統の最後の行より新しい行は次回に回す", () => {
			const r = mergeNews(
				"6857",
				pull(
					[news("t1", "アドバンテスト", 1), news("t2", "アドバンテスト", 2)],
					true,
				),
				pull([news("m3", POLICY, 3)]),
				null,
				2,
			);
			expect(r.items.map((i) => i.url)).toEqual(["t1", "t2"]);
			expect(r.next).toBe(at(2));
		});

		it("合算が limit を超えたら古い順に limit 件で切り、返した行までしか進めない", () => {
			const r = mergeNews(
				"6857",
				pull([
					news("t1", "アドバンテスト", 1),
					news("t3", "アドバンテスト", 3),
				]),
				pull([news("m2", POLICY, 2)]),
				null,
				2,
			);
			expect(r.items.map((i) => i.url)).toEqual(["t1", "m2"]);
			expect(r.next).toBe(at(2));
		});

		it("打ち切られた市場ニュースが全行不一致でも読み切った時刻までカーソルを進める", () => {
			const r = mergeNews(
				"285A",
				pull([]),
				pull([news("m2", POLICY, 2), news("m4", POLICY, 4)], true),
				at(1),
				2,
			);
			expect(r.items).toEqual([]);
			expect(r.next).toBe(at(4));
		});

		it("両系統 0 件なら現行カーソルを据え置く", () => {
			expect(mergeNews("6857", pull([]), pull([]), at(1), 20)).toEqual({
				items: [],
				next: at(1),
			});
		});
	});
}
