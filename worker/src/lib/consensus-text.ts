// 記事本文から市場予想 (コンセンサス) に触れた文を探す。
// scripts/count-consensus-mentions.ts が Node から直接 import するので、このファイルは何も import しない。

/** 決算発表日から何暦日後までの記事を市場予想比の言及として拾うか (発表日当日 = 0)。 */
export const MENTION_WINDOW_DAYS = 7;

const CONSENSUS_RE = /市場予想|コンセンサス/;

const CODE_MARK_RE = /[<＜]([0-9][0-9A-Z]{3})[>＞]/g;

/**
 * body のうち code の銘柄について書かれた文を、「。」と改行で分け空白を詰めて返す。
 * <code> の印が無い記事は全文をその銘柄の記事とみなす。印がある記事 (注目個別銘柄・ストップ高一覧など
 * 複数銘柄を並べる記事) では、印を 1 銘柄分だけ含む行からその銘柄の段落が始まり、次の印の行まで続く。
 * 最初の印より前の行と、複数銘柄の印を含む行はどの銘柄とも決められないので捨てる。
 */
function ownSentences(body: string, code: string): string[] {
	const marked = /[<＜][0-9][0-9A-Z]{3}[>＞]/.test(body);
	let owner: string | null = marked ? null : code;
	const out: string[] = [];
	for (const line of body.split("\n")) {
		const codes = new Set([...line.matchAll(CODE_MARK_RE)].map((m) => m[1]));
		if (codes.size > 0) owner = codes.size === 1 ? [...codes][0] : null;
		if (owner !== code) continue;
		for (const s of line.split(/(?<=。)/)) {
			const t = s.replace(/\s+/g, " ").trim();
			if (t.length > 0) out.push(t);
		}
	}
	return out;
}

/** 本文のうち code の銘柄について「市場予想」「コンセンサス」を含む文を、出現順に一致位置 (at) 付きで返す。 */
export function consensusSentences(
	body: string,
	code: string,
): { sentence: string; at: number }[] {
	const out: { sentence: string; at: number }[] = [];
	for (const sentence of ownSentences(body, code)) {
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
					"6857",
				),
			).toEqual([
				{ sentence: "営業利益は市場予想を上回った。", at: 5 },
				{ sentence: "市場 コンセンサス は強気", at: 3 },
			]);
		});
		it("該当文が無ければ空", () => {
			expect(consensusSentences("増収増益で着地。", "6857")).toEqual([]);
		});
	});
}
