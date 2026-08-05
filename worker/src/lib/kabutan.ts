// kabutan の記事一覧テーブル (table.s_news_list) の共通パーサ。
// 銘柄ニュース (news.ts) / 市場ニュース (market-news.ts) / 適時開示 (disclosure.ts) の
// 一覧はいずれも同一構造なので、行の抽出はここに一本化する (DOM 変更時の修正箇所も1つ)。
// 記事本文ページの DOM は用途ごとに異なるため、本文パーサは各モジュールに残る。
//
// 各パーサは HTMLRewriter (html.ts) の前に対象ブロックを切り出す (utils の
// sliceHtml/sliceTables 参照)。ネイティブパースでも流すバイト数は少ないほど安い。

import { scanTables, tablesWithClass } from "./html";
import { sliceHtml, sliceTables } from "./utils";

export interface KabutanListItem {
	url: string;
	title: string;
	date: string;
}

// 一覧 (table.s_news_list の各 tr) を抽出。a リンクの無い行 (ヘッダ等) は除外し、
// 相対 href は baseUrl で絶対 URL に解決する。date は time 要素 (無ければ先頭 td) の生文字列。
export async function parseKabutanNewsList(
	html: string,
	baseUrl: string,
): Promise<KabutanListItem[]> {
	const tables = await scanTables(sliceTables(html, "s_news_list") ?? html);
	const out: KabutanListItem[] = [];
	for (const t of tablesWithClass(tables, "s_news_list")) {
		for (const { cells } of t.rows) {
			// 行内最初の a (href 必須)。
			const linkCell = cells.find((c) => c.aHref !== null || c.aText !== "");
			if (!linkCell?.aHref) continue;
			const url = new URL(linkCell.aHref, baseUrl).toString();
			const title = linkCell.aText.trim();
			const timeCell = cells.find((c) => c.timeText !== "");
			const date =
				timeCell?.timeText ??
				cells.find((c) => c.tag === "td")?.text.trim() ??
				"";
			if (title) out.push({ url, title, date });
		}
	}
	return out;
}

// 現値ページ (個別銘柄・指数共通) の株価情報ブロックを切り出す。
// #stockinfo_i1 (時刻) から .si_i1_2 (現値/前日比) を経て、個別銘柄ページでは最初の
// 出来高テーブルの閉じタグまで。指数ページ (code=0000 等) には出来高テーブルが無いので
// 固定 12KB 窓で切る (si_i1 ブロックは先頭 1KB 程度に収まる)。マーカーが無ければ全文を返す。
export function sliceStockInfo(html: string): string {
	const anchor = html.indexOf("stockinfo_i1");
	if (anchor < 0) return html;
	const start = html.lastIndexOf("<", anchor);
	const vol = html.indexOf("出来高", anchor);
	const tableEnd = vol >= 0 ? html.indexOf("</table>", vol) : -1;
	const end = tableEnd >= 0 ? tableEnd + "</table>".length : start + 12_000;
	return html.slice(start, end);
}

// 記事本文ページの <article> ブロック (+<title>) を切り出す。requiredMarkers (本文抽出の
// セレクタが目印にする id/class) のどれかが「ページには有るのにフラグメントに無い」= 対象が
// article 外にあるレイアウトでは、切らずに全文を返す (欠測より正確さ優先)。
export function sliceArticle(html: string, requiredMarkers: string[]): string {
	const s = html.indexOf("<article");
	const e = s >= 0 ? html.indexOf("</article>", s) : -1;
	if (e < 0) return html;
	const title = sliceHtml(html, "<title", "</title>") ?? "";
	const frag = title + html.slice(s, e + "</article>".length);
	for (const m of requiredMarkers) {
		if (!frag.includes(m) && html.includes(m)) return html;
	}
	return frag;
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;
	const BASE = "https://kabutan.jp/stock/news?code=285A";

	describe("parseKabutanNewsList", () => {
		const html = [
			"<table class='s_news_list'>",
			"<tr><td><time>06/18</time></td><td><a href='/news/marketnews/?b=n1'>業績上方修正</a></td></tr>",
			"<tr><td><time>26/05/29 17:00</time></td><td><a href='https://kabutan.jp/news/?b=n2'>新製品発表</a></td></tr>",
			"<tr><td>ヘッダ行 (aなし)</td></tr>",
			"</table>",
		].join("");

		it("相対hrefを絶対URLに解決しタイトル・日付 (生文字列) を拾う", async () => {
			expect(await parseKabutanNewsList(html, BASE)).toEqual([
				{
					url: "https://kabutan.jp/news/marketnews/?b=n1",
					title: "業績上方修正",
					date: "06/18",
				},
				{
					url: "https://kabutan.jp/news/?b=n2",
					title: "新製品発表",
					date: "26/05/29 17:00",
				},
			]);
		});
		it("aリンクの無い行 (ヘッダ等) は除外する", async () => {
			expect(await parseKabutanNewsList(html, BASE)).toHaveLength(2);
		});
		it("一覧テーブルの前後に別テーブルがあっても対象だけを読む (切り出し確認)", async () => {
			const page = `<table class='nav'><tr><td><a href='/x'>menu</a></td></tr></table>${html}`;
			expect(await parseKabutanNewsList(page, BASE)).toHaveLength(2);
		});
		it("time が無い行は先頭 td のテキストを日付に使う", async () => {
			const page =
				"<table class='s_news_list'><tr><td>06/19</td><td><a href='/n3'>題</a></td></tr></table>";
			expect(await parseKabutanNewsList(page, BASE)).toEqual([
				{ url: "https://kabutan.jp/n3", title: "題", date: "06/19" },
			]);
		});
	});

	describe("sliceStockInfo", () => {
		it("株価ブロックから出来高テーブルの閉じまでを切り出す", () => {
			const page = [
				"<header>huge nav</header>",
				'<div id="stockinfo_i1"><time datetime="2026-07-09T15:30+09:00"></time></div>',
				'<div class="si_i1_2"><span class="kabuka">29,160円</span></div>',
				"<table><tbody><tr><th>出来高</th><td>8,863,600株</td></tr></tbody></table>",
				"<div>rest of page</div>",
			].join("\n");
			const frag = sliceStockInfo(page);
			expect(frag).toContain("stockinfo_i1");
			expect(frag).toContain("kabuka");
			expect(frag).toContain("出来高");
			expect(frag).not.toContain("rest of page");
			expect(frag).not.toContain("huge nav");
		});
		it("出来高テーブルの無い指数ページは 12KB 窓で切る", () => {
			const page = `<nav>x</nav><div id="stockinfo_i1"></div><div class="si_i1_2"><span class="kabuka">67,743</span></div>${"z".repeat(20_000)}`;
			const frag = sliceStockInfo(page);
			expect(frag).toContain("kabuka");
			expect(frag.length).toBeLessThanOrEqual(12_000);
			expect(frag).not.toContain("<nav>");
		});
		it("マーカーが無ければ全文を返す", () => {
			expect(sliceStockInfo("<p>no marker</p>")).toBe("<p>no marker</p>");
		});
	});

	describe("sliceArticle", () => {
		const page = [
			"<head><title>見出し | 株探</title></head>",
			"<header>nav</header>",
			'<article><h1>見出し</h1><time class="s_news_date" datetime="2026-07-10T09:00:00+09:00"></time><div class="body">本文</div></article>',
			"<footer>f</footer>",
		].join("");

		it("<article> と <title> だけを残す", () => {
			const frag = sliceArticle(page, ["s_news_date"]);
			expect(frag).toContain("<article>");
			expect(frag).toContain("<title>");
			expect(frag).toContain("本文");
			expect(frag).not.toContain("<footer>");
		});
		it("目印が article 外にあるページは全文を返す", () => {
			const outside = `<div id="news_contents"><h2>枠外</h2></div>${page}`;
			expect(sliceArticle(outside, ["news_contents"])).toBe(outside);
		});
		it("<article> が無ければ全文を返す", () => {
			expect(sliceArticle("<p>x</p>", [])).toBe("<p>x</p>");
		});
	});
}
