// Cloudflare Worker: 公式IRページの site 別一覧パーサ群。
//
// site ごとに一覧の構造が違うので parseList() で振り分ける。kioxia だけ記事本文HTMLが
// 安定して取れるので本文取得する (collectOne の fetchBody 相当)。他社の記事リンクは
// IRカレンダー/PDFで本文HTMLが取れないため、disclosure.ts と同様「一覧のタイトル」を
// 本文として保存する (決算系の PDF は ir-collect.ts が定性部分の抜粋を足す)。
//
// IR_SOURCES (どの銘柄を・どの URL で・どの site パーサで読むか) の定義は watchlist.ts に集約済み。
// ここからは re-export するだけ。新しい site を足すときは下記パーサを追加し、watchlist.ts の
// ticker.ir.site をそのキーにする。

import { decodeEntities, firstText, queryAll, scanHtml } from "./html";
import { isEarningsDisclosure } from "./pdf-text";
import { IR_SOURCES, type IrSourceEntry } from "./watchlist";

// 銘柄ごとの IR スクレイプ定義 (code/site/list_url)。collectOne の引数型に使う。
export { IR_SOURCES };
export type IrSource = IrSourceEntry;

export const DEFAULT_LIMIT = 20;

type ListItem = { url: string; title: string; date: string; category: string };

function dateFromUrl(url: string): string {
	const m = url.match(/\/(\d{4})(\d{2})(\d{2})-\d+\.html/);
	return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

function categoryFromUrl(url: string): string {
	if (url.includes("kioxia-holdings.com")) return "holdings";
	if (url.includes("/about/news/")) return "corporate";
	if (url.includes("/business/news/")) return "business";
	if (url.includes("/personal/news/")) return "personal";
	return "other";
}

// kioxia ニュース一覧パーサ。
async function parseKioxiaList(
	html: string,
	baseUrl: string,
): Promise<ListItem[]> {
	type Raw = { href: string | null; btnText: string; allText: string };
	const raws: Raw[] = [];
	let cur: Raw | null = null;
	await scanHtml(html, [
		[
			"a.cmp-button",
			{
				element(e) {
					cur = { href: e.getAttribute("href"), btnText: "", allText: "" };
					raws.push(cur);
				},
				text(t) {
					if (cur) cur.allText += t.text;
				},
			},
		],
		[
			"a.cmp-button .cmp-button__text",
			{
				text(t) {
					if (cur) cur.btnText += t.text;
				},
			},
		],
	]);

	const out: ListItem[] = [];
	const seenUrl = new Set<string>();
	for (const raw of raws) {
		if (!raw.href) continue;
		const url = new URL(raw.href, baseUrl).toString();
		const date = dateFromUrl(url);
		if (!date) continue;
		if (seenUrl.has(url)) continue;
		seenUrl.add(url);
		const title = raw.btnText.trim() || raw.allText.trim();
		if (!title) continue;
		out.push({ url, title, date, category: categoryFromUrl(url) });
	}
	return out;
}

// アドバンテスト ニュース一覧 (https://www.advantest.com/ja/news/)。
//   各記事は <li class="m-list-news__item">。
//     リンク : a.m-list-news__wrapper の href (HTMLページ or PDF or /ja/investors/...)
//     日付   : time.m-list-news__date の datetime="YYYY-MM-DD"
//     カテゴリ: b.m-list-news__category (例「投資家の皆様へ」)
//     タイトル: p.m-text__item
//   本文は取らない (リンク先がPDF/カレンダーで一定しないため)。category はそのまま日本語で持つ。
async function parseAdvantestList(
	html: string,
	baseUrl: string,
): Promise<ListItem[]> {
	type Raw = {
		href: string | null;
		date: string | null;
		title: string;
		titleCount: number;
		category: string;
		categoryCount: number;
	};
	const raws: Raw[] = [];
	let cur: Raw | null = null;
	await scanHtml(html, [
		[
			"li.m-list-news__item",
			{
				element() {
					cur = {
						href: null,
						date: null,
						title: "",
						titleCount: 0,
						category: "",
						categoryCount: 0,
					};
					raws.push(cur);
				},
			},
		],
		[
			"li.m-list-news__item a.m-list-news__wrapper",
			{
				element(e) {
					if (cur) cur.href ??= e.getAttribute("href");
				},
			},
		],
		[
			"li.m-list-news__item time.m-list-news__date",
			{
				element(e) {
					if (cur) cur.date ??= e.getAttribute("datetime");
				},
			},
		],
		[
			"li.m-list-news__item p.m-text__item",
			{
				element() {
					if (cur) cur.titleCount++;
				},
				text(t) {
					if (cur?.titleCount === 1) cur.title += t.text;
				},
			},
		],
		[
			"li.m-list-news__item b.m-list-news__category",
			{
				element() {
					if (cur) cur.categoryCount++;
				},
				text(t) {
					if (cur?.categoryCount === 1) cur.category += t.text;
				},
			},
		],
	]);

	const out: ListItem[] = [];
	const seenUrl = new Set<string>();
	for (const raw of raws) {
		if (!raw.href) continue;
		const url = new URL(raw.href, baseUrl).toString();
		if (seenUrl.has(url)) continue;
		const date = raw.date?.trim();
		if (!date) continue;
		const title = raw.title.trim();
		if (!title) continue;
		seenUrl.add(url);
		const category = raw.category.trim();
		out.push({ url, title, date, category: category || "advantest" });
	}
	return out;
}

// レーザーテック ニュース一覧 (https://www.lasertec.co.jp/news/ → 当年ページにリダイレクト)。
//   各記事は <article class="news__article">。
//     リンク : a.news__type の href (/news/YYYY/...html)
//     日付   : time.news__date の datetime="YYYY-MM-DD"
//     カテゴリ: i.util-badge--news (例「ニュース」「IR」)
//     タイトル: h3.news__title (子の <i class="news__filesize"> は除く)
//   list_url は当年のみ表示。新着順に拾えれば足りるので当年で十分。本文は取らない。
async function parseLasertecList(
	html: string,
	baseUrl: string,
): Promise<ListItem[]> {
	type Raw = {
		href: string | null;
		date: string | null;
		title: string;
		titleCount: number;
		iTexts: string[]; // h3 内の <i> (ファイルサイズ表記) を後で title から除く
		category: string;
		categoryCount: number;
	};
	const raws: Raw[] = [];
	let cur: Raw | null = null;
	await scanHtml(html, [
		[
			"article.news__article",
			{
				element() {
					cur = {
						href: null,
						date: null,
						title: "",
						titleCount: 0,
						iTexts: [],
						category: "",
						categoryCount: 0,
					};
					raws.push(cur);
				},
			},
		],
		[
			"article.news__article a.news__type",
			{
				element(e) {
					if (cur) cur.href ??= e.getAttribute("href");
				},
			},
		],
		[
			"article.news__article time.news__date",
			{
				element(e) {
					if (cur) cur.date ??= e.getAttribute("datetime");
				},
			},
		],
		[
			"article.news__article h3.news__title",
			{
				element() {
					if (cur) cur.titleCount++;
				},
				text(t) {
					if (cur?.titleCount === 1) cur.title += t.text;
				},
			},
		],
		[
			"article.news__article h3.news__title i",
			{
				element() {
					if (cur?.titleCount === 1) cur.iTexts.push("");
				},
				text(t) {
					if (cur?.titleCount === 1 && cur.iTexts.length > 0)
						cur.iTexts[cur.iTexts.length - 1] += t.text;
				},
			},
		],
		[
			"article.news__article .news__category",
			{
				element() {
					if (cur) cur.categoryCount++;
				},
				text(t) {
					if (cur?.categoryCount === 1) cur.category += t.text;
				},
			},
		],
	]);

	const out: ListItem[] = [];
	const seenUrl = new Set<string>();
	for (const raw of raws) {
		if (!raw.href) continue;
		const url = new URL(raw.href, baseUrl).toString();
		if (seenUrl.has(url)) continue;
		const date = raw.date?.trim();
		if (!date) continue;
		// ストリーミングでは <i> の中身も h3 テキストに混ざるので、収集済みの i テキストを除く。
		let title = raw.title;
		for (const s of raw.iTexts) title = title.replace(s, "");
		title = title.trim();
		if (!title) continue;
		seenUrl.add(url);
		out.push({ url, title, date, category: raw.category.trim() || "lasertec" });
	}
	return out;
}

// 年・月・日が揃った日付 (2026年11月5日 / 2026.11.05 / 2026/11/05 / 2026-11-05)。
// 「2027年3月期」のように日が続かないものは当たらない。
const YUDEN_DATE = /(\d{4})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})/;
// リンク文言が見出しでなく「PDF」「詳細」等のときは、ブロックのテキストを見出しに使う。
const GENERIC_LINK_TEXT = /^(?:PDF|詳細|詳しく|もっと見る|more|こちら)/i;
// 見出しに付くファイル種別・サイズ表記 (「(PDF:235KB)」等)。
const FILE_NOTE = /[(（]\s*PDF[^)）]*[)）]/gi;

function yudenDate(m: RegExpMatchArray): string | null {
	const month = Number(m[2]);
	const day = Number(m[3]);
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

function cleanTitle(s: string): string {
	return decodeEntities(s).replace(FILE_NOTE, "").replace(/\s+/g, " ").trim();
}

// 太陽誘電 IR ニュース一覧 (https://www.yuden.co.jp/ir/)。
//   日付テキストと記事リンク (PDF / HTML) の並びを、クラス名に依らず読む。li / tr / dt / article の
//   開始でブロックを切り、ブロック内の最初の日付をそのブロックのリンク全部に付ける。dt で切るので
//   <dl><dt>日付</dt><dd><a>…</a></dd> も1ブロックになる。div/p だけで組まれた一覧は、日付とリンクを
//   持つブロックの後に次の日付が現れた所で切る。日付の無いブロック (ナビ・フッタ) は捨てる。
//   category は決算系の見出しなら "earnings"、それ以外は "ir"。
async function parseYudenList(
	html: string,
	baseUrl: string,
): Promise<ListItem[]> {
	type Anchor = { href: string; text: string };
	type Block = { text: string; date: string | null; anchors: Anchor[] };
	const blocks: Block[] = [];
	const open = (): Block => {
		const b: Block = { text: "", date: null, anchors: [] };
		blocks.push(b);
		return b;
	};
	let cur: Block | null = null;
	let anchor: Anchor | null = null;
	const startBlock = {
		element() {
			cur = open();
		},
	};
	await scanHtml(html, [
		["li", startBlock],
		["tr", startBlock],
		["dt", startBlock],
		["article", startBlock],
		[
			"a[href]",
			{
				element(e) {
					anchor = { href: e.getAttribute("href") ?? "", text: "" };
					cur ??= open();
					cur.anchors.push(anchor);
				},
				text(t) {
					if (anchor) anchor.text += t.text;
				},
			},
		],
		[
			"body",
			{
				text(t) {
					const s = t.text;
					if (!s) return;
					const itemDone = cur?.date && cur.anchors.length > 0;
					if (itemDone && YUDEN_DATE.test(s)) cur = open();
					cur ??= open();
					cur.text += s;
					if (!cur.date) {
						const m = cur.text.match(YUDEN_DATE);
						if (m) cur.date = yudenDate(m);
					}
				},
			},
		],
	]);

	const out: ListItem[] = [];
	const seenUrl = new Set<string>();
	for (const b of blocks) {
		if (!b.date) continue;
		// ブロックのテキストにはリンク文言も混ざるので、日付と全リンク文言を除いた残りを見出し候補にし、
		// 残らなければ文言が見出しらしいリンクのものを使う。
		let rest = b.text.replace(YUDEN_DATE, "");
		for (const a of b.anchors) rest = rest.replace(a.text, "");
		const namedLink = b.anchors
			.map((a) => cleanTitle(a.text))
			.find((t) => t !== "" && !GENERIC_LINK_TEXT.test(t));
		const blockTitle = cleanTitle(rest) || namedLink || "";
		for (const a of b.anchors) {
			const href = decodeEntities(a.href).trim();
			if (!href || href.startsWith("#")) continue;
			let url: URL;
			try {
				url = new URL(href, baseUrl);
			} catch {
				continue;
			}
			if (url.protocol !== "https:" && url.protocol !== "http:") continue;
			const key = url.toString();
			if (seenUrl.has(key)) continue;
			const linkText = cleanTitle(a.text);
			const generic = !linkText || GENERIC_LINK_TEXT.test(linkText);
			const title = generic ? blockTitle : linkText;
			if (!title) continue;
			seenUrl.add(key);
			out.push({
				url: key,
				title,
				date: b.date,
				category: isEarningsDisclosure(title) ? "earnings" : "ir",
			});
		}
	}
	return out;
}

// site → 一覧パーサ。一覧HTML から ListItem[] を返す。
export async function parseList(
	site: string,
	body: string,
	baseUrl: string,
): Promise<ListItem[]> {
	switch (site) {
		case "kioxia":
			return parseKioxiaList(body, baseUrl);
		case "advantest":
			return parseAdvantestList(body, baseUrl);
		case "lasertec":
			return parseLasertecList(body, baseUrl);
		case "yuden":
			return parseYudenList(body, baseUrl);
		default:
			return [];
	}
}

export async function parseKioxiaArticle(html: string): Promise<{
	title: string;
	body: string;
}> {
	const q = await queryAll(html, [
		"h1",
		"title",
		"main",
		"article",
		".cmp-text",
		"body",
	]);
	const title = firstText(q, "h1") || firstText(q, "title");
	// 最終フォールバックの body は <body> タグが実在するページでのみ拾える
	// (実ページには必ずある。ストリーミング照合は暗黙の body 補完をしない)。
	const body =
		firstText(q, "main") ||
		firstText(q, "article") ||
		firstText(q, ".cmp-text") ||
		firstText(q, "body");
	return {
		title,
		body: body
			.replace(/[ \t]+/g, " ")
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
	};
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("dateFromUrl", () => {
		it("URL 末尾の YYYYMMDD-N.html から日付を取る", () => {
			expect(
				dateFromUrl("https://www.kioxia.com/ja-jp/about/news/20260611-1.html"),
			).toBe("2026-06-11");
		});
		it("日付パターンが無ければ空文字", () => {
			expect(dateFromUrl("https://www.kioxia.com/ja-jp/news.html")).toBe("");
		});
	});

	describe("categoryFromUrl", () => {
		const cases: Array<[string, string]> = [
			["https://www.kioxia-holdings.com/x.html", "holdings"],
			["https://www.kioxia.com/ja-jp/about/news/x.html", "corporate"],
			["https://www.kioxia.com/ja-jp/business/news/x.html", "business"],
			["https://www.kioxia.com/ja-jp/personal/news/x.html", "personal"],
			["https://www.kioxia.com/ja-jp/other.html", "other"],
		];
		for (const [url, expected] of cases) {
			it(`${url} → ${expected}`, () => {
				expect(categoryFromUrl(url)).toBe(expected);
			});
		}
	});

	describe("parseList: kioxia", () => {
		it("a.cmp-button から URL・タイトル・日付・カテゴリを抽出し重複URLを除く", async () => {
			const html = [
				"<a class='cmp-button' href='/ja-jp/about/news/20260611-1.html'><span class='cmp-button__text'>新製品</span></a>",
				"<a class='cmp-button' href='/ja-jp/about/news/20260611-1.html'><span class='cmp-button__text'>重複</span></a>",
				"<a class='cmp-button' href='/ja-jp/news.html'><span class='cmp-button__text'>日付なしは除外</span></a>",
			].join("");
			const out = await parseList("kioxia", html, "https://www.kioxia.com");
			expect(out).toEqual([
				{
					url: "https://www.kioxia.com/ja-jp/about/news/20260611-1.html",
					title: "新製品",
					date: "2026-06-11",
					category: "corporate",
				},
			]);
		});
	});

	describe("parseList: advantest", () => {
		it("li.m-list-news__item から datetime・タイトル・カテゴリを取る", async () => {
			const html = [
				"<li class='m-list-news__item'>",
				"<a class='m-list-news__wrapper' href='/ja/news/a.html'>",
				"<time class='m-list-news__date' datetime='2026-06-10'></time>",
				"<b class='m-list-news__category'>投資家の皆様へ</b>",
				"<p class='m-text__item'>決算説明会</p>",
				"</a></li>",
			].join("");
			expect(
				await parseList("advantest", html, "https://www.advantest.com"),
			).toEqual([
				{
					url: "https://www.advantest.com/ja/news/a.html",
					title: "決算説明会",
					date: "2026-06-10",
					category: "投資家の皆様へ",
				},
			]);
		});
	});

	describe("parseList: lasertec", () => {
		it("article.news__article からタイトル (子の i を除く) を取る", async () => {
			const html = [
				"<article class='news__article'>",
				"<a class='news__type' href='/news/2026/a.html'></a>",
				"<time class='news__date' datetime='2026-06-09'></time>",
				"<span class='news__category'>IR</span>",
				"<h3 class='news__title'>決算短信<i class='news__filesize'>(PDF)</i></h3>",
				"</article>",
			].join("");
			expect(
				await parseList("lasertec", html, "https://www.lasertec.co.jp"),
			).toEqual([
				{
					url: "https://www.lasertec.co.jp/news/2026/a.html",
					title: "決算短信",
					date: "2026-06-09",
					category: "IR",
				},
			]);
		});
	});

	describe("parseList: yuden", () => {
		const BASE = "https://www.yuden.co.jp/jp/ir/";
		const parse = (body: string) =>
			parseList("yuden", `<html><body>${body}</body></html>`, BASE);

		it("dt の日付を dd の全リンクに付け、PDF 表記を除き決算系を earnings にする", async () => {
			const html = [
				"<nav><ul><li><a href='/jp/ir/library/'>IRライブラリ</a></li></ul></nav>",
				"<dl>",
				"<dt>2026年11月5日</dt>",
				"<dd><a href='/jp/ir/pdf/tanshin.pdf'>2027年3月期 第2四半期決算短信 (PDF:512KB)</a>",
				"<a href='/jp/ir/pdf/setsumei.pdf'>決算説明資料</a></dd>",
				"<dt>2026.10.20</dt>",
				"<dd><a href='/jp/ir/news/a.html'>自己株式の取得状況に関するお知らせ</a></dd>",
				"</dl>",
				"<footer><ul><li><a href='/jp/privacy/'>プライバシー</a></li></ul></footer>",
			].join("");
			expect(await parse(html)).toEqual([
				{
					url: "https://www.yuden.co.jp/jp/ir/pdf/tanshin.pdf",
					title: "2027年3月期 第2四半期決算短信",
					date: "2026-11-05",
					category: "earnings",
				},
				{
					url: "https://www.yuden.co.jp/jp/ir/pdf/setsumei.pdf",
					title: "決算説明資料",
					date: "2026-11-05",
					category: "earnings",
				},
				{
					url: "https://www.yuden.co.jp/jp/ir/news/a.html",
					title: "自己株式の取得状況に関するお知らせ",
					date: "2026-10-20",
					category: "ir",
				},
			]);
		});

		it("リンク文言が PDF 等のときは li のテキストを見出しにする", async () => {
			const html = [
				"<ul>",
				"<li><span>2026/08/05</span><p>通期業績予想の修正に関するお知らせ</p>",
				"<a href='/jp/ir/pdf/rev.pdf'>PDF</a></li>",
				"</ul>",
			].join("");
			expect(await parse(html)).toEqual([
				{
					url: "https://www.yuden.co.jp/jp/ir/pdf/rev.pdf",
					title: "通期業績予想の修正に関するお知らせ",
					date: "2026-08-05",
					category: "earnings",
				},
			]);
		});

		it("div だけの一覧は次の日付で項目を切る", async () => {
			const html = [
				"<div><span>2026-11-05</span><a href='/a.pdf'>決算短信</a></div>",
				"<div><span>2026-10-01</span><a href='/b.html'>役員人事</a></div>",
			].join("");
			const out = await parse(html);
			expect(out.map((i) => [i.url, i.date])).toEqual([
				["https://www.yuden.co.jp/a.pdf", "2026-11-05"],
				["https://www.yuden.co.jp/b.html", "2026-10-01"],
			]);
		});

		it("日付の無いブロック・ページ内リンク・重複 URL は捨てる", async () => {
			const html = [
				"<ul><li><a href='/jp/ir/stock/'>株式情報</a></li></ul>",
				"<ul><li>2026年7月1日 <a href='#top'>ページ先頭</a>",
				"<a href='/x.pdf'>決算短信</a><a href='/x.pdf'>決算短信</a></li></ul>",
			].join("");
			expect((await parse(html)).map((i) => i.url)).toEqual([
				"https://www.yuden.co.jp/x.pdf",
			]);
		});

		it("「2027年3月期」のような日の無い年月は日付にしない", async () => {
			const html =
				"<ul><li><a href='/y.pdf'>2027年3月期 決算短信</a></li></ul>";
			expect(await parse(html)).toEqual([]);
		});
	});

	describe("parseList: 未知 site", () => {
		it("空配列を返す", async () => {
			expect(await parseList("unknown", "<html></html>", "")).toEqual([]);
		});
	});

	describe("parseKioxiaArticle", () => {
		it("h1 を title、main を body に取り空白を畳む", async () => {
			const html = "<h1>新製品リリース</h1><main>本文   行1\n\n\n\n行2</main>";
			const r = await parseKioxiaArticle(html);
			expect(r.title).toBe("新製品リリース");
			expect(r.body).toBe("本文 行1\n\n行2");
		});
	});
}
