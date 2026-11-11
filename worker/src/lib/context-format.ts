// 銘柄 living context のセクション表現と、その 2 つのレンダリング (D1 保存用テキスト / Slack blocks)。
// post-context.sh が Markdown 記号を一切持たない sections (見出し + 行) を渡し、保存と通知の整形は
// すべてここに閉じ込める。保存用テキストは judge-context が LLM へ、context-builder が再生入力として
// そのまま読むので、人間向け装飾 (罫線・絵文字) を混ぜない素のテキストに保つ。

// post-context.sh が組むセクション。heading は記号なしの見出し文字列、lines は本文行。
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

// サマリーに最新の 1 行を載せるセクションの見出し (post-context.sh が組む見出し)。
const LATEST_TOPIC_HEADING = "直近の重大トピック";

// 直近の重大トピックの行で、事実とその先への効きを分ける区切り (post-context.sh が連結に使う)。
const TOPIC_EFFECT_SEPARATOR = " — ";

// Slack の見出しに付ける emoji (post-context.sh が組む見出しで引く)。
const HEADING_EMOJI: Record<string, string> = {
	事業の骨格: "🏭",
	"商品ラインナップ / 技術ロードマップ": "🧪",
	"経営判断・資本政策": "🏛️",
	[LATEST_TOPIC_HEADING]: "🆕",
	"決算の特色・クセ": "🔍",
	"決算・ガイダンス": "📊",
};

function mrkdwnSection(text: string) {
	return { type: "section", text: { type: "mrkdwn", text } };
}

function headingText(heading: string): string {
	const emoji = HEADING_EMOJI[heading];
	return emoji ? `${emoji} *${heading}*` : `*${heading}*`;
}

// トピック行を ・事実 / 　→ 効き の 2 行に分ける。区切りが無い行は 1 行のまま。
function topicBullet(line: string): string {
	const at = line.lastIndexOf(TOPIC_EFFECT_SEPARATOR);
	if (at < 0) return `・${line}`;
	const effect = line.slice(at + TOPIC_EFFECT_SEPARATOR.length);
	return `・${line.slice(0, at)}\n　→ ${effect}`;
}

// sections を Slack の親投稿 + スレッド詳細に組み立てる (postWithDetails にそのまま展開できる形)。
// 親 = header + 最新トピック 1 行のサマリー。details = 行のあるセクションを emoji 見出し + 箇条書きで
// 1 セクション 1 section block に組む。
export function sectionsToBlocks(
	title: string,
	sections: ContextSection[],
): {
	blocks: unknown[];
	text: string;
	details: { blocks: unknown[]; text: string };
} {
	const latest = sections.find((s) => s.heading === LATEST_TOPIC_HEADING)
		?.lines[0];
	const blocks: unknown[] = [
		{
			type: "header",
			text: { type: "plain_text", text: title, emoji: true },
		},
		...(latest
			? [mrkdwnSection(`🆕 *最新トピック*\n${topicBullet(latest)}`)]
			: []),
	];
	const detailBlocks = sections
		.filter((s) => s.lines.length > 0)
		.map((s) => {
			const bullet =
				s.heading === LATEST_TOPIC_HEADING
					? topicBullet
					: (line: string) => `・${line}`;
			return mrkdwnSection(
				[headingText(s.heading), ...s.lines.map(bullet)].join("\n"),
			);
		});
	return {
		blocks,
		text: latest ? `${title}\n${latest}` : title,
		details: {
			blocks: detailBlocks.length > 0 ? detailBlocks : [mrkdwnSection("—")],
			text: sectionsToText(title, sections),
		},
	};
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
		{ heading: "決算・ガイダンス", lines: [] },
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
					"決算・ガイダンス",
				].join("\n"),
			);
			expect(text).not.toContain("#");
			expect(text).not.toContain("*");
		});
	});

	describe("sectionsToBlocks", () => {
		const textOf = (block: unknown) =>
			(block as { text: { text: string } }).text.text;

		it("親は header + 最新トピック 1 行のサマリーにする", () => {
			const { blocks, text } = sectionsToBlocks(title, sections);
			expect(blocks).toHaveLength(2);
			expect((blocks[0] as { type: string }).type).toBe("header");
			expect(textOf(blocks[0])).toBe(title);
			expect(textOf(blocks[1])).toBe(
				"🆕 *最新トピック*\n・2026-06-28: 増産発表\n　→ 数週間は需給逼迫",
			);
			expect(text).toBe(`${title}\n2026-06-28: 増産発表 — 数週間は需給逼迫`);
		});

		it("最新トピックが無ければ親は header だけにする", () => {
			const { blocks, text } = sectionsToBlocks(title, [
				{ heading: "直近の重大トピック", lines: [] },
			]);
			expect(blocks).toHaveLength(1);
			expect(text).toBe(title);
		});

		it("details は行のあるセクションを emoji 見出し + 箇条書きで組む", () => {
			const { details } = sectionsToBlocks(title, sections);
			// 行が空の決算・ガイダンスは出さない。
			expect(details.blocks.map(textOf)).toEqual([
				"🏭 *事業の骨格*\n・NAND 専業。\n・後工程の比重が高い。",
				"🆕 *直近の重大トピック*\n・2026-06-28: 増産発表\n　→ 数週間は需給逼迫",
			]);
			expect(details.text).toBe(sectionsToText(title, sections));
		});

		it("区切りの無いトピック行と未知の見出しはそのまま箇条書きにする", () => {
			const { details } = sectionsToBlocks(title, [
				{ heading: "直近の重大トピック", lines: ["2026-06-28: 増産発表"] },
				{ heading: "その他", lines: ["a — b"] },
			]);
			expect(details.blocks.map(textOf)).toEqual([
				"🆕 *直近の重大トピック*\n・2026-06-28: 増産発表",
				"*その他*\n・a — b",
			]);
		});

		it("全セクションが空でも details の blocks を空にしない", () => {
			const { details } = sectionsToBlocks(title, [
				{ heading: "事業の骨格", lines: [] },
			]);
			expect(details.blocks.map(textOf)).toEqual(["—"]);
		});
	});
}
