// kabutan の記事一覧テーブル (table.s_news_list) の共通パーサ。
// 銘柄ニュース (news.ts) / 市場ニュース (market-news.ts) / 適時開示 (disclosure.ts) の
// 一覧はいずれも同一構造なので、行の抽出はここに一本化する (DOM 変更時の修正箇所も1つ)。
// 記事本文ページの DOM は用途ごとに異なるため、本文パーサは各モジュールに残る。

import * as cheerio from "cheerio";

export interface KabutanListItem {
	url: string;
	title: string;
	date: string;
}

// 一覧 (table.s_news_list の各 tr) を抽出。a リンクの無い行 (ヘッダ等) は除外し、
// 相対 href は baseUrl で絶対 URL に解決する。date は time 要素 (無ければ先頭 td) の生文字列。
export function parseKabutanNewsList(
	html: string,
	baseUrl: string,
): KabutanListItem[] {
	const $ = cheerio.load(html);
	const out: KabutanListItem[] = [];
	$("table.s_news_list tr").each((_, tr) => {
		const $tr = $(tr);
		const a = $tr.find("a").first();
		const href = a.attr("href");
		if (!href) return;
		const url = new URL(href, baseUrl).toString();
		const title = a.text().trim();
		const date =
			$tr.find("time").first().text().trim() ||
			$tr.find("td").first().text().trim();
		if (title) out.push({ url, title, date });
	});
	return out;
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

		it("相対hrefを絶対URLに解決しタイトル・日付 (生文字列) を拾う", () => {
			expect(parseKabutanNewsList(html, BASE)).toEqual([
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
		it("aリンクの無い行 (ヘッダ等) は除外する", () => {
			expect(parseKabutanNewsList(html, BASE)).toHaveLength(2);
		});
	});
}
