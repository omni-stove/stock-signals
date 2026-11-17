// xlsx (Office Open XML のシート) を「行番号 → (列番号 → 値)」に読む。JPX が配る Excel を読むのに使う。
// 書式・数式・日付型は解釈せず、セルの値を文字列のまま返す (日付はシリアル値のまま)。

import { unzipText } from "./inflate";

export type SheetRows = Map<number, Map<number, string>>;

// 列名 (A, B, …, AA) → 0 始まりの番号。
function colIndex(col: string): number {
	let n = 0;
	for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}

function decodeXml(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

// <si> / <is> の中の <t> を連結する (リッチテキストは <r><t> に分かれる)。
function joinText(xml: string): string {
	return decodeXml(
		[...xml.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => t[1]).join(""),
	);
}

/**
 * シート XML と共有文字列 XML から、行番号 (1 始まり) → (列番号 0 始まり → 値) を返す。
 * 共有文字列 (t="s") とインライン文字列 (t="inlineStr") は解決し、数値は文字列のまま返す。
 * sharedXml が null なら共有文字列セルは空文字になる。
 */
export function readSheet(sheetXml: string, sharedXml: string | null): SheetRows {
	const shared = [...(sharedXml ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(
		(m) => joinText(m[1]),
	);
	const rows: SheetRows = new Map();
	for (const m of sheetXml.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
		const ref = m[1].match(/\br="([A-Z]+)(\d+)"/);
		if (!ref || !m[2]) continue;
		let value: string;
		if (/\bt="inlineStr"/.test(m[1])) {
			const is = m[2].match(/<is>([\s\S]*?)<\/is>/);
			if (!is) continue;
			value = joinText(is[1]);
		} else {
			const v = m[2].match(/<v>([^<]*)<\/v>/);
			if (!v) continue;
			value = /\bt="s"/.test(m[1])
				? (shared[Number(v[1])] ?? "")
				: decodeXml(v[1]);
		}
		const r = Number(ref[2]);
		if (!rows.has(r)) rows.set(r, new Map());
		rows.get(r)?.set(colIndex(ref[1]), value);
	}
	return rows;
}

/**
 * xlsx (zip) の最初のシート (xl/worksheets/sheet1.xml) を readSheet で読む。
 * シートが無ければ (xlsx でない・壊れている) null。
 */
export async function readXlsxFirstSheet(
	zip: Uint8Array,
): Promise<SheetRows | null> {
	const sheet = await unzipText(zip, "xl/worksheets/sheet1.xml");
	if (!sheet) return null;
	return readSheet(sheet, await unzipText(zip, "xl/sharedStrings.xml"));
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("readSheet", () => {
		const sharedXml =
			"<sst><si><t>コード</t></si><si><r><t>会社</t></r><r><t>名</t></r></si><si><t>A&amp;B</t></si></sst>";
		it("共有文字列・リッチテキスト・インライン文字列・数値を読む", () => {
			const sheetXml = [
				'<row r="3"><c r="A3" t="s"><v>0</v></c><c r="B3" t="s"><v>1</v></c><c r="AA3" t="s"><v>2</v></c></row>',
				'<row r="4"><c r="A4"><v>46340</v></c><c r="B4" t="inlineStr"><is><t>アドバンテスト</t></is></c><c r="C4" s="1"/></row>',
			].join("");
			const rows = readSheet(sheetXml, sharedXml);
			expect(rows.get(3)).toEqual(
				new Map([
					[0, "コード"],
					[1, "会社名"],
					[26, "A&B"],
				]),
			);
			expect(rows.get(4)).toEqual(
				new Map([
					[0, "46340"],
					[1, "アドバンテスト"],
				]),
			);
		});
		it("共有文字列が無ければ t=s のセルは空文字", () => {
			const rows = readSheet('<c r="A1" t="s"><v>0</v></c>', null);
			expect(rows.get(1)?.get(0)).toBe("");
		});
	});
}
