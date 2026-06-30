// 銘柄 living context のセクション表現と、その 2 つのレンダリング (D1 保存用テキスト / Slack blocks)。
// context-builder は Markdown 記号を一切持たない sections (見出し + 行) を返し、保存と通知の整形は
// すべてここに閉じ込める。保存用テキストは judge-context が LLM へ、context-builder が再生入力として
// そのまま読むので、人間向け装飾 (罫線・絵文字) を混ぜない素のテキストに保つ。

// context-builder が返すセクション。heading は記号なしの見出し文字列、lines は本文行。
export type ContextSection = {
	heading: string;
	lines: string[];
};

// sections を D1 保存・LLM 入力用の素テキストに連結する。
// 見出しと本文を空行で隔て、セクション間も空行で区切るだけ (Markdown 記号・罫線なし)。
// lines が空のセクションは見出しだけを残す (「該当なし」を構造として表現できる)。
export function sectionsToText(
	title: string,
	sections: ContextSection[],
): string {
	const parts: string[] = [title];
	for (const s of sections) {
		const block = [s.heading, ...s.lines].join("\n");
		parts.push(block);
	}
	return parts.join("\n\n");
}

// sections を Slack blocks に組み立てる。先頭に header、各セクションは divider + section で
// 視覚的に分離する (見出しを *太字*、本文を 1 つの section テキストに)。
// 通知プレビュー/検索用の fallback text も text として併せて返す (postMessage にそのまま展開できる形)。
export function sectionsToBlocks(
	title: string,
	sections: ContextSection[],
): { blocks: unknown[]; text: string } {
	const blocks: unknown[] = [
		{
			type: "header",
			text: { type: "plain_text", text: title, emoji: true },
		},
	];
	for (const s of sections) {
		blocks.push({ type: "divider" });
		const bodyText = s.lines.length > 0 ? s.lines.join("\n") : "—";
		blocks.push({
			type: "section",
			text: { type: "mrkdwn", text: `*${s.heading}*\n${bodyText}` },
		});
	}
	const text = sectionsToText(title, sections);
	return { blocks, text };
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	const title = "[285A キオクシア] 銘柄コンテキスト";
	const sections: ContextSection[] = [
		{ heading: "事業の骨格", lines: ["NAND 専業。", "後工程の比重が高い。"] },
		{
			heading: "直近の重大トピック",
			lines: ["2026-06-28: 増産発表 — 数週間は需給逼迫"],
		},
		{ heading: "証券会社レーティング", lines: [] },
	];

	describe("sectionsToText", () => {
		it("見出しと本文を空行区切りの素テキストに連結する (Markdown 記号なし)", () => {
			const text = sectionsToText(title, sections);
			expect(text).toBe(
				[
					"[285A キオクシア] 銘柄コンテキスト",
					"",
					"事業の骨格\nNAND 専業。\n後工程の比重が高い。",
					"",
					"直近の重大トピック\n2026-06-28: 増産発表 — 数週間は需給逼迫",
					"",
					"証券会社レーティング",
				].join("\n"),
			);
			expect(text).not.toContain("#");
			expect(text).not.toContain("*");
		});
	});

	describe("sectionsToBlocks", () => {
		it("header + 各セクション (divider + section) を組む", () => {
			const { blocks, text } = sectionsToBlocks(title, sections);
			expect((blocks[0] as { type: string }).type).toBe("header");
			expect((blocks[0] as { text: { text: string } }).text.text).toBe(title);
			// セクション 3 つ → divider + section が 3 組。
			expect(
				blocks.filter((b) => (b as { type: string }).type === "divider"),
			).toHaveLength(3);
			expect(
				blocks.filter((b) => (b as { type: string }).type === "section"),
			).toHaveLength(3);
			// 見出しは太字、空セクションは — を出す。
			const last = blocks[blocks.length - 1] as { text: { text: string } };
			expect(last.text.text).toBe("*証券会社レーティング*\n—");
			expect(text).toBe(sectionsToText(title, sections));
		});
	});
}
