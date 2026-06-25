// Cloudflare Worker: 公式IRページの site 別一覧パーサ群。
//
// site ごとに一覧の構造が違うので parseList() で振り分ける。kioxia だけ記事本文HTMLが
// 安定して取れるので本文取得する (collectOne の fetchBody 相当)。他3社の記事リンクは
// IRカレンダー/PDFラッパーで本文HTMLが取れないため、disclosure.ts と同様「一覧のタイトル」を
// 本文として保存する。適時開示はタイトルだけで「何が起きたか」は判定材料になる。
//
// IR_SOURCES (どの銘柄を・どの URL で・どの site パーサで読むか) の定義は watchlist.ts に集約済み。
// ここからは re-export するだけ。新しい site を足すときは下記パーサを追加し、watchlist.ts の
// ticker.ir.site をそのキーにする。

import * as cheerio from "cheerio";
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
function parseKioxiaList(html: string, baseUrl: string): ListItem[] {
	const $ = cheerio.load(html);
	const out: ListItem[] = [];
	const seenUrl = new Set<string>();
	$("a.cmp-button").each((_, a) => {
		const href = $(a).attr("href");
		if (!href) return;
		const url = new URL(href, baseUrl).toString();
		const date = dateFromUrl(url);
		if (!date) return;
		if (seenUrl.has(url)) return;
		seenUrl.add(url);
		const title =
			$(a).find(".cmp-button__text").text().trim() || $(a).text().trim();
		if (!title) return;
		out.push({ url, title, date, category: categoryFromUrl(url) });
	});
	return out;
}

// アドバンテスト ニュース一覧 (https://www.advantest.com/ja/news/)。
//   各記事は <li class="m-list-news__item">。
//     リンク : a.m-list-news__wrapper の href (HTMLページ or PDF or /ja/investors/...)
//     日付   : time.m-list-news__date の datetime="YYYY-MM-DD"
//     カテゴリ: b.m-list-news__category (例「投資家の皆様へ」)
//     タイトル: p.m-text__item
//   本文は取らない (リンク先がPDF/カレンダーで一定しないため)。category はそのまま日本語で持つ。
function parseAdvantestList(html: string, baseUrl: string): ListItem[] {
	const $ = cheerio.load(html);
	const out: ListItem[] = [];
	const seenUrl = new Set<string>();
	$("li.m-list-news__item").each((_, li) => {
		const $li = $(li);
		const a = $li.find("a.m-list-news__wrapper").first();
		const href = a.attr("href");
		if (!href) return;
		const url = new URL(href, baseUrl).toString();
		if (seenUrl.has(url)) return;
		const date = $li.find("time.m-list-news__date").attr("datetime")?.trim();
		if (!date) return;
		const title = $li.find("p.m-text__item").first().text().trim();
		if (!title) return;
		seenUrl.add(url);
		const category = $li.find("b.m-list-news__category").first().text().trim();
		out.push({ url, title, date, category: category || "advantest" });
	});
	return out;
}

// レーザーテック ニュース一覧 (https://www.lasertec.co.jp/news/ → 当年ページにリダイレクト)。
//   各記事は <article class="news__article">。
//     リンク : a.news__type の href (/news/YYYY/...html)
//     日付   : time.news__date の datetime="YYYY-MM-DD"
//     カテゴリ: i.util-badge--news (例「ニュース」「IR」)
//     タイトル: h3.news__title (子の <i class="news__filesize"> は除く)
//   list_url は当年のみ表示。新着順に拾えれば足りるので当年で十分。本文は取らない。
function parseLasertecList(html: string, baseUrl: string): ListItem[] {
	const $ = cheerio.load(html);
	const out: ListItem[] = [];
	const seenUrl = new Set<string>();
	$("article.news__article").each((_, art) => {
		const $art = $(art);
		const a = $art.find("a.news__type").first();
		const href = a.attr("href");
		if (!href) return;
		const url = new URL(href, baseUrl).toString();
		if (seenUrl.has(url)) return;
		const date = $art.find("time.news__date").attr("datetime")?.trim();
		if (!date) return;
		const $title = $art.find("h3.news__title").first().clone();
		$title.find("i").remove();
		const title = $title.text().trim();
		if (!title) return;
		seenUrl.add(url);
		const category =
			$art.find(".news__category").first().text().trim() || "lasertec";
		out.push({ url, title, date, category });
	});
	return out;
}

// RFC822 日付 ("Thu, 11 Jun 2026 00:00:00 +0900") の暦日部分を YYYY-MM-DD にする。
// new Date() を経由しないのでタイムゾーン補正で日付がずれない (RSS の表記日をそのまま使う)。
const RFC822_MONTHS: Record<string, string> = {
	Jan: "01",
	Feb: "02",
	Mar: "03",
	Apr: "04",
	May: "05",
	Jun: "06",
	Jul: "07",
	Aug: "08",
	Sep: "09",
	Oct: "10",
	Nov: "11",
	Dec: "12",
};
function rfc822ToYmd(raw: string): string {
	const m = raw.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
	if (!m) return "";
	const mon = RFC822_MONTHS[m[2]];
	if (!mon) return "";
	return `${m[3]}-${mon}-${m[1].padStart(2, "0")}`;
}

// 村田製作所 IRニュース RSS (rssfeed)。<item> ごとに link/title/pubDate。
//   pubDate は RFC822 (JST 表記) → rfc822ToYmd で JST 暦日のまま YYYY-MM-DD に正規化。
//   title 末尾の " (PDF: 241KB)" は残してよい (種別の手がかり)。カテゴリは IRニュース固定。
//   cheerio を xmlMode で読むと item/link/pubDate を素直に取れる。本文は取らない。
function parseMurataRss(xml: string): ListItem[] {
	const $ = cheerio.load(xml, { xmlMode: true });
	const out: ListItem[] = [];
	const seenUrl = new Set<string>();
	$("item").each((_, item) => {
		const $item = $(item);
		const url = $item.find("link").first().text().trim();
		const title = $item.find("title").first().text().trim();
		if (!url || !title) return;
		if (seenUrl.has(url)) return;
		// pubDate は RFC822 で JST 表記 ("Thu, 11 Jun 2026 00:00:00 +0900")。
		// new Date() に通すと UTC に寄って暦日が1日ずれる (6/11 00:00 JST → 6/10 UTC) ため、
		// 文字列から "DD Mon YYYY" を直接拾って JST の暦日を保つ。
		const pub = $item.find("pubDate").first().text().trim();
		const date = rfc822ToYmd(pub);
		if (!date) return;
		seenUrl.add(url);
		out.push({ url, title, date, category: "irnews" });
	});
	return out;
}

// site → 一覧パーサ。一覧HTML(/XML) から ListItem[] を返す。
export function parseList(
	site: string,
	body: string,
	baseUrl: string,
): ListItem[] {
	switch (site) {
		case "kioxia":
			return parseKioxiaList(body, baseUrl);
		case "advantest":
			return parseAdvantestList(body, baseUrl);
		case "lasertec":
			return parseLasertecList(body, baseUrl);
		case "murata":
			return parseMurataRss(body);
		default:
			return [];
	}
}

export function parseKioxiaArticle(html: string): {
	title: string;
	body: string;
} {
	const $ = cheerio.load(html);
	const title = $("h1").first().text().trim() || $("title").text().trim();
	const body =
		$("main").text().trim() ||
		$("article").text().trim() ||
		$(".cmp-text").text().trim() ||
		$("body").text().trim();
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

	describe("rfc822ToYmd", () => {
		it("RFC822 の暦日部分を JST 表記のまま YYYY-MM-DD にする", () => {
			expect(rfc822ToYmd("Thu, 11 Jun 2026 00:00:00 +0900")).toBe("2026-06-11");
		});
		it("1桁日もゼロ埋めする", () => {
			expect(rfc822ToYmd("Mon, 1 Sep 2025 00:00:00 +0900")).toBe("2025-09-01");
		});
		it("月名不正・形式不正は空文字", () => {
			expect(rfc822ToYmd("11 Xxx 2026")).toBe("");
			expect(rfc822ToYmd("invalid")).toBe("");
		});
	});

	describe("parseList: kioxia", () => {
		it("a.cmp-button から URL・タイトル・日付・カテゴリを抽出し重複URLを除く", () => {
			const html = [
				"<a class='cmp-button' href='/ja-jp/about/news/20260611-1.html'><span class='cmp-button__text'>新製品</span></a>",
				"<a class='cmp-button' href='/ja-jp/about/news/20260611-1.html'><span class='cmp-button__text'>重複</span></a>",
				"<a class='cmp-button' href='/ja-jp/news.html'><span class='cmp-button__text'>日付なしは除外</span></a>",
			].join("");
			const out = parseList("kioxia", html, "https://www.kioxia.com");
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
		it("li.m-list-news__item から datetime・タイトル・カテゴリを取る", () => {
			const html = [
				"<li class='m-list-news__item'>",
				"<a class='m-list-news__wrapper' href='/ja/news/a.html'>",
				"<time class='m-list-news__date' datetime='2026-06-10'></time>",
				"<b class='m-list-news__category'>投資家の皆様へ</b>",
				"<p class='m-text__item'>決算説明会</p>",
				"</a></li>",
			].join("");
			expect(parseList("advantest", html, "https://www.advantest.com")).toEqual(
				[
					{
						url: "https://www.advantest.com/ja/news/a.html",
						title: "決算説明会",
						date: "2026-06-10",
						category: "投資家の皆様へ",
					},
				],
			);
		});
	});

	describe("parseList: lasertec", () => {
		it("article.news__article からタイトル (子の i を除く) を取る", () => {
			const html = [
				"<article class='news__article'>",
				"<a class='news__type' href='/news/2026/a.html'></a>",
				"<time class='news__date' datetime='2026-06-09'></time>",
				"<span class='news__category'>IR</span>",
				"<h3 class='news__title'>決算短信<i class='news__filesize'>(PDF)</i></h3>",
				"</article>",
			].join("");
			expect(parseList("lasertec", html, "https://www.lasertec.co.jp")).toEqual(
				[
					{
						url: "https://www.lasertec.co.jp/news/2026/a.html",
						title: "決算短信",
						date: "2026-06-09",
						category: "IR",
					},
				],
			);
		});
	});

	describe("parseList: murata (RSS)", () => {
		it("item の link/title/pubDate(RFC822) を JST 暦日のまま正規化する", () => {
			const xml = [
				"<rss><channel>",
				"<item><link>https://corporate.murata.com/ja-jp/x</link>",
				"<title>業績予想の修正 (PDF: 241KB)</title>",
				"<pubDate>Thu, 11 Jun 2026 00:00:00 +0900</pubDate></item>",
				"</channel></rss>",
			].join("");
			expect(parseList("murata", xml, "")).toEqual([
				{
					url: "https://corporate.murata.com/ja-jp/x",
					title: "業績予想の修正 (PDF: 241KB)",
					date: "2026-06-11",
					category: "irnews",
				},
			]);
		});
	});

	describe("parseList: 未知 site", () => {
		it("空配列を返す", () => {
			expect(parseList("unknown", "<html></html>", "")).toEqual([]);
		});
	});

	describe("parseKioxiaArticle", () => {
		it("h1 を title、main を body に取り空白を畳む", () => {
			const html = "<h1>新製品リリース</h1><main>本文   行1\n\n\n\n行2</main>";
			const r = parseKioxiaArticle(html);
			expect(r.title).toBe("新製品リリース");
			expect(r.body).toBe("本文 行1\n\n行2");
		});
	});
}
