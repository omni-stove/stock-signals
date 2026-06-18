// Cloudflare Worker: 証券会社レーティング (個社別 目標株価) 収集 (kabutan レーティング日報)
//
// kabutan は全銘柄横断の「レーティング日報」記事を日次で出す。1日に複数種類:
//   【格上げ↑】【格下げ↓】【最上位を継続】【新規格付け】【弱気継続】
//   【最上位を継続＋目標株価を増額】 など。
// 各記事の本文は <br> 区切りのプレーンテキストで、以下の表になっている:
//   銘柄名 <コード> 　　 機関 　　 格付(旧→新) 　　 目標株価(旧→新) 　　 日付
//   例: いすゞ <7202> 　　 ＵＢＳ 　　 中立→買い 　　 2200→2700 　　 6/18
// 「機関」が証券会社名 (モルガン/みずほ/ＵＢＳ/野村/ＧＳ/ＪＰモル …)。末尾に短縮名の凡例が付く。
//
// 専用ページは銘柄単位では無く、日報記事1本に全銘柄が並ぶ。そこで:
//   1. watchlist 銘柄ニュースページ (disclosure.ts と同じ nmode=3) から当日の日報リンクを1つ発見
//   2. その記事の「関連記事」リンクから同日の日報を全種類収集 (1日5〜6本)
//   3. 各本文をパースし watchlist コードに一致する行だけ抽出
//   4. articles テーブルに source="rating:<firm>" / ir_category="rating" で保存
//      → /pull の ir 系カーソル (ir:% tdnet:% rating:%) に合流し、context-builder は無改修で読む
//
// 信頼できない機関は捨てず保存する (後でリストを変えても再取得不要)。TRUSTED_FIRMS に
// 載らない機関は body に「信頼度: 低」を明記し、判定LLM側で重み付けできるようにする。
//
// 重複排除は articles.url の PRIMARY KEY + INSERT OR IGNORE。URL は実記事URLだと
// 同一日報に複数銘柄が入り衝突するため、合成キー (rating://code/firm/date) を url 列に使う。
//
// watchlist 銘柄にレーティング変更があった日だけ新規が出る (毎日は出ない)。

import { WATCHLIST } from "./timeseries";
import { fetchHtml, hash } from "./utils";

export interface RatingsEnv {
	DB: D1Database;
	ARTICLES: R2Bucket;
	USER_AGENT: string;
	MIN_INTERVAL_MS: string;
}

// disclosure.ts と同じ銘柄ニュースページ (nmode=3)。当日の日報リンク発見の起点に使う。
const URL_NEWS = (code: string) =>
	`https://kabutan.jp/stock/news?code=${code}&nmode=3`;
const URL_ARTICLE = (b: string) => `https://kabutan.jp/news/marketnews/?b=${b}`;

// 信頼する証券会社 (短縮名の正規化後)。仮の初期値。後で調整可。
// ここに無い機関も保存はするが body に「信頼度: 低」を付け、judge 側で割り引けるようにする。
const TRUSTED_FIRMS = new Set<string>([
	"野村",
	"みずほ",
	"大和",
	"ＳＭＢＣ日興",
	"日興",
	"ＧＳ", // ゴールドマン・サックス
	"モルガン", // モルガン・スタンレーMUFG
	"ＪＰモル", // JPモルガン
	"ＵＢＳ",
	"メリル", // BofA
	"ＣＳ",
	"ジェフリーズ",
	"バークレイズ",
	"シティ",
	"ドイツ",
]);

// 半角化 (全角英数記号 → 半角)。コード照合・機関名比較を安定させる。
function toHalf(s: string): string {
	return s
		.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
			String.fromCharCode(c.charCodeAt(0) - 0xfee0),
		)
		.trim();
}

// 日報の本文1行に対応するレーティング。
type Rating = {
	code: string; // 4桁(または 285A 形式) 半角大文字
	name: string; // 銘柄名 (kabutan 表記)
	firm: string; // 機関名 (証券会社、短縮表記のまま)
	rating: string; // 格付 ("中立→買い" / "強気" など旧→新表記)
	target: string; // 目標株価 ("2200→2700" / "9000" など)
	date: string; // 日付 "M/D"
};

// 当日のレーティング日報記事ID (b=n...) を、銘柄ニュースページと記事内の関連リンクから集める。
// 戻り値は記事IDの集合 (重複排除済)。
function extractReportIds(html: string): Set<string> {
	const ids = new Set<string>();
	const re =
		/href="\/news\/marketnews\/\?b=(n\d+)"[^>]*>[^<]*レーティング日報[^<]*/g;
	let m: RegExpExecArray | null = re.exec(html);
	while (m !== null) {
		ids.add(m[1]);
		m = re.exec(html);
	}
	return ids;
}

// レーティング日報本文 (<br>区切りテキスト) を Rating[] にパースする。
// 本文ヘッダ "格付 目標株価 日付" の最後の出現以降を読む (先頭の出現は meta description)。
function parseReport(html: string): Rating[] {
	const headers = [...html.matchAll(/格付[\s　]*目標株価[\s　]*日付/g)];
	if (headers.length === 0) return [];
	const start = headers[headers.length - 1].index ?? 0;
	let seg = html.slice(start, start + 8000);
	seg = seg.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "");
	seg = seg.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

	const out: Rating[] = [];
	for (const rawLine of seg.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		// 本文の終端マーカー。これ以降は凡例・関連記事なので打ち切る。
		if (line.includes("株探") || line.includes("関連記事")) break;
		// 銘柄名 <コード> の後を 全角/半角スペース連続で分割。
		const m = line.match(
			/^(.+?)\s*[<＜]([0-9A-Za-z０-９Ａ-Ｚ]{4,5})[>＞]\s*(.*)$/,
		);
		if (!m) continue;
		const code = toHalf(m[2]).toUpperCase();
		const name = m[1].trim();
		const fields = m[3].split(/[\s　]+/).filter(Boolean);
		if (fields.length < 4) continue; // 機関 格付 目標株価 日付 の4つは要る
		out.push({
			code,
			name,
			firm: fields[0],
			rating: fields[1],
			target: fields[2],
			date: fields[fields.length - 1],
		});
	}
	return out;
}

async function isSeen(env: RatingsEnv, url: string): Promise<boolean> {
	const row = await env.DB.prepare(
		"SELECT 1 FROM articles WHERE url = ? LIMIT 1",
	)
		.bind(url)
		.first();
	return row !== null;
}

// "6/18" + 取得時の年 → "YYYY-MM-DD"。年は跨ぎを考慮し、未来日になるなら前年に倒す。
function normDate(md: string, now: Date): string {
	const m = md.match(/(\d{1,2})\/(\d{1,2})/);
	if (!m) return now.toISOString().slice(0, 10);
	let year = now.getUTCFullYear();
	const mm = Number(m[1]);
	const dd = Number(m[2]);
	// 例: 12月末に翌1月分を見ることはまず無いが、1月初に前年12月日報を拾う可能性に備える。
	const cand = new Date(Date.UTC(year, mm - 1, dd));
	if (cand.getTime() - now.getTime() > 7 * 86400_000) year -= 1;
	return `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

// レーティング1件を保存。本文(body)は人/判定LLMが読む1行サマリ。
// trusted=false の機関は body に「信頼度: 低」を明記する (捨てない)。
async function saveRating(
	env: RatingsEnv,
	r: Rating,
	published_at: string,
	sourceArticleUrl: string,
): Promise<boolean> {
	// 合成キー: 同一日報に複数銘柄が入るため実記事URLでは衝突する。code/firm/date で一意化。
	const firmHalf = toHalf(r.firm);
	const key = `rating://${r.code}/${encodeURIComponent(firmHalf)}/${published_at}`;
	if (await isSeen(env, key)) return false;

	const trusted = TRUSTED_FIRMS.has(firmHalf);
	const title = `${r.firm} レーティング ${r.rating} 目標株価 ${r.target}`;
	const body = [
		`${r.name} <${r.code}> ${published_at}`,
		`証券会社: ${r.firm}`,
		`格付: ${r.rating}`,
		`目標株価: ${r.target}`,
		`信頼度: ${trusted ? "通常" : "低 (要確認の機関)"}`,
		`出典: ${sourceArticleUrl}`,
	].join("\n");

	const fetched_at = new Date().toISOString();
	const r2_key = `${r.code}/${published_at}-rating-${hash(key)}.json`;
	const payload = JSON.stringify(
		{
			url: key,
			ticker: r.code,
			source: `rating:${firmHalf}`,
			title,
			body,
			published_at,
			ir_category: "rating",
			firm: firmHalf,
			rating: r.rating,
			target: r.target,
			trusted,
			source_article: sourceArticleUrl,
			fetched_at,
		},
		null,
		2,
	);
	await env.ARTICLES.put(r2_key, payload, {
		httpMetadata: { contentType: "application/json" },
	});
	await env.DB.prepare(
		`INSERT OR IGNORE INTO articles
      (url, ticker, source, title, published_at, ir_category, r2_key, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			key,
			r.code,
			`rating:${firmHalf}`,
			title,
			published_at,
			"rating",
			r2_key,
			fetched_at,
		)
		.run();
	return true;
}

// watchlist 全銘柄 (codeFilter 指定時はその1銘柄) のレーティングを収集。
// 日報は全銘柄横断なので、起点の銘柄ニュースページから記事IDを集め、各記事をパースして
// watchlist 行だけ保存する。戻り値の freshTickers は今回新規があった銘柄。
export async function collectRatings(
	env: RatingsEnv,
	codeFilter: string | null,
): Promise<{ results: Record<string, unknown>; freshTickers: string[] }> {
	const codes = WATCHLIST.filter((c) => !codeFilter || c === codeFilter);
	const watchSet = new Set(codes);
	const interval = parseInt(env.MIN_INTERVAL_MS, 10) || 5000;
	const now = new Date();

	// 1. 起点ページ群から当日のレーティング日報記事IDを集める。
	const reportIds = new Set<string>();
	for (let i = 0; i < codes.length; i++) {
		if (i > 0) await new Promise((res) => setTimeout(res, interval));
		try {
			const html = await fetchHtml(URL_NEWS(codes[i]), env);
			for (const id of extractReportIds(html)) reportIds.add(id);
		} catch (e) {
			console.error(
				`ratings: news page ${codes[i]} failed: ${(e as Error).message}`,
			);
		}
	}

	// 2. 見つけた日報を1本取得し、その関連リンクから同日の日報を全種類に拡張する。
	if (reportIds.size > 0) {
		const firstId = [...reportIds][0];
		try {
			await new Promise((res) => setTimeout(res, interval));
			const html = await fetchHtml(URL_ARTICLE(firstId), env);
			for (const id of extractReportIds(html)) reportIds.add(id);
		} catch (e) {
			console.error(`ratings: expand related failed: ${(e as Error).message}`);
		}
	}

	// 3. 各日報をパースし watchlist 行だけ保存。
	const perTickerWritten: Record<string, number> = {};
	let scannedRows = 0;
	for (const id of reportIds) {
		await new Promise((res) => setTimeout(res, interval));
		try {
			const html = await fetchHtml(URL_ARTICLE(id), env);
			const ratings = parseReport(html);
			scannedRows += ratings.length;
			for (const r of ratings) {
				if (!watchSet.has(r.code)) continue;
				const published_at = normDate(r.date, now);
				const wrote = await saveRating(env, r, published_at, URL_ARTICLE(id));
				if (wrote)
					perTickerWritten[r.code] = (perTickerWritten[r.code] ?? 0) + 1;
			}
		} catch (e) {
			console.error(`ratings: report ${id} failed: ${(e as Error).message}`);
		}
	}

	const freshTickers = Object.keys(perTickerWritten);
	const results: Record<string, unknown> = {
		reports: reportIds.size,
		scannedRows,
		written: perTickerWritten,
	};
	return { results, freshTickers };
}
