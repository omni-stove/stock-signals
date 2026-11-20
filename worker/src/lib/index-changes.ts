// Cloudflare Worker: 日経平均 (日経225) と JPX日経400 の構成銘柄の採用・除外のうち、監視銘柄の分を
// macro_events に入れる。
//
// 日経平均: indexes.nikkei.co.jp の HTML (お知らせ一覧を含む) は Cloudflare のチャレンジを返して
// Worker から読めないが、お知らせ本文の PDF (/nkave/archives/news/YYYYMMDDJ_N.pdf) はチャレンジ無しで
// 返る。一覧が読めないので、日付ごとに N=1 から順に取り、無い番号 (「見つかりません」ページ) で止める。
// 冒頭の「ニュースタグ」に日経平均と銘柄入替が並ぶものだけ読む。
// JPX日経400: JPX日経400 のページの「関連ニュース」から構成銘柄のお知らせを取り、本文 PDF を読む。
//
// PDF の解析は JS 側で CPU を食うので、毎回読むのは前営業日以降に公表された分だけにする。

import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { queryAll } from "./html";
import { latestTseBusinessDay } from "./market-calendar";
import { extractPdfText } from "./pdf-text";
import { macroEvents } from "./schema";
import { addDays, fetchHtml, jstDate, sleep } from "./utils";
import { WATCHLIST_NAMES } from "./watchlist";

export interface IndexChangesEnv {
	DB: D1Database;
	USER_AGENT: string;
	MIN_INTERVAL_MS: string;
}

const URL_JPX400 =
	"https://www.jpx.co.jp/markets/indices/jpx-nikkei400/index.html";
const JPX_HOST = "www.jpx.co.jp";
const NIKKEI_NEWS_BASE = "https://indexes.nikkei.co.jp/nkave/archives/news/";
// 1 日のお知らせは多い日で 5 本。番号が欠けずに続くので、これは取りすぎ防止の上限。
const NIKKEI_MAX_PER_DAY = 10;
const FETCH_TIMEOUT_MS = 20_000;

export const NIKKEI225 = "日経225";
export const JPX400 = "JPX日経400";

export interface IndexNotice {
	url: string;
	publishedAt: string; // YYYY-MM-DD
}

export interface IndexChange {
	code: string;
	action: "add" | "remove";
	date: string; // 実施日 YYYY-MM-DD
}

const pad2 = (n: number | string) => String(n).padStart(2, "0");

const NOTICE_HREF = /\/news\/\d+\/(\d{4})(\d{2})(\d{2})-\d+\.html$/;

/**
 * JPX日経400 のページから JPX日経400 の構成銘柄のお知らせを返す。公表日はお知らせ URL の日付。
 */
export async function parseJpx400Notices(
	html: string,
	baseUrl: string,
): Promise<IndexNotice[]> {
	const { a } = await queryAll(html, ["a"]);
	const out: IndexNotice[] = [];
	for (const link of a) {
		const url = new URL(link.attrs.href ?? "", baseUrl).toString();
		const m = url.match(NOTICE_HREF);
		const title = link.text.trim();
		if (!m || !/JPX日経インデックス400/.test(title) || !/構成銘柄/.test(title))
			continue;
		if (out.some((n) => n.url === url)) continue;
		out.push({ url, publishedAt: `${m[1]}-${m[2]}-${m[3]}` });
	}
	return out;
}

/** お知らせページの最初の PDF (本文) の URL を返す。無ければ null。 */
export async function parseNoticePdfUrl(
	html: string,
	baseUrl: string,
): Promise<string | null> {
	const { a } = await queryAll(html, ["a"]);
	const href = a
		.map((l) => l.attrs.href ?? "")
		.find((h) => h.toLowerCase().split(/[?#]/)[0].endsWith(".pdf"));
	return href ? new URL(href, baseUrl).toString() : null;
}

/** 日経のお知らせ本文 PDF の URL (date の n 本目)。 */
export function nikkeiNewsUrl(date: string, n: number): string {
	return `${NIKKEI_NEWS_BASE}${date.replace(/-/g, "")}J_${n}.pdf`;
}

const FULL_DATE = /(\d{4})年(\d{1,2})月(\d{1,2})日/;
const MONTH_DAY = /(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/g;
const PAREN_CODE = /\((\d{3}[0-9A-Z])\)/g;
const ACTION = /除外|採用|追加/g;
// JPX日経400 の定期入替の銘柄表の 1 銘柄 (「コード 市場区分 銘柄名」)。
const JPX_TABLE_CODE = /(?<![0-9A-Z])(\d{3}[0-9A-Z])\s+[PSG](?=\s)/g;
// 日経平均の銘柄入れ替え表の 1 銘柄の先頭 (「コード 銘柄名」)。
const NIKKEI_TABLE_CODE = /(?<![0-9A-Z.])(\d{3}[0-9A-Z])(?=\s)/g;
// 日経平均の表で採用銘柄にだけ付く採用時の株価換算係数「(0.7)」。
const ADOPTION_FACTOR = /\(\s*\d[\d.\s]*\)/;
const LEADING_WHEN = /^(?:同日|\d{1,2}月\d{1,2}日)(?:に|から)?/;

const fullDate = (m: RegExpMatchArray) => `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;

// 年の無い「M月D日」は公表日の年。公表月より前の月なら翌年。
function monthDay(
	year: string | undefined,
	month: string,
	day: string,
	publishedAt: string,
): string {
	const [py, pm] = publishedAt.split("-").map(Number);
	const y = year ? Number(year) : Number(month) < pm ? py + 1 : py;
	return `${y}-${pad2(month)}-${pad2(day)}`;
}

function dedupe(changes: IndexChange[]): IndexChange[] {
	const seen = new Set<string>();
	return changes.filter((c) => {
		const key = `${c.code}:${c.action}:${c.date}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function parseJpxRegular(text: string): IndexChange[] {
	const dateAt = text.search(/定期入替実施日/);
	const date = text.slice(dateAt).replace(/\s+/g, "").match(FULL_DATE);
	const addAt = text.search(/追加銘柄一覧/);
	const removeAt = text.search(/除外銘柄一覧/);
	if (!date || addAt < 0 || removeAt < addAt) return [];
	// 中小型株指数など後続の指数の表まで読まない。
	const rest = text
		.slice(removeAt)
		.search(/JPX\s*日経中小型株指数|定期入替実施日/);
	const end = rest < 0 ? text.length : removeAt + rest;
	const codes = (s: string) => [...s.matchAll(JPX_TABLE_CODE)].map((m) => m[1]);
	const effective = fullDate(date);
	return [
		...codes(text.slice(addAt, removeAt)).map((code) => ({
			code,
			action: "add" as const,
			date: effective,
		})),
		...codes(text.slice(removeAt, end)).map((code) => ({
			code,
			action: "remove" as const,
			date: effective,
		})),
	];
}

function parseJpxExclusion(compact: string): IndexChange[] | null {
	const date = compact.match(/除外期日(\d{4})年(\d{1,2})月(\d{1,2})日/);
	const targetAt = compact.search(/除外対象/);
	if (!date || targetAt < 0) return null;
	const target = compact.slice(targetAt).split(/以上/)[0];
	return [...target.matchAll(PAREN_CODE)].map((m) => ({
		code: m[1],
		action: "remove" as const,
		date: fullDate(date),
	}));
}

// 文ごとに「〜を(日付に)除外/採用/追加」を探し、「を」の前の目的語の銘柄をその扱いにする。
// 目的語に「(コード)」があればそのコード、無ければ本文で「名前(コード)」と書かれた銘柄のうち
// 名前が目的語と一致するもの (「同日に日野自動車を除外」の日野自動車)。実施日は語より前で
// 文中最後の日付 (「同日」「一方」で続く節は前の節の日付を引き継ぐ)。
// 目的語が銘柄に当たらない語 (「一部構成銘柄を除外」など) は採らない。
function parseProse(compact: string, publishedAt: string): IndexChange[] {
	const named = [...compact.matchAll(PAREN_CODE)].map((m) => ({
		code: m[1],
		before: compact.slice(0, m.index),
	}));
	const out: IndexChange[] = [];
	for (const sentence of compact.split("。")) {
		let clauseStart = 0;
		for (const verb of sentence.matchAll(ACTION)) {
			const clause = sentence.slice(clauseStart, verb.index);
			clauseStart = verb.index + verb[0].length;
			const wo = clause.lastIndexOf("を");
			if (wo < 0) continue;
			const head = clause.slice(0, wo);
			const object = head
				.slice(head.lastIndexOf("、") + 1)
				.replace(LEADING_WHEN, "");
			const codes = [...object.matchAll(PAREN_CODE)];
			const code = codes.length
				? codes[codes.length - 1][1]
				: object.length >= 2
					? named.find((n) => n.before.endsWith(object))?.code
					: undefined;
			const dates = [...sentence.slice(0, verb.index).matchAll(MONTH_DAY)];
			const last = dates[dates.length - 1];
			if (!code || !last) continue;
			out.push({
				code,
				action: verb[0] === "除外" ? "remove" : "add",
				date: monthDay(last[1], last[2], last[3], publishedAt),
			});
		}
	}
	return out;
}

/**
 * JPX日経400 のお知らせ本文 PDF のテキストから、JPX日経400 の採用 (add)・除外 (remove) と実施日を読む。
 * 本文は定期入替 (追加・除外の銘柄表と実施日)・非定期の除外 (除外期日・除外対象の箇条)・
 * 入替の文章の 3 形。年の無い日付は公表日 (YYYY-MM-DD) から年を補う。読めなければ空配列。
 */
export function parseJpx400NoticeText(
	text: string,
	publishedAt: string,
): IndexChange[] {
	const normalized = text.normalize("NFKC");
	const compact = normalized.replace(/\s+/g, "");
	return dedupe(
		/定期入替実施日/.test(compact)
			? parseJpxRegular(normalized)
			: (parseJpxExclusion(compact) ?? parseProse(compact, publishedAt)),
	);
}

/** 日経のお知らせ本文のニュースタグに日経平均と銘柄入替が両方あるか。 */
export function isNikkei225Change(text: string): boolean {
	const line = text.normalize("NFKC").match(/ニュースタグ\s*:([^\n]*)/);
	const tags = line
		? line[1].split("、").map((t) => t.replace(/\s+/g, ""))
		: [];
	return tags.includes("日経平均") && tags.includes("銘柄入替");
}

// 「銘柄入れ替え(M月D日)」の表。採用・除外の 2 列はテキストにすると混ざって並ぶので、
// 採用時の株価換算係数の有無で分ける。表は「注)」か次の番号付きの節で終わる。
function parseNikkeiTables(text: string, publishedAt: string): IndexChange[] {
	const out: IndexChange[] = [];
	const head = /銘柄入れ替え\s*\(\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*\)/g;
	for (const h of text.matchAll(head)) {
		const start = (h.index ?? 0) + h[0].length;
		const rest = text.slice(start);
		const endAt = rest.search(/注\)|\n\s*\d+\.\s/);
		const table = endAt < 0 ? rest : rest.slice(0, endAt);
		const date = monthDay(undefined, h[1], h[2], publishedAt);
		const rows = [...table.matchAll(NIKKEI_TABLE_CODE)];
		rows.forEach((r, i) => {
			const row = table.slice(r.index, rows[i + 1]?.index ?? table.length);
			out.push({
				code: r[1],
				action: ADOPTION_FACTOR.test(row) ? "add" : "remove",
				date,
			});
		});
	}
	return out;
}

/**
 * 日経のお知らせ本文 PDF のテキストから、日経平均の採用 (add)・除外 (remove) と実施日を読む。
 * ニュースタグに日経平均と銘柄入替が無ければ空配列。銘柄入れ替えの表と、経営統合などに伴う
 * 入替の文章を読む。年の無い日付は公表日 (YYYY-MM-DD) から年を補う。
 */
export function parseNikkeiNewsText(
	text: string,
	publishedAt: string,
): IndexChange[] {
	if (!isNikkei225Change(text)) return [];
	const normalized = text.normalize("NFKC");
	return dedupe([
		...parseNikkeiTables(normalized, publishedAt),
		...parseProse(normalized.replace(/\s+/g, ""), publishedAt),
	]);
}

export interface IndexChangeEvent {
	date: string;
	kind: string;
	label: string;
	impact: "high";
	note: string;
}

/** 監視銘柄の採用・除外だけを macro_events の行にする。note は公表日。 */
export function indexChangeEvents(
	changes: IndexChange[],
	index: string,
	publishedAt: string,
	names: Record<string, string>,
): IndexChangeEvent[] {
	return changes
		.filter((c) => names[c.code])
		.map((c) => ({
			date: c.date,
			kind: `index_change:${c.code}`,
			label: `${names[c.code]}(${c.code}) ${index}${c.action === "add" ? "採用" : "除外"}`,
			impact: "high",
			note: `公表日 ${publishedAt}`,
		}));
}

/** 同じ (date, kind) の 2 件を 1 行にまとめる。label・note は重複を除いて " / " でつなぐ。 */
function mergeEvents(a: IndexChangeEvent, b: IndexChangeEvent): IndexChangeEvent {
	const join = (x: string, y: string) => {
		const parts = x ? x.split(" / ") : [];
		for (const p of y.split(" / ")) if (p && !parts.includes(p)) parts.push(p);
		return parts.join(" / ");
	};
	return { ...a, label: join(a.label, b.label), note: join(a.note, b.note) };
}

// PDF を取る。missing に当たるページ (無い番号の「見つかりません」) なら null、
// それ以外で PDF でなければ例外 (チャレンジに変わったなどを黙って 0 件にしない)。
async function fetchPdf(
	url: string,
	env: { USER_AGENT: string },
	missing?: RegExp,
): Promise<Uint8Array | null> {
	const res = await fetch(url, {
		headers: { "User-Agent": env.USER_AGENT },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	const type = res.headers.get("content-type") ?? "";
	if (res.ok && type.includes("pdf"))
		return new Uint8Array(await res.arrayBuffer());
	if (missing?.test(await res.text())) return null;
	throw new Error(`HTTP ${res.status} ${type} ${url}`);
}

/** from から to までの暦日 (YYYY-MM-DD) を古い順に返す。 */
function datesBetween(from: string, to: string): string[] {
	const out: string[] = [];
	for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
	return out;
}

/**
 * 前営業日以降に公表された日経平均と JPX日経400 の構成銘柄のお知らせを読み、監視銘柄の採用・除外を
 * macro_events に (date=実施日, kind=index_change:<code>) で upsert する。
 * 戻り値は指数ごとの読んだお知らせ数、保存件数、お知らせごとの失敗。
 */
export async function collectIndexChanges(
	env: IndexChangesEnv,
): Promise<Record<string, unknown>> {
	const today = jstDate(Date.now());
	const since = latestTseBusinessDay(addDays(today, -1));
	const interval = Number.parseInt(env.MIN_INTERVAL_MS, 10) || 5000;
	const events: IndexChangeEvent[] = [];
	const errors: { url: string; error: string }[] = [];
	const read = { [NIKKEI225]: 0, [JPX400]: 0 };

	for (const date of datesBetween(since, today)) {
		for (let n = 1; n <= NIKKEI_MAX_PER_DAY; n++) {
			const url = nikkeiNewsUrl(date, n);
			try {
				await sleep(interval);
				const pdf = await fetchPdf(url, env, /見つかりません/);
				if (!pdf) break;
				read[NIKKEI225]++;
				const changes = parseNikkeiNewsText(await extractPdfText(pdf), date);
				events.push(
					...indexChangeEvents(changes, NIKKEI225, date, WATCHLIST_NAMES),
				);
			} catch (e) {
				errors.push({ url, error: String(e) });
				break;
			}
		}
	}

	try {
		const notices = (
			await parseJpx400Notices(await fetchHtml(URL_JPX400, env), URL_JPX400)
		).filter((n) => n.publishedAt >= since);
		for (const notice of notices) {
			try {
				await sleep(interval);
				const pdfUrl = await parseNoticePdfUrl(
					await fetchHtml(notice.url, env),
					notice.url,
				);
				if (!pdfUrl || new URL(pdfUrl).host !== JPX_HOST)
					throw new Error(`pdf not found ${pdfUrl ?? ""}`);
				await sleep(interval);
				const pdf = await fetchPdf(pdfUrl, env);
				if (!pdf) continue;
				read[JPX400]++;
				const changes = parseJpx400NoticeText(
					await extractPdfText(pdf),
					notice.publishedAt,
				);
				events.push(
					...indexChangeEvents(
						changes,
						JPX400,
						notice.publishedAt,
						WATCHLIST_NAMES,
					),
				);
			} catch (e) {
				errors.push({ url: notice.url, error: String(e) });
			}
		}
	} catch (e) {
		errors.push({ url: URL_JPX400, error: String(e) });
	}

	const d = db(env.DB);
	const fetchedAt = new Date().toISOString();
	const merged = new Map<string, IndexChangeEvent>();
	for (const e of events) {
		const key = `${e.date}|${e.kind}`;
		const prev = merged.get(key);
		merged.set(key, prev ? mergeEvents(prev, e) : e);
	}
	for (const ev of merged.values()) {
		const [row] = await d
			.select({ label: macroEvents.label, note: macroEvents.note })
			.from(macroEvents)
			.where(and(eq(macroEvents.date, ev.date), eq(macroEvents.kind, ev.kind)))
			.all();
		const e = row
			? mergeEvents(
					{ ...ev, label: row.label, note: row.note ?? "" },
					ev,
				)
			: ev;
		const values = {
			label: e.label,
			impact: e.impact,
			jstEffectDate: null,
			note: e.note,
			fetchedAt,
		};
		await d
			.insert(macroEvents)
			.values({ date: e.date, kind: e.kind, ...values })
			.onConflictDoUpdate({
				target: [macroEvents.date, macroEvents.kind],
				set: values,
			})
			.run();
	}
	return { read, saved: merged.size, errors };
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	// JPX日経400 のページ (2026-11 取得) の関連ニュース表の行をそのまま抜いたもの。
	const LISTING = `<table  class="overtable" >
            <caption></caption>
            <tbody>
                    <tr>
                            <th  width="20%"
                                class="a-center a-middle tb-color003 fc-white">
                                2026/9/9
                            </th>
                            <td class="a-left a-middle ">
                                <a href="https://www.jpx.co.jp/news/6030/20260909-01.html" class="link-window">JPX日経インデックス400及びJPX日経インデックス人的資本100の構成銘柄の取り扱いについて</a>
                            </td>
                    </tr>
                    <tr>
                            <th  width="20%"
                                class="a-center a-middle tb-color003 fc-white">
                                2026/9/3
                            </th>
                            <td class="a-left a-middle ">
                                <a href="https://www.jpx.co.jp/news/6030/20260903-02.html" class="link-window">JPX日経インデックス400の構成銘柄の取り扱いについて</a>
                            </td>
                    </tr>
                    <tr>
                            <th  width="20%"
                                class="a-center a-middle tb-color003 fc-white">
                                2022/9/16
                            </th>
                            <td class="a-left a-middle ">
                                <a href="https://www.jpx.co.jp/news/6030/20220916-02.html" class="link-window">日本電信電話(株)（9432）に係るJPX日経インデックス400算出上の取扱いについて</a>
                            </td>
                    </tr>
            </tbody></table>
<a href="/markets/indices/jpx-nikkei400/tvdivq00000031dd-att/J_kannren400.pdf" rel="external">`;

	// お知らせページ (2025-08-07 定期入替) の資料表の先頭 2 行。
	const NOTICE_PAGE = `<table>
<caption></caption>
<tr class="first">
     <td width="80%" class="a-left a-middle tb-color001">JPX日経インデックス400及びJPX日経中小型株指数の構成銘柄の定期入替について</td>
     <td class="a-center a-middle tb-color001"><a href="/news/6030/um3qrc000001ri27-att/data_j.pdf" rel="external"><img src="/common/images/icon/icon-pdf.png" alt="PDF" title="PDF" width="18" height="18" /></a></td>
</tr>
<tr>
     <td width="80%" class="a-left a-middle tb-color001">別紙1.JPX日経インデックス400定期入替関連データ</td>
     <td class="a-center a-middle tb-color001"><a href="/news/6030/um3qrc000001ri27-att/data1_j.pdf" rel="external"><img src="/common/images/icon/icon-pdf.png" alt="PDF" title="PDF" width="18" height="18" /></a></td>
</tr>
</table>`;

	// 2025-08-07 定期入替の本文 PDF を extractPdfText で読んだテキストから、各表の行を間引いたもの。
	const REGULAR_TEXT = `JPX 日経インデックス 400 及び JPX 日経中小型株指数の構成銘柄の定期入替について
今回の定期入替では、JPX 日経インデックス 400 は 39 銘柄を追加、34 銘柄を除外し、JPX 日経中小
型株指数は 53 銘柄を追加、48 銘柄を除外します1。定期入替後の全構成銘柄一覧につきましては、ウェ
ブサイトをご覧ください。
記
1. JPX 日経インデックス 400
①追加銘柄一覧
コード 市場区分 銘柄名 コード 市場区分 銘柄名
2154 P オープンアップグループ 7867 P タカラトミー
2767 P 円谷フィールズホールディングス 7906 S ヨネックス
1 JPX 日経インデックス 400 は非定期の除外に伴い、現在の銘柄数が 395 銘柄となっているため、追加銘柄が除外銘柄よりも 5 銘柄
多くなっております。
2
7740 P タムロン
②除外銘柄一覧
コード 市場区分 銘柄名 コード 市場区分 銘柄名
2146 P ＵＴグループ 5463 P 丸一鋼管
2175 P エス・エム・エス 6055 P ジャパンマテリアル
4694 P ビー・エム・エル 6976 P 太陽誘電
3
2. JPX 日経中小型株指数
① 追加銘柄一覧
コード 市場区分 銘柄名 コード 市場区分 銘柄名
1429 P 日本アクア 4413 P ボードルア
2175 P エス・エム・エス 5352 P 黒崎播磨
※市場区分の表記については、プライム 市場=P、スタンダード市場=S、グロース市場=G としておりま す。
3. 定期入替実施日
2025 年 8 月 29 日
以上`;

	// 2026-05-12 除外の本文 PDF のテキスト (行が二重に出るのも PDF のまま)。
	const EXCLUSION_TEXT = `２ ０ ２ ６ 年 ５ 月 １ ２ 日
JPX 日経インデックス 400 の構成銘柄の除外について
日本経済新聞社およびＪＰＸ総研は、「ＪＰＸ日経インデックス４００」の
銘柄選定ルールに基づき、下記のとおり一部構成銘柄を除外します。
記
記
１．除外事由 整理銘柄への指定
１．除外事由 整理銘柄への指定
２．除外期日 ２０２６年５月１８日算出分より除外
２．除外期日 ２０２６年５月１８日算出分より除外
３．除外対象 豊田自動織機（６２０１）
３．除外対象 豊田自動織機（６２０１）
以 上
以 上`;

	// 2026-09-03 入替の本文 PDF のテキスト。
	const SWAP_TEXT = `JPX 日経インデックス 400 の構成銘柄の取り扱いについて
日本経済新聞社およびＪＰＸ総研は、「JPX 日経インデックス 400」の銘柄
選定ルールに基づき、下記のとおり一部構成銘柄を入れ替えます。
記
キューデンホールディングスによる完全子会社化により上場廃止となる九州
電力（９５０８）を１０月１日に除外し、同日から新規上場する同社の完全親
会社となるキューデンホールディングス（６４２Ａ）を採用します。
なお、九州電力が上場廃止となる９月２９日と除外の前営業日である９月３
０日は、９月２８日の指数算出における九州電力の最終時価総額を用いて指数
を算出します。
以 上`;

	// 2026-09-09 スピンオフの本文 PDF のテキスト。
	const SPINOFF_TEXT = `JPX 日経インデックス 400 及び JPX 日経インデックス人的資本 100
の構成銘柄の取り扱いについて
日本経済新聞社およびＪＰＸ総研は、「JPX 日経インデックス 400」及び「JPX
日経インデックス人的資本 100」の構成銘柄であるレゾナック・ホールディン
グス（４００４）が予定するスピンオフ（構成銘柄が剰余金の配当によりその
直前において子会社であった会社等の株式を割り当てること）について、株価
指数算出上、以下のとおり取扱います。
レゾナック・ホールディングスが予定するスピンオフにより新規 上場するク
ラサスケミカル（６４６Ａ）を、上場日である９月２９日から「JPX 日経インデ
ックス 400」と「JPX 日経インデックス人的資本 100」の構成銘柄に追加します。
なお、この取扱いによる両指数の基準時価総額の修正はありません。`;

	// 日経 2026-03-05 のお知らせ本文 PDF (20260305J_1.pdf) を extractPdfText で読んだテキストの前半。
	const NIKKEI_REGULAR_TEXT = `ニュースタグ： 日経平均、 銘柄入替、株価換算係数、重要なお知らせ
本件に対する問い合わせ
日本経済新聞社 インデックス事業室（ index@nex.nikkei.co.jp ）
インデックス・ニュース
20 26 年 3 月 5 日
株式会社 日本経済新聞社
日経平均株価の銘柄定期入れ替え等について
日本経済新聞社は、日経平均株価の構成銘柄について、以下のとおり定期 見直しによる 入れ替え 等
を実施します。また、 構成銘柄の日野自動車が 4 月 1 日付で三菱ふそうトラック・バスと経営統合
するのに伴い、以下の通り対応します。このほか、 一部構成銘柄が実施を予定している株式分割に
対する算出上の取り扱いを以下のとおりとします。
1. 定期見直しによる銘柄入れ替え について
銘柄入れ替え （ 4 月 1 日）
採用 除外
285A キオクシアホールディングス （ 0.7 ）
7532 パン・パシフィック・インターナショナ
ルホールディングス （ 1）
6674 ジーエス・ユアサ コーポレーション
6952 カシオ計算機
注）採用銘柄のカッコ内は採用時の株価換算係数
定期見直し基準に照らし、 市場流動性の観点から キオクシアホールディングス （ セクター ・技術）、
セクター間の 銘柄過不足調整により パン・パシフィック・インターナショナルホールディングス
（ 同・消費）を採用し ます。また 、 セクター間の銘柄過不足調整により ジーエス・ユアサ コーポ
レーション （同・ 技術） と カシオ計算機（ 同・ 技術） を除外します。銘柄は 4 月 1 日の算出から入
れ替えます。
注）セクター は日経業種分類（ 36 分類）を技術、金融、消費、素材、資本財・その他、運輸・公共の 6 つに集約したもの。
2. 日野自動車の取り扱いについて
日野自動車（ 7205 ） が三菱ふそうトラック・バスと経営統合で持ち株会社 ＡＲＣＨＩＯＮ （ 543A ）
を 4 月 1 日に設立するのに伴い 、同日に日野自動車を除外する一方、 ＡＲＣＨＩＯＮ を採用しま
す。 なお、 日野自動車が上場廃止となる 3 月 30 日と除外の前営業日である 3 月 31 日の指数は、
日野自動車の最終売買日である 3 月 27 日の日経平均終値の算出に用いた株価で 算出します。
ニュースタグ： 日経平均、 銘柄入替、株価換算係数、重要なお知らせ
3. 株式分割の取り扱いについて
次の 4 銘柄が実施を予定する株式分割に対しては、それぞれの分割比率に合わせて、 3 月 30 日の
算出から株価換算係数を変更します。
株価換算係数変更（ 3 月 30 日）
銘柄 現 → 新 事由
5803 フジクラ 1 → 6 1： 6 分割
7012 川崎重工業 0.1 → 0. 5 1： 5 分割`;

	// 日経 2026-10-16 のお知らせ本文 PDF (20261016J_1.pdf) の冒頭。日経平均ではなく外需株 50 の入替。
	const NIKKEI_OTHER_TEXT = `ニュースタグ： 内需株 50、外需株 50、 銘柄入替
インデックス・ニュース
日経内需株 50 、日経外需株 50 の銘柄定期入れ替え
【日経平均外需株 50 指数】
銘柄入れ替え（ 10 月 30 日）
採用銘柄 除外銘柄
285A キオクシアホールディングス
3382 セブン＆アイ・ホールディングス`;

	describe("parseJpx400Notices", () => {
		it("JPX日経400 の構成銘柄のお知らせを公表日つきで取る", async () => {
			expect(await parseJpx400Notices(LISTING, URL_JPX400)).toEqual([
				{
					url: "https://www.jpx.co.jp/news/6030/20260909-01.html",
					publishedAt: "2026-09-09",
				},
				{
					url: "https://www.jpx.co.jp/news/6030/20260903-02.html",
					publishedAt: "2026-09-03",
				},
			]);
		});
	});

	describe("parseNoticePdfUrl", () => {
		it("最初の PDF を絶対 URL で返す", async () => {
			const url = "https://www.jpx.co.jp/news/6030/20250807-01.html";
			expect(await parseNoticePdfUrl(NOTICE_PAGE, url)).toBe(
				"https://www.jpx.co.jp/news/6030/um3qrc000001ri27-att/data_j.pdf",
			);
			expect(await parseNoticePdfUrl("<p>なし</p>", url)).toBeNull();
		});
	});

	describe("parseJpx400NoticeText", () => {
		it("定期入替は JPX日経400 の表だけを実施日つきで読む", () => {
			const changes = parseJpx400NoticeText(REGULAR_TEXT, "2025-08-07");
			const at = (action: string) =>
				changes.filter((c) => c.action === action).map((c) => c.code);
			expect(at("add")).toEqual(["2154", "7867", "2767", "7906", "7740"]);
			expect(at("remove")).toEqual([
				"2146",
				"5463",
				"2175",
				"6055",
				"4694",
				"6976",
			]);
			expect(changes.find((c) => c.code === "6976")).toEqual({
				code: "6976",
				action: "remove",
				date: "2025-08-29",
			});
		});
		it("非定期の除外は除外期日と除外対象を読み、二重の行を 1 件にする", () => {
			expect(parseJpx400NoticeText(EXCLUSION_TEXT, "2026-05-12")).toEqual([
				{ code: "6201", action: "remove", date: "2026-05-18" },
			]);
		});
		it("入替の文章は銘柄ごとの扱いと日付を読み、同日は前の日付を引き継ぐ", () => {
			expect(parseJpx400NoticeText(SWAP_TEXT, "2026-09-03")).toEqual([
				{ code: "9508", action: "remove", date: "2026-10-01" },
				{ code: "642A", action: "add", date: "2026-10-01" },
			]);
		});
		it("扱いの語が無い文の銘柄は採らない", () => {
			expect(parseJpx400NoticeText(SPINOFF_TEXT, "2026-09-09")).toEqual([
				{ code: "646A", action: "add", date: "2026-09-29" },
			]);
		});
		it("年の無い日付が公表月より前なら翌年", () => {
			const text = SWAP_TEXT.replace("１０月１日", "１月５日");
			expect(parseJpx400NoticeText(text, "2026-12-10")[0].date).toBe(
				"2027-01-05",
			);
		});
	});

	describe("parseNikkeiNewsText", () => {
		it("銘柄入れ替えの表を換算係数の有無で採用・除外に分け、285A の採用を実施日つきで読む", () => {
			expect(parseNikkeiNewsText(NIKKEI_REGULAR_TEXT, "2026-03-05")).toEqual([
				{ code: "285A", action: "add", date: "2026-04-01" },
				{ code: "7532", action: "add", date: "2026-04-01" },
				{ code: "6674", action: "remove", date: "2026-04-01" },
				{ code: "6952", action: "remove", date: "2026-04-01" },
				{ code: "7205", action: "remove", date: "2026-04-01" },
				{ code: "543A", action: "add", date: "2026-04-01" },
			]);
		});
		it("ニュースタグに日経平均と銘柄入替が無ければ読まない", () => {
			expect(parseNikkeiNewsText(NIKKEI_OTHER_TEXT, "2026-10-16")).toEqual([]);
			expect(
				parseNikkeiNewsText(
					NIKKEI_REGULAR_TEXT.replace(/銘柄入替/g, "トピック"),
					"2026-03-05",
				),
			).toEqual([]);
		});
	});

	describe("nikkeiNewsUrl", () => {
		it("公表日と番号から本文 PDF の URL を組む", () => {
			expect(nikkeiNewsUrl("2026-03-05", 1)).toBe(
				"https://indexes.nikkei.co.jp/nkave/archives/news/20260305J_1.pdf",
			);
		});
	});

	describe("indexChangeEvents", () => {
		it("監視銘柄だけを index_change の行にする", () => {
			const changes = parseJpx400NoticeText(REGULAR_TEXT, "2025-08-07");
			expect(
				indexChangeEvents(changes, JPX400, "2025-08-07", {
					"6976": "太陽誘電",
				}),
			).toEqual([
				{
					date: "2025-08-29",
					kind: "index_change:6976",
					label: "太陽誘電(6976) JPX日経400除外",
					impact: "high",
					note: "公表日 2025-08-07",
				},
			]);
			expect(
				indexChangeEvents(
					parseNikkeiNewsText(NIKKEI_REGULAR_TEXT, "2026-03-05"),
					NIKKEI225,
					"2026-03-05",
					{ "285A": "キオクシアホールディングス" },
				),
			).toEqual([
				{
					date: "2026-04-01",
					kind: "index_change:285A",
					label: "キオクシアホールディングス(285A) 日経225採用",
					impact: "high",
					note: "公表日 2026-03-05",
				},
			]);
		});
	});
}
