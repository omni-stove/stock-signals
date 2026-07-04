// Cloudflare Worker: 市場テーマニュース収集 (kabutan 市場ニュース総合 + ITmedia AI+ RSS)
//
// 銘柄ページ (news.ts) に載らない市場全体・テーマニュースを拾う。半導体/AI/金利/米国市場の
// テーマに当たった見出しだけを market_news テーブル + R2 に保存し、地合い判定 (market-check) が
// /market-context 経由で最新数件を読む。新規見出しに watchlist 銘柄の言及 (matchTickers) が
// あれば freshTickers として返し、個別判定 (signal-report) の起動にも使う。
//   source は持たない (銘柄非依存)。重複排除は market_news.url PK + INSERT OR IGNORE。
//
// 収集元は2系統:
//   - kabutan 市場ニュース総合 (国内市況・材料が中心)。HTML をスクレイプし記事本文も取る。
//   - ITmedia AI+ RSS (OpenAI/Anthropic/Gemini 等の海外AI企業動向を日本語で直接カバー)。
//     kabutan は AI 企業の単独動向を従属句でしか扱わず新着リスト依存で取りこぼすため、これを補完。
//     RSS は item に title/link/description/pubDate が揃うので、本文 = description を使い記事再取得は不要。
//
// kabutan 記事ページは銘柄ニュース (news.ts) と DOM が異なる:
//   タイトル = article h1 (【市況】等のカテゴリ接頭辞付き)、本文 = article .body、
//   日付 = time.s_news_date[datetime] (これは銘柄ニュースと共通)。
// 銘柄ニュース用 parseKabutanArticle は #shijyo_news_text / h1.pdbt0 を見るため流用できない。

import * as cheerio from "cheerio";
import { inArray } from "drizzle-orm";
import { db } from "./db";
import { parseKabutanNewsList } from "./kabutan";
import { marketNews } from "./schema";
import { fetchHtml, hash, normArticleDate, sleep } from "./utils";
import { matchTickers } from "./watchlist";

export interface MarketNewsEnv {
	DB: D1Database;
	ARTICLES: R2Bucket;
	USER_AGENT: string;
	MIN_INTERVAL_MS: string;
}

const URL_LIST = "https://kabutan.jp/news/marketnews/";
// 海外AI企業動向の補完 RSS (OpenAI/Anthropic/Gemini 等を日本語見出しで直接カバー)。
const URL_AIPLUS_RSS = "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml";

// 一覧から本文取得する最大件数 (新しい順、topic 一致後)。場中の連投を避けるため控えめに。
const NEWS_LIMIT = 12;

// topic フィルタ。タイトルにキーワードが当たった記事だけ拾う (総取りはノイズ過多・銘柄収集と重複)。
// 複数 topic に当たりうるので、当たった key を "," 連結で持つ。判定は小文字化して部分一致。
const TOPIC_KEYWORDS: { key: string; words: string[] }[] = [
	{
		key: "semi",
		words: [
			"半導体",
			"sox",
			"フィラデルフィア半導体",
			"tsmc",
			"nvidia",
			"エヌビディア",
			"hbm",
			"メモリ",
			"dram",
			"nand",
			"asml",
			"露光",
			"ファウンドリ",
			"マイクロン",
			"micron",
			"サムスン",
		],
	},
	{
		key: "ai",
		words: [
			// 一般語 (日本語見出しの「AI関連」「生成AI」等)。英語の "ai" 単独は
			// maiko/raise 等への誤爆が多いため入れず、固有名・複合語で拾う。
			"生成ai",
			"ai関連",
			"aiブーム",
			"ai投資",
			"ai需要",
			"データセンター",
			"gpu",
			// 主要 AI 企業 (非上場・海外含む) とその製品名。
			"openai",
			"オープンai",
			"chatgpt",
			"anthropic",
			"アンスロピック",
			"claude",
			"クロード",
			"gemini",
			"ジェミニ",
			"copilot",
			"コパイロット",
			"deepmind",
			"ディープマインド",
			"xai",
			"grok",
			"グロック",
			"mistral",
			"ミストラル",
			"perplexity",
			"パープレキシティ",
			"deepseek",
			"ディープシーク",
			"meta ai",
			"llama",
			"ラマ",
		],
	},
	{
		key: "rates",
		words: [
			"fomc",
			"利上げ",
			"利下げ",
			"金利",
			"日銀",
			"パウエル",
			"cpi",
			"雇用統計",
			"frb",
			"frc",
			"インフレ",
			"pce",
		],
	},
	{
		key: "us",
		words: [
			"米国株",
			"ナスダック",
			"nasdaq",
			"s&p",
			"sp500",
			"ダウ",
			"米株",
			"ny株",
			"米市場",
		],
	},
	{
		// 相場全体の市況見出し (当日の地合いそのもの)。指数を語る見出しに絞る。
		// 「前場/後場」単独は注目銘柄ダイジェストや GC/DC 集計まで巻き込むため入れない。
		key: "market",
		words: [
			"東京株式",
			"日経平均",
			"日経２２５",
			"日経225",
			"topix",
			"株価指数先物",
			"日経225先物",
			"前引け",
			"大引け",
			"寄り付き",
		],
	},
];

// タイトルに当たった topic タグを "," 連結で返す。1つも当たらなければ null (= 保存しない)。
function matchTopics(title: string): string | null {
	const t = title.toLowerCase();
	const hit = TOPIC_KEYWORDS.filter((g) => g.words.some((w) => t.includes(w)));
	return hit.length > 0 ? hit.map((g) => g.key).join(",") : null;
}

// RSS 2.0 の <item> を url/title/date/body に抽出 (cheerio の xmlMode)。ITmedia AI+ 用。
// body は description をそのまま使う (記事ページ再取得は不要)。date は pubDate を YYYY-MM-DD に正規化。
function parseRss(
	xml: string,
): { url: string; title: string; date: string; body: string }[] {
	const $ = cheerio.load(xml, { xmlMode: true });
	const out: { url: string; title: string; date: string; body: string }[] = [];
	$("item").each((_, el) => {
		const $it = $(el);
		const url = $it.find("link").first().text().trim();
		const title = $it.find("title").first().text().trim();
		if (!url || !title) return;
		out.push({
			url,
			title,
			date: rssDate($it.find("pubDate").first().text().trim()),
			body: $it.find("description").first().text().trim(),
		});
	});
	return out;
}

// RFC822 pubDate ("Fri, 26 Jun 2026 13:35:00 +0900") を YYYY-MM-DD に正規化。取れなければ "unknown"。
// Date.now/new Date(無引数) と違い引数つき new Date は使えるので Date でパースする。
function rssDate(raw: string): string {
	const ms = Date.parse(raw);
	if (Number.isNaN(ms)) return "unknown";
	return new Date(ms).toISOString().slice(0, 10);
}

// 市場ニュースの記事本文ページを抽出 (銘柄ニュースと DOM が異なる、冒頭コメント参照)。
function parseArticle(html: string): {
	title: string;
	body: string;
	published_at: string;
} {
	const $ = cheerio.load(html);
	// 本文コンテナは #shijyounews article。タイトルは article h1 (【市況】等の接頭辞付き)、
	// 本文は article .body。フォールバックは article 全文 → <title>。
	const $art = $("#shijyounews article").first();
	const scope = $art.length ? $art : $("article").first();
	const title =
		scope.find("h1").first().text().trim() ||
		$("h1").first().text().trim() ||
		$("title").text().trim();
	const body = scope.find(".body").first().text().trim() || scope.text().trim();
	const published_at =
		$("time.s_news_date").first().attr("datetime") ||
		$('time[itemprop="datePublished"]').first().attr("datetime") ||
		$("time.s_news_date").first().text().trim();
	return { title, body: body.replace(/\s+\n/g, "\n").trim(), published_at };
}

// urls のうち既に market_news に存在するものの集合 (重複排除用)。IN 句でまとめて引く。
async function seenMarketUrls(
	env: MarketNewsEnv,
	urls: string[],
): Promise<Set<string>> {
	if (urls.length === 0) return new Set();
	const rows = await db(env.DB)
		.select({ url: marketNews.url })
		.from(marketNews)
		.where(inArray(marketNews.url, urls))
		.all();
	return new Set(rows.map((r) => r.url));
}

async function saveArticle(
	env: MarketNewsEnv,
	meta: {
		url: string;
		title: string;
		topic: string;
		published_at: string;
		body: string;
	},
): Promise<void> {
	const fetched_at = new Date().toISOString();
	const r2_key = `market/${meta.published_at}-${hash(meta.url)}.json`;
	const payload = JSON.stringify(
		{ ...meta, source: "kabutan:market", fetched_at },
		null,
		2,
	);
	await env.ARTICLES.put(r2_key, payload, {
		httpMetadata: { contentType: "application/json" },
	});
	await db(env.DB)
		.insert(marketNews)
		.values({
			url: meta.url,
			title: meta.title,
			topic: meta.topic,
			publishedAt: meta.published_at,
			r2Key: r2_key,
			fetchedAt: fetched_at,
		})
		.onConflictDoNothing()
		.run();
}

// 今回新規保存した1記事のメタ (Slack 通知用)。
export type FreshMarketNews = {
	topic: string;
	title: string;
	url: string;
	date: string;
};

// 市場ニュース一覧を取り、topic 一致かつ未取得の記事だけ本文取得→保存。新規件数等と新規記事メタを返す。
// emptyParse は「kabutan 一覧が HTTP 200 なのにパース0件」(= DOM 変更で収集が静かに止まっている疑い)。
// freshTickers は今回新規の見出しに watchlist 銘柄の言及 (matchTickers: 名前/別名/keywords) が
// あった銘柄 (= テーマ級ヘッドラインでも個別 signal-report を起動する対象)。
export async function collectMarketNews(env: MarketNewsEnv): Promise<{
	found: number;
	matched: number;
	written: number;
	freshNews: FreshMarketNews[];
	freshTickers: string[];
	emptyParse: boolean;
}> {
	const listHtml = await fetchHtml(URL_LIST, env);
	const all = parseKabutanNewsList(listHtml, URL_LIST);
	// topic に当たったものだけを上限まで (新しい順に並んでいる前提)。
	const items = all
		.map((it) => ({ ...it, topic: matchTopics(it.title) }))
		.filter((it): it is typeof it & { topic: string } => it.topic !== null)
		.slice(0, NEWS_LIMIT);
	const seen = await seenMarketUrls(
		env,
		items.map((it) => it.url),
	);
	const interval = parseInt(env.MIN_INTERVAL_MS, 10) || 5000;
	let written = 0;
	const freshNews: FreshMarketNews[] = [];
	const freshTickers = new Set<string>();
	for (const it of items) {
		if (seen.has(it.url)) continue;
		await sleep(interval);
		try {
			const artHtml = await fetchHtml(it.url, env);
			const parsed = parseArticle(artHtml);
			const title = parsed.title || it.title;
			const date = normArticleDate(parsed.published_at || it.date, Date.now());
			await saveArticle(env, {
				url: it.url,
				title,
				topic: it.topic,
				published_at: date,
				body: parsed.body,
			});
			written++;
			freshNews.push({ topic: it.topic, title, url: it.url, date });
			for (const code of matchTickers(title)) freshTickers.add(code);
		} catch (e) {
			console.error(
				`market-news article error ${it.url}: ${(e as Error).message}`,
			);
		}
	}

	// ITmedia AI+ RSS を補完収集する。topic 一致 (主に ai) かつ未取得のものだけ保存。RSS は item に
	// title/link/description/pubDate が揃うので記事ページ再取得は不要 (本文 = description)。
	// 失敗しても kabutan 側の収集結果は壊さない (catch でログのみ)。
	let aiFound = 0;
	let aiMatched = 0;
	try {
		const rss = await fetchHtml(URL_AIPLUS_RSS, env);
		const rssItems = parseRss(rss);
		aiFound = rssItems.length;
		const aiHits = rssItems
			.map((it) => ({ ...it, topic: matchTopics(it.title) }))
			.filter((it): it is typeof it & { topic: string } => it.topic !== null)
			.slice(0, NEWS_LIMIT);
		aiMatched = aiHits.length;
		const seenAi = await seenMarketUrls(
			env,
			aiHits.map((it) => it.url),
		);
		for (const it of aiHits) {
			if (seenAi.has(it.url)) continue;
			try {
				await saveArticle(env, {
					url: it.url,
					title: it.title,
					topic: it.topic,
					published_at: it.date,
					body: it.body,
				});
				written++;
				freshNews.push({
					topic: it.topic,
					title: it.title,
					url: it.url,
					date: it.date,
				});
				for (const code of matchTickers(it.title)) freshTickers.add(code);
			} catch (e) {
				console.error(
					`market-news (aiplus) article error ${it.url}: ${(e as Error).message}`,
				);
			}
		}
	} catch (e) {
		console.error(`market-news aiplus rss error: ${(e as Error).message}`);
	}

	return {
		found: all.length + aiFound,
		matched: items.length + aiMatched,
		written,
		freshNews,
		freshTickers: [...freshTickers],
		emptyParse: all.length === 0,
	};
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("matchTopics", () => {
		it("テーマ語に当たれば topic タグを返す", () => {
			expect(matchTopics("韓国株6%安　オープンAI上場延期も重石")).toBe("ai");
			expect(matchTopics("東京株式（前引け）＝半導体に売り")).toBe(
				"semi,market",
			);
			expect(matchTopics("日銀、今月の利上げは見送りか")).toBe("rates");
			expect(matchTopics("東京株式（前引け）＝前日比２７６３円安")).toBe(
				"market",
			);
		});
		it("複数テーマに当たれば topic を順に連結する", () => {
			expect(matchTopics("米国株、半導体主導で上昇 ナスダック最高値")).toBe(
				"semi,us",
			);
		});
		it("テーマに当たらなければ null (= 保存対象外)", () => {
			expect(matchTopics("泉州電業 Research Memo（1）：電線の総合商社")).toBe(
				null,
			);
			expect(matchTopics("日本精鉱---譲渡制限付株式報酬で自己株式処分")).toBe(
				null,
			);
		});
		it("大文字小文字をまたいで部分一致する", () => {
			expect(matchTopics("NVIDIA決算受けSOX上昇")).toBe("semi");
		});
		it("主要AI企業の固有名 (非上場・海外含む) を ai topic で拾う", () => {
			expect(matchTopics("Anthropic、Claude次世代モデルを発表")).toBe("ai");
			expect(matchTopics("グーグルのGeminiが推論強化")).toBe("ai");
			expect(matchTopics("マイクロソフトCopilot、企業導入が加速")).toBe("ai");
			expect(matchTopics("xAIのGrokが新バージョン")).toBe("ai");
			expect(matchTopics("DeepSeek、低コストモデルで波紋")).toBe("ai");
		});
		it("英語 ai 単独は誤爆させない (固有名・複合語でのみ拾う)", () => {
			// "ai" 単独キーワードを廃したので、AI と無関係な英単語混じり見出しは ai にしない。
			expect(matchTopics("Maiko Industries、新工場を稼働")).toBeNull();
		});
	});

	describe("parseRss", () => {
		const xml = [
			'<?xml version="1.0" encoding="utf-8" ?>',
			'<rss version="2.0"><channel>',
			"<item>",
			"<title>OpenAI、GPT-5.5 Instant をアップデート</title>",
			"<link>https://www.itmedia.co.jp/news/articles/2606/26/news091.html</link>",
			"<description>OpenAI は GPT-5.5 を更新した。</description>",
			"<pubDate>Fri, 26 Jun 2026 13:35:00 +0900</pubDate>",
			"</item>",
			"<item>",
			"<title>link 欠落は除外される</title>",
			"<description>本文</description>",
			"</item>",
			"</channel></rss>",
		].join("");

		it("item から url/title/date(YYYY-MM-DD)/body を抽出する", () => {
			expect(parseRss(xml)).toEqual([
				{
					url: "https://www.itmedia.co.jp/news/articles/2606/26/news091.html",
					title: "OpenAI、GPT-5.5 Instant をアップデート",
					date: "2026-06-26",
					body: "OpenAI は GPT-5.5 を更新した。",
				},
			]);
		});
	});

	describe("rssDate", () => {
		it("RFC822 pubDate を YYYY-MM-DD に正規化する", () => {
			expect(rssDate("Fri, 26 Jun 2026 13:35:00 +0900")).toBe("2026-06-26");
		});
		it("パースできなければ unknown", () => {
			expect(rssDate("日付不明")).toBe("unknown");
		});
	});

	describe("parseArticle", () => {
		it("#shijyounews article から h1(接頭辞付き) と .body を拾う", () => {
			const html = [
				'<div id="shijyounews"><article>',
				'<time class="s_news_date" datetime="2026-06-26T11:47:00+09:00">26/06/26</time>',
				"<h1>【市況】韓国株6%安、オープンAI上場延期も重石</h1>",
				'<div class="body">韓国総合株価指数が大幅安。</div>',
				"</article></div>",
			].join("");
			const r = parseArticle(html);
			expect(r.title).toBe("【市況】韓国株6%安、オープンAI上場延期も重石");
			expect(r.body).toContain("韓国総合株価指数");
			expect(r.published_at).toBe("2026-06-26T11:47:00+09:00");
			expect(
				normArticleDate(
					r.published_at,
					new Date("2026-06-26T12:00:00Z").getTime(),
				),
			).toBe("2026-06-26");
		});
		it("article 直下に .body が無ければ article 全文へフォールバック", () => {
			const html = "<article><h1>T</h1>本文だけ</article>";
			expect(parseArticle(html).body).toContain("本文だけ");
		});
	});
}
