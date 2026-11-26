// 決算系開示 (決算短信・業績予想の修正・説明資料) の PDF 原本から、定性記述の抜粋を作る。
//
// 開示一覧 (disclosure.ts / ir-collect.ts) は見出しを本文にするが、決算系だけは PDF を取り、
// 「経営成績の概況」「今後の見通し」「修正の理由」など定性部分を抜いて見出しの後ろに足す。
// 抜けないとき (取得失敗・非 PDF・テキスト層なし) は見出しだけを本文にする。
//
// PDF の解析 (unpdf = pdf.js) は HTMLRewriter と違い JS 側で CPU を食う。Workers の CPU 上限は
// invocation 単位で、超過すると例外ではなく invocation ごと kill される。収集中の invocation で
// 解析すると同じ回の他銘柄・他ソースの保存まで巻き添えになるため、SELF があれば解析を
// /run?kind=pdf-text の別 invocation に投げ、失敗はその 1 件の見出しフォールバックで済ませる。

import { getDocumentProxy } from "unpdf";
import { IR_SOURCES } from "./watchlist";

/** 見出しの後ろに足す抜粋の上限文字数。 */
const PDF_BODY_MAX_CHARS = 3000;

/** 1 銘柄・1 ソースの 1 回の収集で PDF 本文を取りに行く件数の上限。残りは見出しのみで保存する。 */
export const PDF_BODIES_PER_RUN = 3;

const PDF_MAX_BYTES = 10 * 1024 * 1024;
// 決算短信の定性部分は添付資料の冒頭 (概ね 10 ページ以内) にある。後ろの財務諸表は数値表で、
// 読んでも抜粋に入らないので解析しない。
const PDF_MAX_PAGES = 12;
const PDF_FETCH_TIMEOUT_MS = 20_000;
// 見出しが目次行と区別できずに目次を拾ったときの抜粋は短い。これ未満なら次の候補を試す。
const MIN_SECTION_CHARS = 200;

const TDNET_HOST = "www.release.tdnet.info";
// irpocket は一覧 (xml.irpocket.com) と PDF のホストが別。
const IRPOCKET_PDF_HOST = "pdf.irpocket.com";
// PDF を取りに行ってよいホスト。/run?kind=pdf-text が任意 URL の fetch 口にならないよう絞る。
const ALLOWED_PDF_HOSTS = new Set([
	TDNET_HOST,
	...IR_SOURCES.map((s) =>
		s.site === "irpocket" ? IRPOCKET_PDF_HOST : new URL(s.list_url).host,
	),
]);

// 決算発表の日程告知・説明会の開催案内は見出しで足りるので PDF を取らない。
const EARNINGS_TITLE =
	/決算短信|業績予想|業績の修正|決算説明|決算補足|決算概要|決算資料|説明会資料/;
const NOT_EARNINGS_TITLE = /開催|発表日|発表予定/;

/** 見出しが PDF 本文を取り込む決算系開示 (決算短信・業績予想の修正・説明資料など) か。 */
export function isEarningsDisclosure(title: string): boolean {
	return EARNINGS_TITLE.test(title) && !NOT_EARNINGS_TITLE.test(title);
}

/** https で、許可ホスト (TDnet・watchlist の IR サイト) 上の URL か。 */
export function isAllowedPdfUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return u.protocol === "https:" && ALLOWED_PDF_HOSTS.has(u.host);
	} catch {
		return false;
	}
}

/** URL のパスが .pdf で終わるか (クエリ・フラグメントは見ない)。 */
export function isPdfPath(url: string): boolean {
	try {
		return new URL(url).pathname.toLowerCase().endsWith(".pdf");
	} catch {
		return false;
	}
}

// ── 定性部分の抜き出し ───────────────────────────────────────────────────────

// 決算短信「経営成績等の概況」(本決算) / 「経営成績に関する説明」「定性的情報」(四半期)、
// 業績予想の修正「修正の理由」。本決算の概況は「今後の見通し」まで続く。
const QUAL_START =
	/経営成績等?の概況|経営成績等?に関する説明|定性的情報|修正の理由|修正理由/g;
// 定性部分の後ろに来る財務諸表・注記の章見出し。
const QUAL_END =
	/連結財務諸表及び主な注記|財務諸表及び主な注記|会計基準の選択に関する基本的な考え方|継続企業の前提に関する注記/;
// 目次行: リーダー (… ・ . 等の連続) の後にページ番号で終わる。
const TOC_LINE = /(?:[.．・…‥·]\s*){3,}\s*[0-9０-９]+\s*$/;
// 見出しの行頭側に許すのは番号接頭辞 (「1.」「(1)」) だけ。
const HEADING_PREFIX =
	/^\s*(?:(?:[0-9０-９]+[.．]|[(（][0-9０-９]+[)）])\s*)?$/;

/** 行ごとに空白 (全角空白を含む) を畳み、空行を落とす。 */
function normalizePdfText(text: string): string {
	return text
		.split(/\r?\n/)
		.map((l) => l.replace(/\s+/g, " ").trim())
		.filter((l) => l !== "")
		.join("\n");
}

function clip(s: string, maxChars: number): string {
	return s.length <= maxChars ? s : `${s.slice(0, maxChars)}…(以下略)`;
}

/**
 * PDF から抜いた全文テキストを受け、定性部分 (見出しの行頭から財務諸表の章見出しの手前まで) を
 * maxChars で切って返す。目次行の見出しは飛ばす。定性見出しが見つからない資料 (説明資料等) は
 * 冒頭から切る。テキストが空なら空文字。
 */
function qualitativeExcerpt(raw: string, maxChars: number): string {
	const text = normalizePdfText(raw);
	if (!text) return "";
	for (const m of text.matchAll(QUAL_START)) {
		const at = m.index ?? 0;
		const lineEnd = text.indexOf("\n", at);
		const line = text.slice(at, lineEnd < 0 ? undefined : lineEnd);
		if (TOC_LINE.test(line)) continue;
		const start = text.lastIndexOf("\n", at) + 1;
		// 「」内や文中の参照 (「…添付資料P.4「1.経営成績等の概況…」をご覧ください」) は見出しではない。
		if (!HEADING_PREFIX.test(text.slice(start, at))) continue;
		const from = at + m[0].length;
		const endRel = text.slice(from).search(QUAL_END);
		// 章見出しは行頭の番号 (「2.」等) ごと落とすため、その行の頭で切る。
		const endLine =
			endRel < 0 ? text.length : text.lastIndexOf("\n", from + endRel) + 1;
		const end = endLine > start ? endLine : from + endRel;
		const section = text.slice(start, end).trim();
		if (section.split("\n").some((l) => TOC_LINE.test(l))) continue;
		if (section.length >= MIN_SECTION_CHARS) return clip(section, maxChars);
	}
	return clip(text, maxChars);
}

// ── PDF 取得と解析 ──────────────────────────────────────────────────────────

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

// 仕様上ヘッダの前にゴミが入りうるので、先頭 1KB 内のどこかに "%PDF-" があれば PDF とみなす。
function looksLikePdf(buf: Uint8Array): boolean {
	const limit = Math.min(buf.length, 1024) - PDF_MAGIC.length;
	for (let i = 0; i <= limit; i++) {
		if (PDF_MAGIC.every((b, j) => buf[i + j] === b)) return true;
	}
	return false;
}

async function fetchPdf(
	url: string,
	env: { USER_AGENT: string },
): Promise<Uint8Array> {
	const res = await fetch(url, {
		headers: { "User-Agent": env.USER_AGENT },
		signal: AbortSignal.timeout(PDF_FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	const declared = Number(res.headers.get("content-length") ?? "0");
	if (declared > PDF_MAX_BYTES) {
		throw new Error(`PDF too large (${declared} bytes) ${url}`);
	}
	const buf = new Uint8Array(await res.arrayBuffer());
	if (buf.byteLength > PDF_MAX_BYTES) {
		throw new Error(`PDF too large (${buf.byteLength} bytes) ${url}`);
	}
	if (!looksLikePdf(buf)) throw new Error(`not a PDF ${url}`);
	return buf;
}

/** 先頭 PDF_MAX_PAGES ページのテキスト層を、pdf.js の行末 (hasEOL) で改行して連結して返す。 */
export async function extractPdfText(data: Uint8Array): Promise<string> {
	const pdf = await getDocumentProxy(data);
	const pages = Math.min(pdf.numPages, PDF_MAX_PAGES);
	const out: string[] = [];
	for (let i = 1; i <= pages; i++) {
		const page = await pdf.getPage(i);
		const content = await page.getTextContent();
		let s = "";
		for (const item of content.items) {
			if (!("str" in item)) continue;
			s += item.str;
			if (item.hasEOL) s += "\n";
		}
		out.push(s);
	}
	return out.join("\n");
}

/**
 * PDF を取得・解析し、定性部分の抜粋 (PDF_BODY_MAX_CHARS で切ったもの) を返す。
 * /run?kind=pdf-text が呼ぶ。許可外ホスト・取得失敗・非 PDF は例外、テキスト層が無ければ空文字。
 */
export async function pdfExcerpt(
	url: string,
	env: { USER_AGENT: string },
): Promise<string> {
	if (!isAllowedPdfUrl(url)) throw new Error(`PDF host not allowed: ${url}`);
	const text = await extractPdfText(await fetchPdf(url, env));
	return qualitativeExcerpt(text, PDF_BODY_MAX_CHARS);
}

export interface PdfBodyEnv {
	SELF?: Fetcher;
	SYNC_TOKEN?: string;
	USER_AGENT: string;
}

async function pdfExcerptViaSelf(
	self: Fetcher,
	env: PdfBodyEnv,
	url: string,
): Promise<string> {
	const q = new URLSearchParams({ kind: "pdf-text", url });
	const res = await self.fetch(`https://self/run?${q.toString()}`, {
		headers: env.SYNC_TOKEN
			? { authorization: `Bearer ${env.SYNC_TOKEN}` }
			: {},
	});
	if (!res.ok) {
		throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
	}
	const json = (await res.json()) as { result?: unknown };
	return typeof json.result === "string" ? json.result : "";
}

/**
 * 決算系開示の本文を作る。pdfUrl の PDF から定性部分を抜き「見出し + 空行 + 抜粋」を返す。
 * 決算系でない見出し・pdfUrl が null か許可外・取得や解析の失敗・抜粋が空のときは見出しだけを返す。
 * env.SELF があれば解析は別 invocation (/run?kind=pdf-text) で行う。
 */
export async function pdfBody(
	env: PdfBodyEnv,
	title: string,
	pdfUrl: string | null,
): Promise<string> {
	if (!pdfUrl || !wantsPdfBody(title, pdfUrl)) return title;
	try {
		const excerpt = env.SELF
			? await pdfExcerptViaSelf(env.SELF, env, pdfUrl)
			: await pdfExcerpt(pdfUrl, env);
		return excerpt ? `${title}\n\n${excerpt}` : title;
	} catch (e) {
		console.error(`pdf body error ${pdfUrl}: ${(e as Error).message}`);
		return title;
	}
}

/** pdfBody が PDF を取りに行く対象か (決算系の見出しで、PDF の URL が許可ホスト上にある)。 */
export function wantsPdfBody(title: string, pdfUrl: string | null): boolean {
	return (
		pdfUrl !== null && isEarningsDisclosure(title) && isAllowedPdfUrl(pdfUrl)
	);
}

if (import.meta.vitest) {
	const { describe, it, expect, vi } = import.meta.vitest;

	describe("isEarningsDisclosure", () => {
		const yes = [
			"2027年3月期 第2四半期（中間期）決算短信〔日本基準〕（連結）",
			"通期業績予想の修正に関するお知らせ",
			"業績予想及び配当予想の修正に関するお知らせ",
			"2027年3月期 第2四半期 決算説明資料",
		];
		const no = [
			"決算説明会開催のお知らせ",
			"決算発表日のお知らせ",
			"自己株式の取得状況に関するお知らせ",
			"代表取締役の異動に関するお知らせ",
		];
		for (const t of yes) {
			it(`決算系: ${t}`, () => {
				expect(isEarningsDisclosure(t)).toBe(true);
			});
		}
		for (const t of no) {
			it(`対象外: ${t}`, () => {
				expect(isEarningsDisclosure(t)).toBe(false);
			});
		}
	});

	describe("isAllowedPdfUrl / isPdfPath", () => {
		it("TDnet と watchlist の IR サイトの https だけを許す", () => {
			const ok = [
				"https://www.release.tdnet.info/inbs/1.pdf",
				"https://www.advantest.com/ja/a.pdf",
				"https://pdf.irpocket.com/C6976/a.pdf",
			];
			const ng = [
				"http://www.release.tdnet.info/inbs/1.pdf",
				"https://example.com/a.pdf",
				"not a url",
			];
			for (const u of ok) expect(isAllowedPdfUrl(u)).toBe(true);
			for (const u of ng) expect(isAllowedPdfUrl(u)).toBe(false);
		});
		it("パスの拡張子で PDF を判定する (大文字・クエリ付きも可)", () => {
			expect(isPdfPath("https://www.yuden.co.jp/a/B.PDF?v=1")).toBe(true);
			expect(isPdfPath("https://www.yuden.co.jp/a/b.html")).toBe(false);
		});
	});

	describe("qualitativeExcerpt", () => {
		const para = "当期における世界経済は、緩やかな回復が続いた。".repeat(12);
		const tanshin = [
			"2027年3月期 決算短信〔日本基準〕(連結)",
			"売上高 345,678 12.3",
			"○添付資料の目次",
			"1. 経営成績等の概況 ………………………… 2",
			"2. 会計基準の選択に関する基本的な考え方 ……… 5",
			"3. 連結財務諸表及び主な注記 ………………… 6",
			"1. 経営成績等の概況",
			"(1)当期の経営成績の概況",
			para,
			"(4)今後の見通し",
			"データセンター向け需要は堅調に推移する見込み",
			"2. 会計基準の選択に関する基本的な考え方",
			"当社グループは日本基準を適用している",
		].join("\n");

		it("目次行を飛ばし、本文の見出しから財務諸表・注記の章見出しの手前までを抜く", () => {
			const out = qualitativeExcerpt(tanshin, 10_000);
			expect(out).toMatch(/^1\. 経営成績等の概況\n\(1\)当期の経営成績の概況\n/);
			expect(out).toContain("(4)今後の見通し");
			expect(out).toContain("データセンター向け需要は堅調");
			expect(out).not.toContain("会計基準の選択");
			expect(out).not.toContain("345,678");
		});

		it("上限を超えたら切って省略を示す", () => {
			const out = qualitativeExcerpt(tanshin, 50);
			expect(out).toHaveLength(50 + "…(以下略)".length);
			expect(out.endsWith("…(以下略)")).toBe(true);
		});

		it("目次が改行で割れて見出しが本文と区別できないときは、短い候補を捨てて次を使う", () => {
			const split = [
				"1. 経営成績等の概況",
				"………… 2",
				"2. 連結財務諸表及び主な注記",
				"1. 経営成績等の概況",
				para,
				"2. 連結財務諸表及び主な注記",
			].join("\n");
			const out = qualitativeExcerpt(split, 10_000);
			expect(out).toContain(para);
			expect(out).not.toContain("…………");
		});

		it("1 ページ目の参照文 (「」内の見出し) は開始位置にしない", () => {
			const withRef = [
				"2027年3月期 決算短信〔日本基準〕(連結)",
				"※ 業績予想の適切な利用に関する説明",
				"詳細は添付資料P.4「1.経営成績等の概況（4）今後の見通し」をご覧ください。",
				"○添付資料の目次",
				"1. 経営成績等の概況 ………………………… 2",
				"2. 会計基準の選択に関する基本的な考え方 ……… 5",
				"3. 連結財務諸表及び主な注記 ………………… 6",
				"1. 経営成績等の概況",
				para,
				"2. 会計基準の選択に関する基本的な考え方",
			].join("\n");
			const out = qualitativeExcerpt(withRef, 10_000);
			expect(out).toMatch(/^1\. 経営成績等の概況\n/);
			expect(out).toContain(para);
			expect(out).not.toContain("ご覧ください");
		});

		it("定性見出しの無い資料は冒頭から切る", () => {
			expect(qualitativeExcerpt("説明資料\n\n\n需要は回復基調", 100)).toBe(
				"説明資料\n需要は回復基調",
			);
		});

		it("空白だけのテキストは空文字", () => {
			const ideographicSpace = String.fromCharCode(0x3000);
			expect(qualitativeExcerpt(` \n${ideographicSpace}\n`, 100)).toBe("");
		});
	});

	describe("pdfBody", () => {
		const title = "2027年3月期 第2四半期決算短信";
		const pdfUrl = "https://www.release.tdnet.info/inbs/140120261105500001.pdf";

		it("決算系でない見出しは PDF を取らず見出しを返す", async () => {
			const self = { fetch: vi.fn() } as unknown as Fetcher;
			const env = { SELF: self, USER_AGENT: "ua" };
			expect(await pdfBody(env, "役員の異動", pdfUrl)).toBe("役員の異動");
			expect(self.fetch).not.toHaveBeenCalled();
		});

		it("許可外ホストと pdfUrl なしは見出しを返す", async () => {
			const env = { USER_AGENT: "ua" };
			expect(await pdfBody(env, title, null)).toBe(title);
			const foreign = "https://example.com/a.pdf";
			expect(await pdfBody(env, title, foreign)).toBe(title);
		});

		it("SELF の /run?kind=pdf-text に投げ、抜粋を見出しの後ろに足す", async () => {
			const selfFetch = vi.fn(async (_url: string, _init?: RequestInit) =>
				Response.json({ ok: true, result: "需要は堅調" }),
			);
			const env = {
				SELF: { fetch: selfFetch } as unknown as Fetcher,
				SYNC_TOKEN: "tok",
				USER_AGENT: "ua",
			};
			expect(await pdfBody(env, title, pdfUrl)).toBe(`${title}\n\n需要は堅調`);
			const [url, init] = selfFetch.mock.calls[0];
			const q = new URL(url).searchParams;
			expect(q.get("kind")).toBe("pdf-text");
			expect(q.get("url")).toBe(pdfUrl);
			const auth = new Headers(init?.headers).get("authorization");
			expect(auth).toBe("Bearer tok");
		});

		it("別 invocation が失敗 (CPU 超過等の 5xx) したら見出しを返す", async () => {
			const env = {
				SELF: {
					fetch: async () => new Response("exceeded", { status: 503 }),
				} as unknown as Fetcher,
				USER_AGENT: "ua",
			};
			const err = vi.spyOn(console, "error").mockImplementation(() => {});
			expect(await pdfBody(env, title, pdfUrl)).toBe(title);
			err.mockRestore();
		});

		it("抜粋が空 (テキスト層なし) なら見出しを返す", async () => {
			const env = {
				SELF: {
					fetch: async () => Response.json({ ok: true, result: "" }),
				} as unknown as Fetcher,
				USER_AGENT: "ua",
			};
			expect(await pdfBody(env, title, pdfUrl)).toBe(title);
		});
	});

	describe("pdfExcerpt", () => {
		it("許可外ホストは fetch せずに投げる", async () => {
			await expect(
				pdfExcerpt("https://example.com/a.pdf", { USER_AGENT: "ua" }),
			).rejects.toThrow(/not allowed/);
		});

		it("PDF でない応答は投げる", async () => {
			const orig = globalThis.fetch;
			globalThis.fetch = (async () =>
				new Response("<html>login</html>", { status: 200 })) as typeof fetch;
			try {
				await expect(
					pdfExcerpt("https://www.release.tdnet.info/inbs/1.pdf", {
						USER_AGENT: "ua",
					}),
				).rejects.toThrow(/not a PDF/);
			} finally {
				globalThis.fetch = orig;
			}
		});
	});
}
