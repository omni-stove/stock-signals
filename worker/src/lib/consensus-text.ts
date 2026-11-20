// 記事本文から市場予想 (コンセンサス) に触れた文を探す。
// scripts/count-consensus-mentions.ts が Node から直接 import するので、このファイルは何も import しない。

/** 決算発表日から何暦日後までの記事を市場予想比の言及として拾うか (発表日当日 = 0)。 */
export const MENTION_WINDOW_DAYS = 7;

const CONSENSUS_RE = /市場予想|コンセンサス/;

/** 本文を「。」と改行で文に分け、空白を詰める。 */
function splitSentences(body: string): string[] {
	return body
		.split(/(?<=。)|\n/)
		.map((s) => s.replace(/\s+/g, " ").trim())
		.filter((s) => s.length > 0);
}

/** 本文のうち「市場予想」「コンセンサス」を含む文を、出現順に一致位置 (at) 付きで返す。 */
export function consensusSentences(
	body: string,
): { sentence: string; at: number }[] {
	const out: { sentence: string; at: number }[] = [];
	for (const sentence of splitSentences(body)) {
		const at = sentence.search(CONSENSUS_RE);
		if (at >= 0) out.push({ sentence, at });
	}
	return out;
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("consensusSentences", () => {
		it("「。」と改行で区切り、該当文だけを一致位置付きで返す", () => {
			expect(
				consensusSentences(
					"増収増益。営業利益は市場予想を上回った。\n  市場 コンセンサス\tは強気\n株価は急伸。",
				),
			).toEqual([
				{ sentence: "営業利益は市場予想を上回った。", at: 5 },
				{ sentence: "市場 コンセンサス は強気", at: 3 },
			]);
		});
		it("該当文が無ければ空", () => {
			expect(consensusSentences("増収増益で着地。")).toEqual([]);
		});
	});
}
