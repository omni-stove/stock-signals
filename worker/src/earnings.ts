// Cloudflare Worker: 次回決算発表予定日の推定
//
// ローカルの scripts/fetch-earnings-date.ts を Worker に移植したもの。
// kabutan finance ページ (https://kabutan.jp/stock/finance?code=<code>) の
// 四半期業績テーブルから「直近実績の次四半期 = 前年同期の発表日 +1年」で推定する。
//
// ローカル版は watchlist.yaml の next_earnings_date を書き換えていたが、Worker は
// 読み取り専用FSで yaml に書き戻せないため、推定結果は D1 の earnings テーブルに保持する。
// signal-report は /latest?kind=earnings でこれを読み、決算が近ければ confidence をキャップする。
//
// 全ソース UTF-8 なので TextDecoder で十分。

import * as cheerio from "cheerio";

export interface EarningsEnv {
	DB: D1Database;
	USER_AGENT: string;
	MIN_INTERVAL_MS: string;
}

const WATCHLIST: string[] = ["285A", "6857", "6920", "6981"];
const URL_FINANCE = (code: string) =>
	`https://kabutan.jp/stock/finance?code=${code}`;

type Quarter = { y: number; startM: number; endM: number; raw: string };

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function fetchHtml(url: string, env: EarningsEnv): Promise<string> {
	const res = await fetch(url, { headers: { "User-Agent": env.USER_AGENT } });
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	const buf = await res.arrayBuffer();
	return new TextDecoder("utf-8").decode(buf);
}

// 四半期ラベル "25.04-06" -> { y: 2025, startM: 4, endM: 6, raw }
function parseQLabel(label: string): Quarter | null {
	const m = label.match(/(\d{2})\.(\d{2})-(\d{2})/);
	if (!m) return null;
	return {
		y: 2000 + Number(m[1]),
		startM: Number(m[2]),
		endM: Number(m[3]),
		raw: m[0],
	};
}

// kabutan 発表日 "26/04/30" -> "2026-04-30"
function parseAnnounce(s: string | null | undefined): string | null {
	const m = (s ?? "").match(/(\d{2})\/(\d{2})\/(\d{2})/);
	return m ? `20${m[1]}-${m[2]}-${m[3]}` : null;
}

// finance ページから「四半期実績が最も多く並ぶテーブル」の行を抽出。
// 各行: 四半期(YY.MM-MM) + 発表日。「予」付き行(予想)・「前年同期比」行は除外する。
type QuarterRow = { q: Quarter; announce: string | null };

function extractQuarterRows(html: string): QuarterRow[] {
	const $ = cheerio.load(html);
	// 「決算期」「発表日」ヘッダを持つテーブルのうち、実績四半期行が最も多いものを採用する。
	let bestRows: QuarterRow[] = [];

	for (const table of $("table").toArray()) {
		const $t = $(table);
		const headers = $t
			.find("thead th")
			.map((_, th) => $(th).text().trim())
			.get();
		if (!(headers.includes("決算期") && headers.includes("発表日"))) continue;

		const rows: QuarterRow[] = [];
		for (const tr of $t.find("tbody tr").toArray()) {
			const cells = $(tr).find("th, td");
			const label = cells.first().text().replace(/\s+/g, " ").trim();
			if (/予/.test(label)) continue; // 予想行は推定の土台にしない
			const q = parseQLabel(label);
			if (!q) continue; // 「前年同期比(%)」などの注記行はスキップ
			rows.push({ q, announce: parseAnnounce(cells.last().text()) });
		}

		if (rows.length > bestRows.length) bestRows = rows;
	}

	return bestRows;
}

// 四半期実績行から次回決算発表予定日 (YYYY-MM-DD) を推定する。
function estimateNextEarningsDate(html: string): {
	est: string | null;
	detail: string;
} {
	const rows = extractQuarterRows(html).filter((r) => r.announce);
	if (rows.length === 0) return { est: null, detail: "no quarterly rows" };

	rows.sort((a, b) => a.q.y - b.q.y || a.q.startM - b.q.startM);
	const last = rows[rows.length - 1];

	let nextStartM = last.q.startM + 3;
	let nextStartY = last.q.y;
	if (nextStartM > 12) {
		nextStartM -= 12;
		nextStartY += 1;
	}

	const prior = rows.find(
		(r) => r.q.startM === nextStartM && r.q.y === nextStartY - 1,
	);
	if (!prior?.announce) {
		return {
			est: null,
			detail: `last=${last.q.raw}(${last.announce}) nextQ=${String(nextStartM).padStart(2, "0")}月 prior=none`,
		};
	}

	const d = new Date(`${prior.announce}T00:00:00Z`);
	d.setUTCFullYear(d.getUTCFullYear() + 1);
	const est = d.toISOString().slice(0, 10);

	return {
		est,
		detail: `last=${last.q.raw}(${last.announce}) prior=${prior.q.raw}(${prior.announce}) → ${est}`,
	};
}

async function saveEarnings(
	env: EarningsEnv,
	ticker: string,
	next_date: string | null,
	detail: string,
): Promise<void> {
	await env.DB.prepare(
		`INSERT OR REPLACE INTO earnings (ticker, next_date, detail, fetched_at) VALUES (?, ?, ?, ?)`,
	)
		.bind(ticker, next_date, detail, new Date().toISOString())
		.run();
}

// watchlist 全銘柄 (codeFilter 指定時はその1銘柄) の次回決算予定日を推定し D1 に保存。
export async function collectEarnings(
	env: EarningsEnv,
	codeFilter: string | null,
): Promise<Record<string, unknown>> {
	const codes = WATCHLIST.filter((c) => !codeFilter || c === codeFilter);
	const interval = parseInt(env.MIN_INTERVAL_MS, 10) || 5000;
	const results: Record<string, unknown> = {};
	for (const code of codes) {
		try {
			const html = await fetchHtml(URL_FINANCE(code), env);
			const { est, detail } = estimateNextEarningsDate(html);
			await saveEarnings(env, code, est, detail);
			results[code] = { next_date: est, detail };
		} catch (e) {
			results[code] = { error: (e as Error).message };
		}
		await sleep(interval);
	}
	return results;
}
