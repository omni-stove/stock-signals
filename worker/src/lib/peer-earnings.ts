// Cloudflare Worker: 海外SOX系ピア決算カレンダーの収集。
//
// 監視銘柄の多くは半導体関連で、SOX (フィラデルフィア半導体指数) 経由で海外ピアの決算に
// 連動しうる (効き方は銘柄ごとに違う)。MU/NVDA/AMAT 等の大物が決算を出すと、その結果次第で
// 翌日の SOX が振れ、日本の半導体株がギャップで寄る。これは「いつ起きるか先に分かる」スケジュール型
// イベントなので、FOMC/日銀 (macro-events.ts) と同じく事前にカレンダー化し、judge/crash の
// prompt に「あとX日でMU決算→SOX変動リスク」を1行で載せる。
//
// 保存先は macro_events テーブルを共用する (新テーブルを作らない)。PK = (date, kind) なので、
// 同じ日に複数社が決算を出すケース (NVDA と AMAT が同日 等) で衝突しないよう、kind に
// ティッカーを畳んで kind = `peer_earnings:<TICKER>` とする。event-context.ts はこの
// プレフィックスで peer 行を見分ける。
//
// データソース (Nasdaq, API キー不要。素の fetch だと 403 のためブラウザ風ヘッダで叩く):
//   主 : https://api.nasdaq.com/api/analyst/<TICKER>/earnings-date
//        data.announcement = "Earnings announcement* for MU: Jun 24, 2026" (次回確定/予定日)
//        欠落時は data.reportText 内の "06/24/2026" を拾う。
//   副 : https://api.nasdaq.com/api/company/<TICKER>/earnings-surprise
//        主が次回日を持たないとき (例: NVDA。Zacks 未提供) の保険。過去4Q の dateReported から
//        earnings.ts と同じ「前年同期の発表日 +1年」で推定する。推定日は label に (推定日) を付ける。
//        発表直後は主が空になり副の表がまだ直近決算を含まないため、副は通過したばかりの四半期を
//        「前年同期 +1年」で再推定してしまう。直近に通過した決算から MIN_QUARTER_GAP_DAYS 以内の
//        推定は捨てる。
//
// 日付 (date) は発表地の現地日。jst_effect_date は東証で初めて反応できる営業日 = date の翌営業日
// (米引け後は日本の翌早朝、ASML/TSMC は日本の午後で東証の引け前後に出る)。label には日本時間で
// いつ出るかを添える。同じピアの未来の行は最新の取得日だけを残す (推定日→確定日の切替で古い行が残らない)。
//
// 収集はレーティング/決算日と同じ流儀 (LLM 不使用、ティッカーごとにループ、INSERT OR REPLACE)。
// earnings.ts と同様、全社0件のときだけ例外を投げて既存データを守り、部分成功は保存する。

import { and, desc, eq, gt, lte, ne } from "drizzle-orm";
import { db } from "./db";
import {
	estimateNextEarningsDate,
	loadEarningsSchedule,
	resolveNextDate,
	URL_FINANCE,
} from "./earnings";
import { nextTseBusinessDay } from "./market-calendar";
import { macroEvents } from "./schema";
import { addDays, fetchHtml, jstDate, sleep } from "./utils";

export interface PeerEarningsEnv {
	DB: D1Database;
	MIN_INTERVAL_MS: string;
	// 国内ピア (kabutan スクレイプ) 用。海外ピア (Nasdaq) はブラウザ風ヘッダ固定なので使わない。
	USER_AGENT: string;
}

// 監視対象セクター (semiconductor) を動かす海外ピア。config/peers.yaml と一致させること
// (Worker は読み取り専用FSで yaml を読めないため、実行時の真の出所はこの定数)。
// ピアの増減はここと config/peers.yaml の両方を直す。premarket.ts が前夜の騰落も取る。
// release は決算の発表タイミング: after_close = 米国の引け後 (その日の終値に未反映) /
// before_open = 米国の寄り前 (その日の終値に反映済み。ASML は欧州朝、TSMC は台湾午後)。
export type PeerRelease = "after_close" | "before_open";
export const SOX_PEERS: {
	ticker: string;
	name: string;
	role: string;
	release: PeerRelease;
}[] = [
	{ ticker: "MU", name: "マイクロン", role: "メモリ", release: "after_close" },
	{ ticker: "NVDA", name: "エヌビディア", role: "GPU", release: "after_close" },
	{
		ticker: "AMAT",
		name: "アプライド",
		role: "前工程装置",
		release: "after_close",
	},
	{
		ticker: "LRCX",
		name: "ラムリサーチ",
		role: "前工程装置",
		release: "after_close",
	},
	{ ticker: "KLAC", name: "KLA", role: "検査装置", release: "after_close" },
	{ ticker: "ASML", name: "ASML", role: "露光装置", release: "before_open" },
	{ ticker: "TSM", name: "TSMC", role: "ファウンドリ", release: "before_open" },
];

// 国内ピアと、その決算が先に出る監視銘柄 (leads)。同日発表のピアは翌日の値動きが揃うだけで
// 先に読める中身が無いので、決算が毎四半期その監視銘柄より前の日に出て、受注・見通しがその
// 監視銘柄の業績に当てはまる組だけを持つ。監視銘柄 (6857) も他の監視銘柄に先行するので並べる。
// config/peers.yaml と一致させること (増減は両方を直す)。
const JP_PEERS: {
	code: string;
	name: string;
	role: string;
	leads: string[];
}[] = [
	{
		code: "6146",
		name: "ディスコ",
		role: "後工程装置",
		leads: ["6857", "6920", "285A"],
	},
	{
		code: "6857",
		name: "アドバンテスト",
		role: "テスター",
		leads: ["6920", "285A"],
	},
	{ code: "6981", name: "村田製作所", role: "電子部品", leads: ["6976"] },
	{ code: "6762", name: "TDK", role: "電子部品", leads: ["6976"] },
];

/**
 * macro_events 行から、ticker に先行しない国内ピア決算 (kind=peer_earnings_jp:*) を除く。
 * ticker が null (市場全体の文脈) なら国内ピア決算をすべて除く。他の kind はそのまま返す。
 */
export function macroRowsFor<T extends { kind?: string | null }>(
	rows: T[],
	ticker: string | null,
): T[] {
	return rows.filter((r) => {
		const kind = r.kind ?? "";
		if (!kind.startsWith("peer_earnings_jp:")) return true;
		const code = kind.slice("peer_earnings_jp:".length);
		return (
			ticker != null &&
			(JP_PEERS.find((p) => p.code === code)?.leads.includes(ticker) ?? false)
		);
	});
}

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

// 四半期決算どうしの最短間隔の目安 (日)。これより近い推定は通過済みの四半期の再推定とみなす。
const MIN_QUARTER_GAP_DAYS = 45;

// epoch ミリ秒を米東部の暦日 (YYYY-MM-DD) にする。Nasdaq の日付は米東部の現地日なので、
// 「通過済みか」はこの暦日で判定する。
function usEasternDate(epochMs: number): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "America/New_York",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(epochMs);
}

// "2026-11-17" → "11/17"。
function md(iso: string): string {
	const [, m, d] = iso.split("-").map((n) => Number.parseInt(n, 10));
	return `${m}/${d}`;
}

// 現地の発表日 date が日本時間でいつに当たるか。
function releaseInJst(release: PeerRelease, date: string): string {
	return release === "after_close"
		? `米${md(date)}引け後=日本${md(addDays(date, 1))}早朝`
		: `日本${md(date)}午後`;
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
// 直近実績の「次の四半期」= 前年同期の発表日 +1年。
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
async function fetchPeerEarningsDate(ticker: string): Promise<{
	date: string | null;
	via: "earnings-date" | "surprise-estimate" | "none";
}> {
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
	kind: string; // peer_earnings:<TICKER> (海外) / peer_earnings_jp:<code> (国内)
	label: string;
	impact: "high";
	jst_effect_date: string;
	note: string;
};

// 推定日 estimate が、直近に通過した決算日 lastPassed から四半期に満たない (= 通過済み四半期の再推定)。
function isStaleEstimate(estimate: string, lastPassed: string | null): boolean {
	if (!lastPassed) return false;
	const gap =
		(Date.parse(`${estimate}T00:00:00Z`) -
			Date.parse(`${lastPassed}T00:00:00Z`)) /
		86_400_000;
	return gap < MIN_QUARTER_GAP_DAYS;
}

// 1ピアと決算日 (発表地の現地日) から macro_events 行を組み立てる。
function toPeerEvent(
	peer: { ticker: string; name: string; role: string; release: PeerRelease },
	date: string,
	estimated: boolean,
): PeerEvent {
	return {
		date,
		kind: `peer_earnings:${peer.ticker}`,
		label: `${peer.name}(${peer.ticker}) 決算${estimated ? "(推定日)" : ""}[${releaseInJst(peer.release, date)}]`,
		impact: "high",
		jst_effect_date: nextTseBusinessDay(date),
		note: `${peer.role}の海外ピア。東証の取引時間外に出る → 翌営業日に SOX 経由で日本の半導体関連株へギャップで波及しうる。`,
	};
}

// 同じピアで today 以前の最新の決算日 (通過済み)。無ければ null。
async function lastPassedDate(
	env: PeerEarningsEnv,
	kind: string,
	today: string,
): Promise<string | null> {
	const row = await db(env.DB)
		.select({ date: macroEvents.date })
		.from(macroEvents)
		.where(and(eq(macroEvents.kind, kind), lte(macroEvents.date, today)))
		.orderBy(desc(macroEvents.date))
		.get();
	return row?.date ?? null;
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
	const today = usEasternDate(Date.now());
	const results: Record<string, unknown> = {};
	let ok = 0;
	for (const p of peers) {
		try {
			const { date, via } = await fetchPeerEarningsDate(p.ticker);
			const kind = `peer_earnings:${p.ticker}`;
			const estimated = via === "surprise-estimate";
			if (
				date &&
				estimated &&
				isStaleEstimate(date, await lastPassedDate(env, kind, today))
			) {
				ok++;
				results[p.ticker] = { date: null, via, skipped: date };
			} else if (date) {
				const e = toPeerEvent(p, date, estimated);
				await savePeerEvent(env, e);
				await dropOtherUpcomingPeerEvents(env, kind, date, today);
				ok++;
				results[p.ticker] = { date, via };
			} else {
				results[p.ticker] = { date: null, via };
			}
		} catch (e) {
			results[p.ticker] = { error: (e as Error).message };
		}
		await sleep(interval);
	}
	if (ok === 0) {
		throw new Error(
			"peer-earnings: 取得0件 (Nasdaq 障害/構造変更の可能性)。保存をスキップ。",
		);
	}
	return { ok, results };
}

// --- 国内ピア決算 -------------------------------------------------------------

// 1国内ピアの (コード, 社名, ロール, 決算日, 推定か) から macro_events 行を組み立てる。
// 国内決算は引け後発表が大半 → 東証で読めるのは翌営業日。
// event-context は label をそのまま prompt に載せるので、推定日は label で公表日と見分けられるようにする。
function toJpPeerEvent(
	code: string,
	name: string,
	role: string,
	date: string,
	estimated: boolean,
): PeerEvent {
	return {
		date,
		kind: `peer_earnings_jp:${code}`,
		label: `${name}(${code}) 決算${estimated ? "(推定日)" : ""}`,
		impact: "high",
		jst_effect_date: nextTseBusinessDay(date),
		note: `${role}の国内ピア。監視銘柄より先に決算が出る → 受注・見通しが監視銘柄の業績の先行材料。`,
	};
}

// 推定日から公表日に切り替わると (date, kind) の別行になるので、同じピアの today より後の古い予定行を消す。
// today 以前の行は「本日発表」「通過済み」の文脈に要るので残す。
async function dropOtherUpcomingPeerEvents(
	env: PeerEarningsEnv,
	kind: string,
	keepDate: string,
	today: string,
): Promise<void> {
	await db(env.DB)
		.delete(macroEvents)
		.where(
			and(
				eq(macroEvents.kind, kind),
				gt(macroEvents.date, today),
				ne(macroEvents.date, keepDate),
			),
		)
		.run();
}

// JP_PEERS (codeFilter 指定時はその1社) の次回決算日を JPX 決算発表予定日一覧の公表日で、載っていなければ
// kabutan finance ページからの推定 (watchlist の earnings.ts と同一) で決め、macro_events に保存する。
// 全社0件のときだけ例外を投げ既存データを守る。
export async function collectJpPeerEarnings(
	env: PeerEarningsEnv,
	codeFilter: string | null,
): Promise<Record<string, unknown>> {
	const peers = JP_PEERS.filter((p) => !codeFilter || p.code === codeFilter);
	const interval = Number.parseInt(env.MIN_INTERVAL_MS, 10) || 5000;
	const schedule = await loadEarningsSchedule(
		env,
		peers.map((p) => p.code),
	);
	const today = jstDate(Date.now());
	const results: Record<string, unknown> = {};
	let saved = 0;
	for (const p of peers) {
		try {
			const html = await fetchHtml(URL_FINANCE(p.code), env);
			const { est, detail } = await estimateNextEarningsDate(html);
			const next = resolveNextDate(schedule.dates.get(p.code), est, detail);
			if (next.date) {
				const e = toJpPeerEvent(
					p.code,
					p.name,
					p.role,
					next.date,
					next.estimated,
				);
				await savePeerEvent(env, e);
				await dropOtherUpcomingPeerEvents(env, e.kind, e.date, today);
				saved++;
			}
			results[p.code] = {
				date: next.date,
				estimated: next.estimated,
				detail: next.detail,
			};
		} catch (e) {
			results[p.code] = { error: (e as Error).message };
		}
		await sleep(interval);
	}
	if (saved === 0) {
		throw new Error(
			"peer-earnings-jp: 取得0件 (kabutan 障害/構造変更の可能性)。保存をスキップ。",
		);
	}
	return { saved, jpx_schedule: schedule.summary, results };
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
		const nvda = SOX_PEERS.find((p) => p.ticker === "NVDA");
		const tsm = SOX_PEERS.find((p) => p.ticker === "TSM");
		if (!nvda || !tsm) throw new Error("SOX_PEERS に NVDA/TSM が要る");
		const e = toPeerEvent(nvda, "2026-11-17", false);
		it("kind にティッカーを畳み込む (同日複数社の衝突回避)", () => {
			expect(e.kind).toBe("peer_earnings:NVDA");
		});
		it("米引け後の label は日本時間の翌早朝を添える", () => {
			expect(e.label).toBe(
				"エヌビディア(NVDA) 決算[米11/17引け後=日本11/18早朝]",
			);
		});
		it("日本の午後に出るピアは同日午後を添える", () => {
			expect(toPeerEvent(tsm, "2026-10-15", false).label).toBe(
				"TSMC(TSM) 決算[日本10/15午後]",
			);
		});
		it("推定日の label には (推定日) を付ける", () => {
			expect(toPeerEvent(nvda, "2027-02-25", true).label).toBe(
				"エヌビディア(NVDA) 決算(推定日)[米2/25引け後=日本2/26早朝]",
			);
		});
		it("jst_effect_date は東証の翌営業日・impact=high", () => {
			expect(e.jst_effect_date).toBe("2026-11-18");
			expect(e.impact).toBe("high");
		});
		it("金曜の発表は週明け、祝日前は祝日明けに波及する", () => {
			expect(toPeerEvent(nvda, "2026-11-13", false).jst_effect_date).toBe(
				"2026-11-16",
			);
			expect(toPeerEvent(nvda, "2026-11-20", false).jst_effect_date).toBe(
				"2026-11-24",
			);
		});
	});

	describe("isStaleEstimate", () => {
		it("直近の決算から四半期に満たない推定は通過済み四半期の再推定とみなす", () => {
			// NVDA: 11/17 に発表 → 翌日に副が前年同期 (2025-11-19) +1年 = 11/19 を出す。
			expect(isStaleEstimate("2026-11-19", "2026-11-17")).toBe(true);
		});
		it("次の四半期の推定は通す", () => {
			expect(isStaleEstimate("2027-02-25", "2026-11-17")).toBe(false);
			expect(isStaleEstimate("2026-11-19", null)).toBe(false);
		});
	});

	describe("usEasternDate", () => {
		it("米東部の暦日を返す (JST 夕方は米東部の同日未明)", () => {
			expect(usEasternDate(Date.parse("2026-11-18T07:00:00Z"))).toBe(
				"2026-11-18",
			);
			expect(usEasternDate(Date.parse("2026-11-18T04:00:00Z"))).toBe(
				"2026-11-17",
			);
		});
	});

	describe("macroRowsFor", () => {
		const rows = [
			{ kind: "fomc" },
			{ kind: "peer_earnings:MU" },
			{ kind: "peer_earnings_jp:6146" },
			{ kind: "peer_earnings_jp:6857" },
			{ kind: "peer_earnings_jp:6981" },
			{ kind: "peer_earnings_jp:8035" },
		];
		const kinds = (t: string | null) =>
			macroRowsFor(rows, t).map((r) => r.kind);
		it("監視銘柄に先行する国内ピアだけを残し、他の kind は残す", () => {
			expect(kinds("6920")).toEqual([
				"fomc",
				"peer_earnings:MU",
				"peer_earnings_jp:6146",
				"peer_earnings_jp:6857",
			]);
			expect(kinds("6976")).toEqual([
				"fomc",
				"peer_earnings:MU",
				"peer_earnings_jp:6981",
			]);
		});
		it("自分自身の決算と、JP_PEERS に無いピアの行は落とす", () => {
			expect(kinds("6857")).toEqual([
				"fomc",
				"peer_earnings:MU",
				"peer_earnings_jp:6146",
			]);
		});
		it("ticker が null なら国内ピアをすべて落とす", () => {
			expect(kinds(null)).toEqual(["fomc", "peer_earnings:MU"]);
		});
	});

	describe("toJpPeerEvent", () => {
		const e = toJpPeerEvent(
			"8035",
			"東京エレクトロン",
			"前工程装置",
			"2026-08-06",
			false,
		);
		it("kind は peer_earnings_jp:<code> (海外ピアと区別する)", () => {
			expect(e.kind).toBe("peer_earnings_jp:8035");
		});
		it("公表日の label は 社名(コード) 決算", () => {
			expect(e.label).toBe("東京エレクトロン(8035) 決算");
		});
		it("推定日の label には (推定日) を付ける", () => {
			expect(
				toJpPeerEvent(
					"8035",
					"東京エレクトロン",
					"前工程装置",
					"2026-08-06",
					true,
				).label,
			).toBe("東京エレクトロン(8035) 決算(推定日)");
		});
		it("波及日は東証の翌営業日・impact=high", () => {
			expect(e.jst_effect_date).toBe("2026-08-07");
			expect(
				toJpPeerEvent(
					"8035",
					"東京エレクトロン",
					"前工程装置",
					"2026-08-07",
					false,
				).jst_effect_date,
			).toBe("2026-08-10");
			expect(e.impact).toBe("high");
		});
	});
}
