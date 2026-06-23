// Cloudflare Worker: 海外SOX系ピア決算カレンダーの収集。
//
// 背景: 監視4銘柄 (285A/6857/6920/6981) はいずれも半導体で、SOX (フィラデルフィア半導体指数)
// 経由で海外ピアの決算に強く連動する。MU/NVDA/AMAT 等の大物が決算を出すと、その結果次第で
// 翌日の SOX が振れ、日本の半導体株がギャップで寄る。これは「いつ起きるか先に分かる」スケジュール型
// イベントなので、FOMC/日銀 (macro-events.ts) と同じく事前にカレンダー化して judge/crash の
// prompt に「あとX日でMU決算→SOX変動リスク」を1行で載せたい。
//
// 保存先は macro_events テーブルを共用する (新テーブルを作らない)。PK = (date, kind) なので、
// 同じ日に複数社が決算を出すケース (NVDA と AMAT が同日 等) で衝突しないよう、kind に
// ティッカーを畳んで kind = `peer_earnings:<TICKER>` とする。event-context.sh はこの
// プレフィックスで peer 行を見分ける。
//
// データソース (Nasdaq, API キー不要。素の fetch だと 403 のためブラウザ風ヘッダで叩く):
//   主 : https://api.nasdaq.com/api/analyst/<TICKER>/earnings-date
//        data.announcement = "Earnings announcement* for MU: Jun 24, 2026" (次回確定/予定日)
//        欠落時は data.reportText 内の "06/24/2026" を拾う。
//   副 : https://api.nasdaq.com/api/company/<TICKER>/earnings-surprise
//        主が次回日を持たないとき (例: NVDA。Zacks 未提供) の保険。過去4Q の dateReported から
//        earnings.ts と同じ「前年同期の発表日 +1年」で推定する。
//
// 収集はレーティング/決算日と同じ流儀 (LLM 不使用、ティッカーごとにループ、INSERT OR REPLACE)。
// earnings.ts と同様、全社0件のときだけ例外を投げて既存データを守り、部分成功は保存する。

import { db } from "./db";
import { macroEvents } from "./schema";
import { sleep } from "./utils";

export interface PeerEarningsEnv {
	DB: D1Database;
	MIN_INTERVAL_MS: string;
}

// 監視対象セクター (semiconductor) を動かす海外ピア。config/peers.yaml と一致させること
// (Worker は読み取り専用FSで yaml を読めないため、実行時の真の出所はこの定数)。
// ピアの増減はここと config/peers.yaml の両方を直す。
const SOX_PEERS: { ticker: string; name: string; role: string }[] = [
	{ ticker: "MU", name: "マイクロン", role: "メモリ" },
	{ ticker: "NVDA", name: "エヌビディア", role: "GPU" },
	{ ticker: "AMAT", name: "アプライド", role: "前工程装置" },
	{ ticker: "LRCX", name: "ラムリサーチ", role: "前工程装置" },
	{ ticker: "KLAC", name: "KLA", role: "検査装置" },
	{ ticker: "ASML", name: "ASML", role: "露光装置" },
	{ ticker: "TSM", name: "TSMC", role: "ファウンドリ" },
];

const URL_EARNINGS_DATE = (t: string) =>
	`https://api.nasdaq.com/api/analyst/${t}/earnings-date`;
const URL_EARNINGS_SURPRISE = (t: string) =>
	`https://api.nasdaq.com/api/company/${t}/earnings-surprise`;

const MONTHS: Record<string, number> = {
	jan: 1,
	feb: 2,
	mar: 3,
	apr: 4,
	may: 5,
	jun: 6,
	jul: 7,
	aug: 8,
	sep: 9,
	oct: 10,
	nov: 11,
	dec: 12,
};

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function ymd(y: number, m: number, d: number): string {
	return `${y}-${pad2(m)}-${pad2(d)}`;
}

// YYYY-MM-DD の翌日。米決算は現地引け後発表が大半 = 日本の翌営業日 (近似で翌暦日) に効く。
function nextDay(iso: string): string {
	const [y, m, d] = iso.split("-").map((n) => Number.parseInt(n, 10));
	const t = new Date(Date.UTC(y, m - 1, d + 1));
	return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

// Nasdaq の JSON を取得する。api.nasdaq.com は素の fetch (bot UA) だと 403 を返すので、
// ブラウザ風 UA + Accept/Origin/Referer を付ける。失敗時は null (呼び出し側でフォールバック)。
async function fetchNasdaqJson(url: string): Promise<unknown | null> {
	try {
		const res = await fetch(url, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
				Accept: "application/json, text/plain, */*",
				"Accept-Language": "en-US,en;q=0.9",
				Origin: "https://www.nasdaq.com",
				Referer: "https://www.nasdaq.com/",
			},
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

// "Jun 24, 2026" / "06/24/2026" のような英語日付を YYYY-MM-DD に正規化する。拾えなければ null。
function parseUsDate(s: string | null | undefined): string | null {
	if (!s) return null;
	// "Mon DD, YYYY" 形式 (announcement / reportText に多い)。
	const m1 = s.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})/);
	if (m1) {
		const mon = MONTHS[m1[1].toLowerCase()];
		if (mon)
			return ymd(Number.parseInt(m1[3], 10), mon, Number.parseInt(m1[2], 10));
	}
	// "MM/DD/YYYY" 形式 (reportText / earnings-surprise の dateReported)。
	const m2 = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
	if (m2)
		return ymd(
			Number.parseInt(m2[3], 10),
			Number.parseInt(m2[1], 10),
			Number.parseInt(m2[2], 10),
		);
	return null;
}

// earnings-date レスポンスから次回決算日を取る。announcement を優先し、無ければ reportText。
function parseEarningsDate(json: unknown): string | null {
	const data = (
		json as { data?: { announcement?: string; reportText?: string } }
	)?.data;
	if (!data) return null;
	return parseUsDate(data.announcement) ?? parseUsDate(data.reportText);
}

// earnings-surprise の過去4Q (dateReported, fiscalQtrEnd) から次回決算日を推定する。
// earnings.ts と同じ思想: 直近実績の「次の四半期」= 前年同期の発表日 +1年。
// 行は新しい順に並ぶ (rows[0] が直近)。fiscalQtrEnd の月で四半期を識別する。
function estimateFromSurprise(json: unknown): string | null {
	const rows = (
		json as {
			data?: {
				earningsSurpriseTable?: {
					rows?: { fiscalQtrEnd?: string; dateReported?: string }[];
				};
			};
		}
	)?.data?.earningsSurpriseTable?.rows;
	if (!rows || rows.length === 0) return null;

	// "Apr 2026" → 月番号。決算サイクルは四半期 = 3ヶ月刻み。
	const monthOf = (q: string | undefined): number | null => {
		const m = (q ?? "").match(/([A-Za-z]{3})/);
		const mon = m ? MONTHS[m[1].toLowerCase()] : null;
		return mon ?? null;
	};

	// 直近実績 (rows[0]) の次四半期 = 四半期末月 +3。
	const lastMonth = monthOf(rows[0].fiscalQtrEnd);
	const lastDate = parseUsDate(rows[0].dateReported);
	if (lastMonth === null || !lastDate) return null;
	let nextMonth = lastMonth + 3;
	if (nextMonth > 12) nextMonth -= 12;

	// 前年同期 = 次四半期と同じ四半期末月を持つ過去行 (rows[0] 以外で最初に一致するもの)。
	const prior = rows
		.slice(1)
		.find((r) => monthOf(r.fiscalQtrEnd) === nextMonth);
	const priorDate = parseUsDate(prior?.dateReported);
	if (!priorDate) return null;

	// 前年同期の発表日 +1年。
	const [py, pm, pd] = priorDate.split("-").map((n) => Number.parseInt(n, 10));
	return ymd(py + 1, pm, pd);
}

// 1ピアの次回決算日を取得する。主 (earnings-date) → 副 (earnings-surprise 推定) の2段。
async function fetchPeerEarningsDate(
	ticker: string,
): Promise<{ date: string | null; via: string }> {
	const primary = await fetchNasdaqJson(URL_EARNINGS_DATE(ticker));
	const fromPrimary = parseEarningsDate(primary);
	if (fromPrimary) return { date: fromPrimary, via: "earnings-date" };

	const surprise = await fetchNasdaqJson(URL_EARNINGS_SURPRISE(ticker));
	const estimated = estimateFromSurprise(surprise);
	if (estimated) return { date: estimated, via: "surprise-estimate" };

	return { date: null, via: "none" };
}

type PeerEvent = {
	date: string;
	kind: string; // peer_earnings:<TICKER>
	label: string;
	impact: "high";
	jst_effect_date: string;
	note: string;
};

// 1ピアの (ティッカー, 社名, ロール, 決算日) から macro_events 行を組み立てる。
function toPeerEvent(
	ticker: string,
	name: string,
	role: string,
	date: string,
): PeerEvent {
	return {
		date,
		kind: `peer_earnings:${ticker}`,
		label: `${name}(${ticker}) 決算`,
		impact: "high",
		jst_effect_date: nextDay(date),
		note: `${role}の海外ピア。米引け後発表が大半 → 翌日 SOX が振れ日本の半導体株 (285A/6857/6920/6981) にギャップで波及。`,
	};
}

// 1イベントを D1 に保存。冪等キー = (date, kind=peer_earnings:<TICKER>)。
async function savePeerEvent(
	env: PeerEarningsEnv,
	e: PeerEvent,
): Promise<void> {
	const fetched_at = new Date().toISOString();
	await db(env.DB)
		.insert(macroEvents)
		.values({
			date: e.date,
			kind: e.kind,
			label: e.label,
			impact: e.impact,
			jstEffectDate: e.jst_effect_date,
			note: e.note,
			fetchedAt: fetched_at,
		})
		.onConflictDoUpdate({
			target: [macroEvents.date, macroEvents.kind],
			set: {
				label: e.label,
				impact: e.impact,
				jstEffectDate: e.jst_effect_date,
				note: e.note,
				fetchedAt: fetched_at,
			},
		})
		.run();
}

// ピア決算が古い予定日のまま残ると「過去に通過したのに未来扱い」になりうるが、event-context.sh は
// 「今日以降 DAYS 日以内」で絞るので、古い行は近接窓に入らず無害 (次回 collect で新しい日付に上書きされる)。

// SOX_PEERS (tickerFilter 指定時はその1社) の次回決算日を取得し macro_events に保存する。
// 全社0件 (Nasdaq 障害/構造変更の可能性) のときだけ例外を投げ、既存データを守る。
export async function collectPeerEarnings(
	env: PeerEarningsEnv,
	tickerFilter: string | null,
): Promise<Record<string, unknown>> {
	const peers = SOX_PEERS.filter(
		(p) => !tickerFilter || p.ticker === tickerFilter,
	);
	const interval = Number.parseInt(env.MIN_INTERVAL_MS, 10) || 5000;
	const results: Record<string, unknown> = {};
	let saved = 0;
	for (const p of peers) {
		try {
			const { date, via } = await fetchPeerEarningsDate(p.ticker);
			if (date) {
				await savePeerEvent(env, toPeerEvent(p.ticker, p.name, p.role, date));
				saved++;
				results[p.ticker] = { date, via };
			} else {
				results[p.ticker] = { date: null, via };
			}
		} catch (e) {
			results[p.ticker] = { error: (e as Error).message };
		}
		await sleep(interval);
	}
	if (saved === 0) {
		throw new Error(
			"peer-earnings: 取得0件 (Nasdaq 障害/構造変更の可能性)。保存をスキップ。",
		);
	}
	return { saved, results };
}

// in-source tests (本番ビルドでは tree-shake される。vitest.config.ts 参照)
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("parseUsDate", () => {
		it('"Mon DD, YYYY" を YYYY-MM-DD にする', () => {
			expect(parseUsDate("Jun 24, 2026")).toBe("2026-06-24");
			expect(parseUsDate("Earnings announcement* for MU: Jun 24, 2026")).toBe(
				"2026-06-24",
			);
			expect(parseUsDate("Aug 13, 2026")).toBe("2026-08-13");
		});
		it('"MM/DD/YYYY" を YYYY-MM-DD にする', () => {
			expect(parseUsDate("06/24/2026")).toBe("2026-06-24");
			expect(parseUsDate("5/20/2026")).toBe("2026-05-20");
		});
		it("空・null・日付なしは null", () => {
			expect(parseUsDate(null)).toBeNull();
			expect(parseUsDate("")).toBeNull();
			expect(parseUsDate("Earnings announcement* for NVDA: ")).toBeNull();
		});
	});

	describe("parseEarningsDate", () => {
		it("announcement を優先して拾う", () => {
			const json = {
				data: {
					announcement: "Earnings announcement* for MU: Jun 24, 2026",
					reportText: "... 06/24/2026 after market close ...",
				},
			};
			expect(parseEarningsDate(json)).toBe("2026-06-24");
		});
		it("announcement が空なら reportText に落ちる", () => {
			const json = {
				data: {
					announcement: "Earnings announcement* for X: ",
					reportText: "expected to report earnings on 08/13/2026 after close",
				},
			};
			expect(parseEarningsDate(json)).toBe("2026-08-13");
		});
		it("どちらも無ければ null (NVDA: Zacks 未提供)", () => {
			const json = {
				data: {
					announcement: "Earnings announcement* for NVDA: ",
					reportText:
						"Our vendor, Zacks Investment Research, hasn't provided us with the upcoming earnings report date.",
				},
			};
			expect(parseEarningsDate(json)).toBeNull();
		});
	});

	describe("estimateFromSurprise", () => {
		// NVDA 実データ: 直近 Apr 2026 (5/20/2026) → 次Q末月 = Jul。前年同期 Jul 2025 (8/27/2025) +1年。
		it("直近実績の次四半期 = 前年同期の発表日 +1年 で推定する", () => {
			const json = {
				data: {
					earningsSurpriseTable: {
						rows: [
							{ fiscalQtrEnd: "Apr 2026", dateReported: "5/20/2026" },
							{ fiscalQtrEnd: "Jan 2026", dateReported: "2/25/2026" },
							{ fiscalQtrEnd: "Oct 2025", dateReported: "11/19/2025" },
							{ fiscalQtrEnd: "Jul 2025", dateReported: "8/27/2025" },
						],
					},
				},
			};
			expect(estimateFromSurprise(json)).toBe("2026-08-27");
		});
		it("年跨ぎ (次Q末月が翌年) でも前年同期を引く", () => {
			// 直近 Oct → 次Q末月 = Jan。前年同期 Jan の行 +1年。
			const json = {
				data: {
					earningsSurpriseTable: {
						rows: [
							{ fiscalQtrEnd: "Oct 2025", dateReported: "11/19/2025" },
							{ fiscalQtrEnd: "Jan 2025", dateReported: "2/26/2025" },
						],
					},
				},
			};
			expect(estimateFromSurprise(json)).toBe("2026-02-26");
		});
		it("前年同期の行が無ければ null", () => {
			const json = {
				data: {
					earningsSurpriseTable: {
						rows: [{ fiscalQtrEnd: "Apr 2026", dateReported: "5/20/2026" }],
					},
				},
			};
			expect(estimateFromSurprise(json)).toBeNull();
		});
		it("rows が空なら null", () => {
			expect(
				estimateFromSurprise({ data: { earningsSurpriseTable: { rows: [] } } }),
			).toBeNull();
		});
	});

	describe("toPeerEvent", () => {
		const e = toPeerEvent("MU", "マイクロン", "メモリ", "2026-06-24");
		it("kind にティッカーを畳み込む (同日複数社の衝突回避)", () => {
			expect(e.kind).toBe("peer_earnings:MU");
		});
		it("label は 社名(ティッカー) 決算", () => {
			expect(e.label).toBe("マイクロン(MU) 決算");
		});
		it("jst_effect_date は決算翌日・impact=high", () => {
			expect(e.jst_effect_date).toBe("2026-06-25");
			expect(e.impact).toBe("high");
		});
		it("年末跨ぎでも翌日を返す", () => {
			expect(toPeerEvent("X", "x", "r", "2026-12-31").jst_effect_date).toBe(
				"2027-01-01",
			);
		});
	});
}
