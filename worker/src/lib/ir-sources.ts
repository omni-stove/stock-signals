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

import { firstText, queryAll, scanHtml } from "./html";
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

// irpocket (マジカルポケット社の IR 配信) の JSONP。`window.ir20handler({ "item": [...] });` の形で、
// IR ページ (太陽誘電 https://www.yuden.co.jp/jp/ir/news/ 等) はこれを JS で描画するため HTML に一覧が無い。
type IrpocketItem = { published?: string; title?: string; link?: string };

// irpocket の JSONP から一覧を読む。published の日付部分を date に、link (//pdf.irpocket.com/…) を
// baseUrl の scheme で絶対 URL にする。category は決算系の見出しなら "earnings"、それ以外は "ir"。
// JSONP の形が崩れていたら空配列 (= パース0件として警告に乗る)。
function parseIrpocketList(body: string, baseUrl: string): ListItem[] {
	const m = body.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
	if (!m) return [];
	let items: IrpocketItem[];
	try {
		items = (JSON.parse(m[1]) as { item?: IrpocketItem[] }).item ?? [];
	} catch {
		return [];
	}
	const out: ListItem[] = [];
	const seenUrl = new Set<string>();
	for (const it of items) {
		const date = it.published?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
		const title = it.title?.replace(/\s+/g, " ").trim();
		if (!date || !title || !it.link) continue;
		let url: string;
		try {
			url = new URL(it.link, baseUrl).toString();
		} catch {
			continue;
		}
		if (seenUrl.has(url)) continue;
		seenUrl.add(url);
		out.push({
			url,
			title,
			date,
			category: isEarningsDisclosure(title) ? "earnings" : "ir",
		});
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
		case "irpocket":
			return parseIrpocketList(body, baseUrl);
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

	describe("parseList: irpocket", () => {
		const BASE = "https://xml.irpocket.com/6976/JS/release-all-latest-12m.js";
		const jsonp = (items: unknown[]) =>
			`// 注記\nwindow.ir20handler(${JSON.stringify({ item: items })});\n`;

		it("published の日付と link の絶対 URL を取り、決算系を earnings にする", async () => {
			const body = jsonp([
				{
					published: "2026-11-05 15:30:00",
					category_name: "決算短信",
					title:
						"2027年３月期　第２四半期（中間期）決算短信〔日本基準〕（連結）",
					link: "//pdf.irpocket.com/C6976/a/b.pdf",
				},
				{
					published: "2026-09-29 16:30:00",
					category_name: "プレスリリース",
					title: "TDK株式会社との業務提携に係る基本合意書締結に関するお知らせ",
					link: "//pdf.irpocket.com/C6976/c/d.pdf",
				},
			]);
			expect(await parseList("irpocket", body, BASE)).toEqual([
				{
					url: "https://pdf.irpocket.com/C6976/a/b.pdf",
					title:
						"2027年３月期 第２四半期（中間期）決算短信〔日本基準〕（連結）",
					date: "2026-11-05",
					category: "earnings",
				},
				{
					url: "https://pdf.irpocket.com/C6976/c/d.pdf",
					title: "TDK株式会社との業務提携に係る基本合意書締結に関するお知らせ",
					date: "2026-09-29",
					category: "ir",
				},
			]);
		});

		it("日付・見出し・link の無い項目と重複 URL は捨てる", async () => {
			const body = jsonp([
				{ published: "", title: "日付なし", link: "//pdf.irpocket.com/x.pdf" },
				{ published: "2026-07-01 13:28:00", title: "link なし" },
				{
					published: "2026-07-01 13:25:00",
					title: "臨時報告書",
					link: "//pdf.irpocket.com/y.pdf",
				},
				{
					published: "2026-07-01 13:25:00",
					title: "臨時報告書",
					link: "//pdf.irpocket.com/y.pdf",
				},
			]);
			expect(
				(await parseList("irpocket", body, BASE)).map((i) => i.url),
			).toEqual(["https://pdf.irpocket.com/y.pdf"]);
		});

		it("JSONP でなければ空配列", async () => {
			expect(await parseList("irpocket", "<html></html>", BASE)).toEqual([]);
			expect(await parseList("irpocket", "f({broken)", BASE)).toEqual([]);
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
