// HTMLRewriter ベースの HTML 走査ヘルパ。
//
// フルDOM構築のパーサ (cheerio 等) は1ページ数十ms〜1s の CPU を食い、Workers 無料枠の
// CPU 上限 (10ms/呼び出し) で cron ごと殺されるため、ここでは使わない。HTMLRewriter は
// ランタイム組み込みのストリーミングパーサ (ネイティブ実装 lol-html) で、JS 側の CPU を
// ほぼ使わない。テスト (Node vitest) には同一エンジンの WASM ビルド htmlrewriter を
// worker/vitest.setup.ts が globalThis に注入する。
//
// パーサを書くときの約束 (DOM パーサとの挙動差):
//   - セレクタに tbody を書かない。ストリーミング照合はマークアップの実在階層で当てる
//     ため、tbody 省略ページに一致しなくなる ("table tr" は tbody の有無どちらでも当たる)。
//   - :nth-child 等の位置擬似クラスは使えない。順序は出現順の状態機械で追う。
//   - テキストはエンティティ未デコードで届く → decodeEntities を通して返す。
//   - RSS/XML には使えない (<link> を HTML の void 要素として読むため)。parseXmlItems を使う。

type ElementHandlers = NonNullable<Parameters<HTMLRewriter["on"]>[1]>;

function rewriterCtor(): typeof HTMLRewriter {
	const ctor = (globalThis as { HTMLRewriter?: typeof HTMLRewriter })
		.HTMLRewriter;
	if (!ctor) {
		throw new Error(
			"HTMLRewriter is not available (Node では vitest.setup.ts が注入する)",
		);
	}
	return ctor;
}

// selector→handlers を登録して html を流し切る (低レベル)。ハンドラ側が状態を溜める。
export async function scanHtml(
	html: string,
	on: [string, ElementHandlers][],
): Promise<void> {
	const Ctor = rewriterCtor();
	let rw = new Ctor();
	for (const [sel, h] of on) rw = rw.on(sel, h);
	await rw.transform(new Response(html)).arrayBuffer();
}

// HTML エンティティの最小デコード (対象サイトで実際に現れる範囲 + 数値参照)。
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};
export function decodeEntities(s: string): string {
	if (!s.includes("&")) return s;
	return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, ent: string) => {
		if (ent[0] === "#") {
			const hex = ent[1] === "x" || ent[1] === "X";
			const code = parseInt(ent.slice(hex ? 2 : 1), hex ? 16 : 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: all;
		}
		return NAMED_ENTITIES[ent] ?? all;
	});
}

// タグを空白に落として素のテキストにする (cheerio の .text() 相当を文字列走査で)。
export function stripTags(html: string): string {
	return decodeEntities(html.replace(/<[^>]*>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}

export type TextMatch = { text: string; attrs: Record<string, string> };

// 各 selector の一致要素ごとに { text(子孫含む・デコード済み), attrs } を集める。
// cheerio の $(sel).each + .text()/.attr() 相当。first だけ欲しい側は [0] を読む。
export async function queryAll(
	html: string,
	selectors: string[],
): Promise<Record<string, TextMatch[]>> {
	const out: Record<string, TextMatch[]> = {};
	const on: [string, ElementHandlers][] = selectors.map((sel) => {
		const matches: TextMatch[] = [];
		out[sel] = matches;
		return [
			sel,
			{
				element(e) {
					const attrs: Record<string, string> = {};
					for (const [name, value] of e.attributes) attrs[name] = value;
					matches.push({ text: "", attrs });
				},
				text(t) {
					const cur = matches[matches.length - 1];
					if (cur) cur.text += t.text;
				},
			},
		];
	});
	await scanHtml(html, on);
	for (const sel of selectors) {
		for (const m of out[sel]) m.text = decodeEntities(m.text);
	}
	return out;
}

// queryAll の結果から「最初の一致のテキスト (trim 済み)」。無ければ ""。
export function firstText(q: Record<string, TextMatch[]>, sel: string): string {
	return q[sel]?.[0]?.text.trim() ?? "";
}
// queryAll の結果から「最初の一致の属性値」。無ければ null。
export function firstAttr(
	q: Record<string, TextMatch[]>,
	sel: string,
	attr: string,
): string | null {
	return q[sel]?.[0]?.attrs[attr] ?? null;
}

// ── テーブル走査 ─────────────────────────────────────────────────────────────
// kabutan 系ページの表 (日足/指標/信用残/決算/一覧) を行×セルの素データに落とす。
// ヘッダは「先頭から連続する全セル th の行」(thead th 相当)。入れ子テーブルは非対応
// (kabutan は入れ子にしない前提。sliceTables と同じ)。

type TableCell = {
	tag: "th" | "td";
	text: string; // 子孫テキスト連結 (デコード済み)
	aHref: string | null; // セル内最初の <a> の href (a 自体が無ければ null、href 無し a は "")
	aText: string; // その a のテキスト
	timeDatetime: string | null; // セル内最初の <time> の datetime
	timeText: string; // セル内最初の <time> のテキスト
};
type TableRow = { cells: TableCell[] };
export type TableData = {
	className: string; // <table class="…"> (無ければ "")
	headers: string[]; // ヘッダ行のセルテキスト (trim 済み・複数ヘッダ行は連結)
	rows: TableRow[]; // ヘッダ行を除いたデータ行
};

export async function scanTables(html: string): Promise<TableData[]> {
	type RawTable = { className: string; rows: TableCell[][] };
	const tables: RawTable[] = [];
	let row: TableCell[] | null = null;
	let cell: TableCell | null = null;
	let firstA = false; // cell 内の最初の <a> のテキストを収集中か
	let firstTime = false; // cell 内の最初の <time> のテキストを収集中か

	const openCell = (tag: "th" | "td") => {
		cell = {
			tag,
			text: "",
			aHref: null,
			aText: "",
			timeDatetime: null,
			timeText: "",
		};
		firstA = false;
		firstTime = false;
		row?.push(cell);
	};
	const cellText: ElementHandlers = {
		text(t) {
			if (cell) cell.text += t.text;
			if (cell && firstA) cell.aText += t.text;
			if (cell && firstTime) cell.timeText += t.text;
		},
	};

	await scanHtml(html, [
		[
			"table",
			{
				element(e) {
					tables.push({ className: e.getAttribute("class") ?? "", rows: [] });
					row = null;
					cell = null;
				},
			},
		],
		[
			"table tr",
			{
				element() {
					row = [];
					cell = null;
					tables[tables.length - 1]?.rows.push(row);
				},
			},
		],
		[
			"table tr th",
			{
				element() {
					openCell("th");
				},
				text: cellText.text,
			},
		],
		[
			"table tr td",
			{
				element() {
					openCell("td");
				},
				text: cellText.text,
			},
		],
		[
			"table tr a",
			{
				element(e) {
					if (cell && cell.aHref === null && cell.aText === "") {
						cell.aHref = e.getAttribute("href") ?? "";
						firstA = true;
					} else {
						firstA = false;
					}
				},
			},
		],
		[
			"table tr time",
			{
				element(e) {
					if (cell && cell.timeDatetime === null && cell.timeText === "") {
						cell.timeDatetime = e.getAttribute("datetime");
						firstTime = true;
					} else {
						firstTime = false;
					}
				},
			},
		],
	]);

	return tables.map((t) => {
		for (const r of t.rows) {
			for (const c of r) {
				c.text = decodeEntities(c.text);
				c.aText = decodeEntities(c.aText).trim();
				c.timeText = decodeEntities(c.timeText).trim();
			}
		}
		// 先頭から連続する「全セル th」行をヘッダとみなす (thead th 相当)。
		let headerRows = 0;
		while (
			headerRows < t.rows.length &&
			t.rows[headerRows].length > 0 &&
			t.rows[headerRows].every((c) => c.tag === "th")
		) {
			headerRows++;
		}
		return {
			className: t.className,
			headers: t.rows
				.slice(0, headerRows)
				.flatMap((r) => r.map((c) => c.text.trim())),
			rows: t.rows.slice(headerRows).map((cells) => ({ cells })),
		};
	});
}

// class 属性 (空白区切り) に name を含むテーブルだけを返す。
export function tablesWithClass(
	tables: TableData[],
	name: string,
): TableData[] {
	return tables.filter((t) => t.className.split(/\s+/).includes(name));
}

// ── RSS/XML ─────────────────────────────────────────────────────────────────
// RSS 2.0 の <item> から単純タグのテキストを抜く (文字列走査)。
// HTMLRewriter は HTML パーサで <link> を void 要素として扱い、RSS の
// <link>URL</link> の中身を読めないため、XML だけはこちらを使う。
export function parseXmlItems(
	xml: string,
	tags: string[],
): Record<string, string>[] {
	const out: Record<string, string>[] = [];
	const itemRe = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g;
	for (const m of xml.matchAll(itemRe)) {
		const block = m[1];
		const item: Record<string, string> = {};
		for (const tag of tags) {
			const tm = block.match(
				new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`),
			);
			if (!tm) {
				item[tag] = "";
				continue;
			}
			const cdata = tm[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
			item[tag] = (cdata ? cdata[1] : decodeEntities(tm[1])).trim();
		}
		out.push(item);
	}
	return out;
}

// in-source tests (本番ビルドでは tree-shake される。vitest.config.ts 参照)
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("decodeEntities", () => {
		it("名前付き・数値・16進参照をデコードする", () => {
			expect(decodeEntities("A&amp;B &lt;x&gt; &#65; &#x3042;")).toBe(
				"A&B <x> A あ",
			);
		});
		it("未知の実体参照はそのまま残す", () => {
			expect(decodeEntities("&unknown; &amp;")).toBe("&unknown; &");
		});
	});

	describe("stripTags", () => {
		it("タグを外しテキストだけにする", () => {
			expect(
				stripTags("<div><span>12,876.90</span> 前日比 +674.36</div>"),
			).toBe("12,876.90 前日比 +674.36");
		});
	});

	describe("queryAll", () => {
		it("selector ごとに text (子孫含む) と attrs を集める", async () => {
			const q = await queryAll(
				"<div class='a'>x<span>y</span></div><time datetime='2026-01-01'>1/1</time>",
				["div.a", "time"],
			);
			expect(q["div.a"][0].text).toBe("xy");
			expect(q.time[0].attrs.datetime).toBe("2026-01-01");
			expect(firstText(q, "time")).toBe("1/1");
			expect(firstAttr(q, "time", "datetime")).toBe("2026-01-01");
			expect(firstAttr(q, "div.a", "datetime")).toBeNull();
		});
	});

	describe("scanTables", () => {
		it("ヘッダ (全セル th の先頭行) とデータ行を分離する", async () => {
			const [t] = await scanTables(
				"<table class='x y'><thead><tr><th>H1</th><th>H2</th></tr></thead>" +
					"<tbody><tr><th>r1</th><td>v1</td></tr></tbody></table>",
			);
			expect(t.className).toBe("x y");
			expect(t.headers).toEqual(["H1", "H2"]);
			expect(t.rows).toHaveLength(1);
			expect(t.rows[0].cells.map((c) => [c.tag, c.text])).toEqual([
				["th", "r1"],
				["td", "v1"],
			]);
		});
		it("tbody/thead が省略されたマークアップでも同じに読める", async () => {
			const [t] = await scanTables(
				"<table><tr><th>H</th></tr><tr><td>v</td></tr></table>",
			);
			expect(t.headers).toEqual(["H"]);
			expect(t.rows[0].cells[0].text).toBe("v");
		});
		it("セル内最初の a / time を拾う", async () => {
			const [t] = await scanTables(
				"<table><tr><td><time datetime='2026-06-18'>06/18</time></td>" +
					"<td><a href='/n1'>題1</a><a href='/n2'>題2</a></td></tr></table>",
			);
			const [c0, c1] = t.rows[0].cells;
			expect(c0.timeDatetime).toBe("2026-06-18");
			expect(c0.timeText).toBe("06/18");
			expect(c1.aHref).toBe("/n1");
			expect(c1.aText).toBe("題1");
		});
		it("複数テーブルを出現順に返し、class でフィルタできる", async () => {
			const tables = await scanTables(
				"<table class='nav'><tr><td>m</td></tr></table>" +
					"<table class='s_news_list'><tr><td>n</td></tr></table>",
			);
			expect(tables).toHaveLength(2);
			expect(tablesWithClass(tables, "s_news_list")).toHaveLength(1);
			expect(tablesWithClass(tables, "news")).toHaveLength(0);
		});
	});

	describe("parseXmlItems", () => {
		it("item ごとに指定タグのテキストを抜く (CDATA・エンティティ対応)", () => {
			const xml = [
				"<rss><channel>",
				"<item><title><![CDATA[A & B]]></title><link>https://x/1</link>",
				"<pubDate>Fri, 26 Jun 2026 13:35:00 +0900</pubDate></item>",
				"<item><title>C &amp; D</title><description>本文</description></item>",
				"</channel></rss>",
			].join("");
			const items = parseXmlItems(xml, [
				"title",
				"link",
				"description",
				"pubDate",
			]);
			expect(items).toEqual([
				{
					title: "A & B",
					link: "https://x/1",
					description: "",
					pubDate: "Fri, 26 Jun 2026 13:35:00 +0900",
				},
				{ title: "C & D", link: "", description: "本文", pubDate: "" },
			]);
		});
	});
}
