// Cloudflare Worker: 信用取引残高 (信用残) の収集
//
// 週次の需給データを kabutan 個別ページ (https://kabutan.jp/stock/?code=<code>) 内の信用残
// テーブル (日付 / 売り残 / 買い残 / 倍率) から取得し D1 margin に蓄積する。1回で過去5週が返る。
// 冪等キー = (ticker, 集計基準日)。毎日取っても1週1行に収束する流儀は schema.sql の margin を参照。

import * as cheerio from "cheerio";
import { WATCHLIST } from "./timeseries";
import { fetchHtml, sleep } from "./utils";

export interface MarginEnv {
	DB: D1Database;
	USER_AGENT: string;
	MIN_INTERVAL_MS: string;
}

// 個別銘柄ページに信用残テーブルが同梱される (専用 shinyo ページは JS 描画で素取りできない)。
const URL_MARGIN = (code: string) => `https://kabutan.jp/stock/?code=${code}`;
const SITE = "kabutan";

function toNumber(raw: string | undefined | null): number | null {
	if (!raw) return null;
	const cleaned = raw.replace(/[,倍円株%％]/g, "").trim();
	if (!cleaned || cleaned === "－" || cleaned === "-") return null;
	const n = Number(cleaned);
	return Number.isFinite(n) ? n : null;
}

// kabutan の信用残テーブルの日付は "06/12" (MM/DD, 年なし)。取得時刻 (UTC) を JST 基準日と
// みなし、「その月日が今年だと未来になるなら前年」で年を補完して YYYY-MM-DD にする。
// 信用残は過去5週なので、年末年始 (1月に12月の週次が残る) でも未来判定で正しく前年に倒れる。
function normalizeMarginDate(mmdd: string, nowIso: string): string | null {
	const m = mmdd.match(/(\d{1,2})\/(\d{1,2})/);
	if (!m) return null;
	const mm = m[1].padStart(2, "0");
	const dd = m[2].padStart(2, "0");
	// nowIso (UTC) の暦日。JST との時差で1日ズレても「未来なら前年」の判定には影響しない
	// (週次データは最新でも数日前なので、境界の1日ズレで年が誤ることはない)。
	const today = nowIso.slice(0, 10); // YYYY-MM-DD
	const year = Number(today.slice(0, 4));
	const candidate = `${year}-${mm}-${dd}`;
	// 当年の月日が今日より後 = まだ来ていない月日なら前年扱い。
	return candidate > today ? `${year - 1}-${mm}-${dd}` : candidate;
}

type MarginRow = {
	date: string; // YYYY-MM-DD (正規化済み)
	short_qty: number | null;
	long_qty: number | null;
	ratio: number | null;
};

// 個別ページから信用残テーブル (ヘッダに「売り残」「買い残」「倍率」を持つ table) を抽出する。
// 行 = 日付(MM/DD) / 売り残 / 買い残 / 倍率。日付は normalizeMarginDate で YYYY-MM-DD に正規化。
function parseKabutanMargin(html: string, nowIso: string): MarginRow[] {
	const $ = cheerio.load(html);
	const rows: MarginRow[] = [];

	$("table").each((_, table) => {
		if (rows.length > 0) return; // 最初に見つかった信用残テーブルだけ使う
		const $t = $(table);
		const headers = $t
			.find("thead th")
			.map((_, th) => $(th).text().trim())
			.get();
		// 「売り残」「買い残」「倍率」を持つテーブルが信用残テーブル。
		if (
			!(
				headers.includes("売り残") &&
				headers.includes("買い残") &&
				headers.includes("倍率")
			)
		)
			return;

		$t.find("tbody tr").each((_, tr) => {
			const cells = $(tr).find("th, td");
			if (cells.length < 4) return;
			const date = normalizeMarginDate(cells.eq(0).text().trim(), nowIso);
			if (!date) return;
			rows.push({
				date,
				short_qty: toNumber(cells.eq(1).text()),
				long_qty: toNumber(cells.eq(2).text()),
				ratio: toNumber(cells.eq(3).text()),
			});
		});
	});

	return rows;
}

async function collectMarginOne(
	env: MarginEnv,
	code: string,
): Promise<{ written: number; skipped: number }> {
	const html = await fetchHtml(URL_MARGIN(code), env);
	const fetched_at = new Date().toISOString();
	const bars = parseKabutanMargin(html, fetched_at);
	if (bars.length === 0) return { written: 0, skipped: 0 };
	const source = `${SITE}:${code}`;

	// (ticker, date) PK の INSERT OR IGNORE で既取得の週次行を自動スキップ。
	const stmt = env.DB.prepare(
		`INSERT OR IGNORE INTO margin
       (ticker, date, source, short_qty, long_qty, ratio, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	const batch = bars.map((b) =>
		stmt.bind(
			code,
			b.date,
			source,
			b.short_qty,
			b.long_qty,
			b.ratio,
			fetched_at,
		),
	);
	const results = await env.DB.batch(batch);
	let written = 0;
	for (const r of results) written += r.meta.changes ?? 0;
	return { written, skipped: bars.length - written };
}

// watchlist 全銘柄 (codeFilter 指定時はその1銘柄) の信用残を収集し D1 margin に保存。
// 1銘柄が落ちても他は続行 (timeseries の collectTimeseries と同じ流儀)。
// freshTickers = 今回「新しい週次行が書けた」銘柄 (written > 0)。週1更新なので新しい集計
// 基準日が公表された夜だけ乗り、20:00 intake で他の収集と束ねて1回 dispatch される。
export async function collectMargin(
	env: MarginEnv,
	codeFilter: string | null,
): Promise<{ results: Record<string, unknown>; freshTickers: string[] }> {
	const codes = WATCHLIST.filter((c) => !codeFilter || c === codeFilter);
	const interval = parseInt(env.MIN_INTERVAL_MS, 10) || 5000;
	const results: Record<string, unknown> = {};
	const freshTickers: string[] = [];
	let first = true;
	for (const code of codes) {
		if (!first) await sleep(interval);
		first = false;
		try {
			const r = await collectMarginOne(env, code);
			results[code] = r;
			if (r.written > 0) freshTickers.push(code);
		} catch (e) {
			results[code] = { error: (e as Error).message };
		}
	}
	return { results, freshTickers };
}
