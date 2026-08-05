// Cloudflare Worker: 収集モジュール共通のユーティリティ (hash / sleep / fetchHtml)。

// 指定ミリ秒だけ待つ (kabutan への連続アクセス間隔調整に使う)。
export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// URL → 短い 8桁16進ハッシュ (R2キー用)。FNV 風の 31 倍ローリング。
export function hash(s: string): string {
	let h = 0;
	for (let i = 0; i < s.length; i++) {
		h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

// fetchHtml の1リクエストあたりタイムアウトと、再試行前の待機。
// cron はこの fetch の後ろに dispatch / Slack 通知が控えるため、ハングで無期限に
// 止まらないよう必ず打ち切る。
const FETCH_TIMEOUT_MS = 10_000;
const RETRY_PAUSE_MS = 1_000;

// URL を GET し UTF-8 文字列で返す。全ソース UTF-8 (調査済) なので TextDecoder で十分。
// env からは User-Agent だけ使うので、USER_AGENT を持つ任意の Env を受ける。
// タイムアウト/ネットワーク断/5xx は1回だけ再試行する。4xx は再試行しても変わらないので即投げる。
export async function fetchHtml(
	url: string,
	env: { USER_AGENT: string },
): Promise<string> {
	const attempt = async (): Promise<string> => {
		const res = await fetch(url, {
			headers: { "User-Agent": env.USER_AGENT },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) {
			const err = new Error(`HTTP ${res.status} ${url}`) as Error & {
				status: number;
			};
			err.status = res.status;
			throw err;
		}
		const buf = await res.arrayBuffer();
		return new TextDecoder("utf-8").decode(buf);
	};
	try {
		return await attempt();
	} catch (e) {
		const status = (e as { status?: number }).status;
		if (status !== undefined && status < 500) throw e;
		await sleep(RETRY_PAUSE_MS);
		return attempt();
	}
}

// ── HTML 部分切り出し ────────────────────────────────────────────────────────
// パーサ (html.ts の HTMLRewriter) に流す前に、対象ブロックだけを indexOf 走査で
// 切り出して流すバイト数を絞る。keyword で対象テーブル群を選ぶ用途も兼ねる。
// マーカーが見つからないページ (DOM 変更等) では null を返し、呼び出し側はフルページの
// parse にフォールバックする — 節約より欠測回避を優先。

// startMarker から、その後最初に現れる endMarker の末尾までを返す。
export function sliceHtml(
	html: string,
	startMarker: string,
	endMarker: string,
): string | null {
	const s = html.indexOf(startMarker);
	if (s < 0) return null;
	const e = html.indexOf(endMarker, s + startMarker.length);
	if (e < 0) return null;
	return html.slice(s, e + endMarker.length);
}

// keywords のいずれかを含む <table …>…</table> を出現順に連結して返す。
// 対象サイト (kabutan) のテーブルは入れ子にならない前提 (入れ子だと内側の </table> で切れる)。
export function sliceTables(
	html: string,
	...keywords: string[]
): string | null {
	const out: string[] = [];
	let from = 0;
	for (;;) {
		const t = html.indexOf("<table", from);
		if (t < 0) break;
		const e = html.indexOf("</table>", t);
		if (e < 0) break;
		from = e + "</table>".length;
		const frag = html.slice(t, from);
		if (keywords.some((k) => frag.includes(k))) out.push(frag);
	}
	return out.length > 0 ? out.join("\n") : null;
}

// 記事日付文字列を YYYY-MM-DD に正規化 (published_at / R2キー用)。
// kabutan は場所により年4桁・年2桁 (開示行の "26/07/02 17:00")・年なし ("06/18") が混在する:
//   - 年4桁はそのまま、年2桁 (YY/MM/DD) は 2000+YY で補完。
//   - 年なし MM/DD は epochNow の JST 年で補完する。補完結果が7日超の未来になる場合は
//     年またぎ (1月に前年12月の記事を読む) とみなして前年にする。
//   - 月・日が暦に収まらない場合と日付が取れない場合は "unknown"。
// 年補完せず "MM-DD" のまま保存すると、pull 側の published_at 足切り
// (gte "YYYY-MM-DD" の文字列比較) に永久に落ちて判定から消えるため、必ず年を付ける。
export function normArticleDate(raw: string, epochNow: number): string {
	const m = raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
	if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
	const yy = raw.match(/(\d{2})[-/](\d{1,2})[-/](\d{1,2})/);
	if (yy)
		return `20${yy[1]}-${yy[2].padStart(2, "0")}-${yy[3].padStart(2, "0")}`;
	const md = raw.match(/(\d{1,2})[-/](\d{1,2})/);
	if (md) {
		const mm = parseInt(md[1], 10);
		const dd = parseInt(md[2], 10);
		if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return "unknown";
		const jstNow = epochNow + 9 * 3600_000;
		const year = new Date(jstNow).getUTCFullYear();
		const pad = (n: number) => String(n).padStart(2, "0");
		const candidate = `${year}-${pad(mm)}-${pad(dd)}`;
		const future = Date.parse(`${candidate}T00:00:00Z`) - jstNow;
		return future > 7 * 86400_000
			? `${year - 1}-${pad(mm)}-${pad(dd)}`
			: candidate;
	}
	return "unknown";
}

// in-source tests (本番ビルドでは tree-shake される。vitest.config.ts 参照)
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("hash", () => {
		it("常に 8 桁の 16 進文字列を返す", () => {
			for (const s of ["", "a", "https://kabutan.jp/stock/?code=6857"]) {
				expect(hash(s)).toMatch(/^[0-9a-f]{8}$/);
			}
		});

		it("同じ入力には同じ値 (決定的)", () => {
			expect(hash("6857")).toBe(hash("6857"));
		});

		it("異なる入力には異なる値を返す (代表ケース)", () => {
			expect(hash("6857")).not.toBe(hash("6858"));
		});
	});

	describe("fetchHtml", () => {
		const env = { USER_AGENT: "test-ua" };
		const origFetch = globalThis.fetch;
		// 各テスト後に fetch を元へ戻す (他テストへの汚染防止)。
		const restore = () => {
			globalThis.fetch = origFetch;
		};

		it("200 OK は本文を UTF-8 文字列で返す", async () => {
			globalThis.fetch = (async () =>
				new Response(new TextEncoder().encode("こんにちは"), {
					status: 200,
				})) as typeof fetch;
			try {
				expect(await fetchHtml("https://x.test/", env)).toBe("こんにちは");
			} finally {
				restore();
			}
		});

		it("4xx は再試行せず HTTP ステータス付き Error を即投げる", async () => {
			let calls = 0;
			globalThis.fetch = (async () => {
				calls++;
				return new Response("nope", { status: 404 });
			}) as typeof fetch;
			try {
				await expect(fetchHtml("https://x.test/missing", env)).rejects.toThrow(
					/HTTP 404 https:\/\/x\.test\/missing/,
				);
				expect(calls).toBe(1);
			} finally {
				restore();
			}
		});

		it("5xx は1回だけ再試行し、成功すれば本文を返す", async () => {
			let calls = 0;
			globalThis.fetch = (async () => {
				calls++;
				return calls === 1
					? new Response("busy", { status: 503 })
					: new Response("ok", { status: 200 });
			}) as typeof fetch;
			try {
				expect(await fetchHtml("https://x.test/", env)).toBe("ok");
				expect(calls).toBe(2);
			} finally {
				restore();
			}
		}, 15_000);

		it("ネットワーク断 (fetch reject) も1回だけ再試行し、再失敗なら投げる", async () => {
			let calls = 0;
			globalThis.fetch = (async () => {
				calls++;
				throw new Error("network down");
			}) as typeof fetch;
			try {
				await expect(fetchHtml("https://x.test/", env)).rejects.toThrow(
					/network down/,
				);
				expect(calls).toBe(2);
			} finally {
				restore();
			}
		}, 15_000);

		it("User-Agent ヘッダを env から渡す", async () => {
			let sentUa: string | null = null;
			globalThis.fetch = (async (_url: string, init?: RequestInit) => {
				sentUa = new Headers(init?.headers).get("User-Agent");
				return new Response("ok", { status: 200 });
			}) as typeof fetch;
			try {
				await fetchHtml("https://x.test/", env);
				expect(sentUa).toBe("test-ua");
			} finally {
				restore();
			}
		});
	});

	describe("sliceHtml", () => {
		const html =
			"<head><title>t</title></head><div id='a'>body<span>x</span></div><footer>f</footer>";

		it("startMarker から endMarker の末尾までを返す", () => {
			expect(sliceHtml(html, "<div id='a'>", "</div>")).toBe(
				"<div id='a'>body<span>x</span></div>",
			);
		});
		it("endMarker は startMarker より後ろから探す", () => {
			expect(sliceHtml(html, "<title", "</title>")).toBe("<title>t</title>");
		});
		it("マーカーが見つからなければ null (呼び出し側がフルページへフォールバック)", () => {
			expect(sliceHtml(html, "<article", "</article>")).toBeNull();
			expect(sliceHtml(html, "<div id='a'>", "</article>")).toBeNull();
		});
	});

	describe("sliceTables", () => {
		const html = [
			"<p>head</p>",
			"<table class='nav'><tr><td>menu</td></tr></table>",
			"<table class='s_news_list'><tr><td>news1</td></tr></table>",
			"<table><thead><th>PER</th></thead><tr><td>12.3</td></tr></table>",
			"<p>tail</p>",
		].join("\n");

		it("keyword を含むテーブルだけを返す", () => {
			expect(sliceTables(html, "s_news_list")).toBe(
				"<table class='s_news_list'><tr><td>news1</td></tr></table>",
			);
		});
		it("複数 keyword はいずれか一致で拾い、出現順に連結する", () => {
			const frag = sliceTables(html, "s_news_list", "PER");
			expect(frag).toContain("news1");
			expect(frag).toContain("12.3");
			expect(frag).not.toContain("menu");
		});
		it("一致するテーブルが無ければ null", () => {
			expect(sliceTables(html, "stock_kabuka")).toBeNull();
		});
	});

	describe("normArticleDate", () => {
		const now = new Date("2026-06-24T03:00:00Z").getTime(); // JST 2026-06-24 12:00

		it("4桁年つきはそのまま YYYY-MM-DD に正規化する", () => {
			expect(normArticleDate("2026/6/8", now)).toBe("2026-06-08");
			expect(normArticleDate("2026-06-19T09:06:00+09:00", now)).toBe(
				"2026-06-19",
			);
		});
		it("年なし MM/DD は epochNow の JST 年で補完する", () => {
			expect(normArticleDate("06/18", now)).toBe("2026-06-18");
			expect(normArticleDate("06/26 11:47", now)).toBe("2026-06-26");
		});
		it("年2桁 YY/MM/DD は 20YY-MM-DD に補完する (kabutan 開示行の形式)", () => {
			expect(normArticleDate("26/07/02 17:00", now)).toBe("2026-07-02");
			expect(normArticleDate("26/5/9", now)).toBe("2026-05-09");
		});
		it("補完結果が7日超の未来なら年またぎとみなして前年にする", () => {
			const jan = new Date("2026-01-03T03:00:00Z").getTime(); // JST 2026-01-03
			expect(normArticleDate("12/28", jan)).toBe("2025-12-28");
		});
		it("7日以内の未来 (予定記事等) は当年のまま", () => {
			const late = new Date("2026-06-28T03:00:00Z").getTime();
			expect(normArticleDate("07/02", late)).toBe("2026-07-02");
		});
		it("UTC と JST で年がずれる境界は JST の年を使う", () => {
			// UTC 2025-12-31 15:30 = JST 2026-01-01 00:30
			const nye = new Date("2025-12-31T15:30:00Z").getTime();
			expect(normArticleDate("01/01", nye)).toBe("2026-01-01");
		});
		it("月・日が暦に収まらないものは unknown (YY/MM の誤読ガード)", () => {
			expect(normArticleDate("26/05", now)).toBe("unknown");
			expect(normArticleDate("13/40", now)).toBe("unknown");
		});
		it("日付が取れなければ unknown", () => {
			expect(normArticleDate("日付不明", now)).toBe("unknown");
		});
	});
}
