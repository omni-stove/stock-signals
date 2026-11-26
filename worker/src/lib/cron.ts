// Cloudflare Worker: Cron Trigger の配線。
// 発火した cron 式を event.cron で判別して取得種別に振り分ける。

import type { Env } from "./env";
import { jpSqWeek } from "./event-context";
import { remindUpcomingEvents } from "./event-reminder";
import { type FanOutJob, fanOut, jobKey } from "./fan-out";
import { collectForcedLiquidation } from "./forced-liquidation";
import { readFreshness, staleSources } from "./freshness";
import { dispatchEventPayload, dispatchSignalUpdate } from "./github-dispatch";
import { IR_SOURCES } from "./ir-sources";
import { collectLiveIndexes } from "./live-indexes";
import { collectMarketNews, type FreshMarketNews } from "./market-news";
import { collectNews, type FreshNews } from "./news";
import { listPositionUsers } from "./position-report";
import { collectBackdrop } from "./premarket";
import {
	notifyJobFailure,
	notifyNewsSlack,
	notifyOps,
	notifyParseFailure,
} from "./slack";
import { collectTimeseries, DAILY_CODES, WATCHLIST } from "./timeseries";
import { jstDate } from "./utils";

// IR・適時開示・ニュース・市場テーマニュース・レーティングの収集結果を、dispatch 対象・新着通知・
// 健全性警告に使う形へまとめたもの。emptyParses は `ir:285A` のように収集種別の接頭辞付き。
interface ArticleIntake {
	fresh: string[];
	freshNews: FreshNews[];
	freshMarketNews: FreshMarketNews[];
	emptyParses: string[];
	pdfFallbacks: number;
}

const EMPTY_PARSE_TAG: Record<string, string> = {
	ir: "ir",
	disclosure: "tdnet",
	news: "news",
};

// 収集種別ごとの出力 (collectAll / collectDisclosures / collectNews / collectMarketNews /
// collectRatings の戻り値、または失敗ジョブの { error }) を ArticleIntake に合算する。
function mergeArticleResults(
	entries: { kind: string; out: unknown }[],
): ArticleIntake {
	const fresh = new Set<string>();
	const merged: ArticleIntake = {
		fresh: [],
		freshNews: [],
		freshMarketNews: [],
		emptyParses: [],
		pdfFallbacks: 0,
	};
	for (const { kind, out } of entries) {
		const o = (out ?? {}) as {
			freshTickers?: string[];
			freshNews?: (FreshNews | FreshMarketNews)[];
			emptyParses?: string[];
			emptyParse?: boolean;
			pdfFallbacks?: number;
		};
		for (const t of o.freshTickers ?? []) fresh.add(t);
		if (kind === "market-news") {
			merged.freshMarketNews.push(
				...((o.freshNews ?? []) as FreshMarketNews[]),
			);
			if (o.emptyParse) merged.emptyParses.push("market-news");
		} else {
			merged.freshNews.push(...((o.freshNews ?? []) as FreshNews[]));
			const tag = EMPTY_PARSE_TAG[kind] ?? kind;
			merged.emptyParses.push(
				...(o.emptyParses ?? []).map((c) => `${tag}:${c}`),
			);
		}
		merged.pdfFallbacks += o.pdfFallbacks ?? 0;
	}
	merged.fresh = [...fresh];
	return merged;
}

// 記事系の収集を 1 ジョブ = 1 invocation で回し、失敗ジョブを運用チャンネルに知らせる。
// entries は mergeArticleResults に渡す形、results はログ用のジョブ別結果。
async function fanOutArticles(
	env: Env,
	label: string,
	jobs: FanOutJob[],
): Promise<{
	entries: { kind: string; out: unknown }[];
	results: Record<string, unknown>;
}> {
	const { results, failed } = await fanOut(env, jobs);
	if (failed.length > 0) console.error(`${label} jobs failed:`, failed);
	await notifyJobFailure(env, label, failed);
	const entries = jobs.map((job) => ({
		kind: job.kind,
		out: results[jobKey(job)],
	}));
	return { entries, results };
}

// IR と適時開示の銘柄別ジョブ。
function irDisclosureJobs(): FanOutJob[] {
	return [
		...IR_SOURCES.map((s) => ({ kind: "ir", code: s.code })),
		...WATCHLIST.map((code) => ({ kind: "disclosure", code })),
	];
}

// パース0件と、IR・適時開示の PDF 抽出失敗件数を運用チャンネルに 1 行で警告する (notifyParseFailure)。
async function notifyCollectHealth(
	env: Env,
	intake: ArticleIntake,
): Promise<void> {
	await notifyParseFailure(env, intake.emptyParses, intake.pdfFallbacks);
}

// 銘柄ニュース + 市場テーマニュースの新着を Slack (SLACK_NEWS_WEBHOOK_URL) に通知する。
// IR(notifySlack) と別チャンネルに分離する。webhook 未設定/新着 0 なら no-op。best-effort。
async function notifyFreshNews(env: Env, intake: ArticleIntake): Promise<void> {
	await notifyNewsSlack(
		env,
		"🗞️ 新規ニュース",
		intake.freshNews.map((n) => ({
			tag: n.ticker,
			title: n.title,
			url: n.url,
			date: n.date,
		})),
	);
	await notifyNewsSlack(
		env,
		"🌐 市場テーマニュース",
		intake.freshMarketNews.map((n) => ({
			tag: n.topic,
			title: n.title,
			url: n.url,
			date: n.date,
		})),
	);
}

// 発火した cron 式 → 取得種別。wrangler.toml の [triggers] crons と対応させること。
// Cloudflare の cron trigger 上限は5個で、5個とも使っている。新しい収集は既存 cron に相乗りさせる:
//   - intake (8:30/18:00):  IR + ニュースを収集し、全銘柄を signal-update (定時ブリーフ付き) で起動。
//                           寄り前(8:30)のみ地合い(米国指数+日経先物)も先に取得する。
//                           引け後(18:00)は先に flows (空売り需給 (逆日歩/機関の空売り残高/東証全体の
//                           空売り比率) + 投資部門別 + 大量保有報告書 (EDINET) + 信用残 + 証金残) を収集する。
//                           18:00 以降の開示は翌朝 8:30 の intake で拾う。
//   - prices (場中5分毎):   prices + ニュース速報を収集し、新規ニュースのあった銘柄を signal-update で起動。
//                           さらに JST 12:30 相当スロットでは IR intake も相乗りさせる (昼の専用 cron を
//                           立てないため。下の isNoonIntakeSlot 参照)。
//                           JST 15:00 相当の最終スロット (isPreCloseSlot) では大引け前にその時点の材料
//                           だけで翌日寄り越えの玉を判断するため、intake 同様に全銘柄を無条件判定する。
//   - eod    (16:00 引け後): daily (+TOPIX/日経225) + fundamentals + 決算予定日 + ピア決算日 + 指数入替
// eod / flows / intake の記事収集 (と昼スロットの IR + 適時開示) は、ジョブを 1 つずつ別 invocation で
// 回す (fan-out.ts)。
const MORNING_INTAKE_CRON = "30 23 * * *";
const EVENING_INTAKE_CRON = "0 9 * * *";
const CRON_KIND: Record<string, "intake" | "prices" | "eod"> = {
	[MORNING_INTAKE_CRON]: "intake",
	[EVENING_INTAKE_CRON]: "intake",
	"*/5 0-6 * * *": "prices",
	"0 7 * * *": "eod",
};

// JST 12:30 (= UTC 03:30) のスロットか。場中 prices ループ (*/5 0-6) はどのスロットでも
// event.cron が同じ文字列なので、発火予定時刻 (scheduledTime) の UTC 時:分で昼スロットを判定する。
// 5分毎発火なので 03:30 ちょうどに鳴るが、遅延を見込んで 03:30〜03:34 の幅で拾う (1日1回に収まる)。
function isNoonIntakeSlot(scheduledTime: number): boolean {
	const d = new Date(scheduledTime);
	return (
		d.getUTCHours() === 3 && d.getUTCMinutes() >= 30 && d.getUTCMinutes() < 35
	);
}

// JST 15:00 (= UTC 06:00) の引け前スロットか。prices ループ (*/5 0-6) の最終スロットで、
// 大引け (15:30) 前にその時点で判明している材料だけで「翌日の寄り越えに玉を持つか」を判定するため、
// intake と同じく全銘柄を無条件 signal-update する。06:00 ちょうどに鳴るが遅延を見込んで
// 06:00〜06:04 の幅で拾う (5分毎発火なので 1日1回に収まる)。
function isPreCloseSlot(scheduledTime: number): boolean {
	const d = new Date(scheduledTime);
	return d.getUTCHours() === 6 && d.getUTCMinutes() < 5;
}

// JST 曜日 (0=日, 6=土) で土日かを判定する。対象は東証の日本株なので、東証が開かない
// JST 土日は cron を動かしても新規はほぼ無く無駄なため全スキップする。
// Cloudflare Cron は曜日範囲指定 (0-4 等) を弾くので、cron 式ではなく scheduled() 内でガードする。
//
// ※注意: 寄り前 intake `30 23 * * *` は UTC 23:30 発火 → JST 08:30 (翌日)。よって
//   UTC 土曜 23:30 = JST 日曜 08:30 (→スキップ)、UTC 日曜 23:30 = JST 月曜 08:30 (→稼働)。
//   「日本の日曜夜=米国の月曜朝の寄り」に当たる JST 月曜朝の地合い取得は JST 曜日判定で
//   自動的に月曜扱いになり残る。発火予定時刻 (scheduledTime) を JST に直して曜日を見ること。
function isJstWeekend(scheduledTime: number): boolean {
	const jst = new Date(scheduledTime + 9 * 60 * 60 * 1000);
	const day = jst.getUTCDay(); // JST に +9h した値の UTC 曜日 = JST 曜日
	return day === 0 || day === 6;
}

// 発火予定時刻 (JST) が月の最初の稼働日 (1〜3日のいずれか初回) かを判定する。マクロイベント
// (FOMC/日銀/米CPI/米雇用統計) を eod cron に月1回だけ相乗りさせるための「月初スロット」。JST 1日が土日だと
// その日の eod は isJstWeekend で全スキップされるため、1〜3日を窓にして月内で確実に1回拾う。
// 同月内で複数回走っても macro_events は (date,kind) PK の INSERT OR REPLACE で冪等。
function isJstMonthStart(scheduledTime: number): boolean {
	const jst = new Date(scheduledTime + 9 * 60 * 60 * 1000);
	const d = jst.getUTCDate();
	return d >= 1 && d <= 3;
}

// 空売りまわり (逆日歩 / 機関の空売り残高 / 東証全体の空売り比率)・投資部門別売買 (週次)・
// 大量保有報告書 (EDINET)・メモリのスポット価格 (DRAMeXchange)・TSMC の月次売上 (MOPS)・
// SEAJ の装置販売高速報・信用残 (週次)・証金残 (日証金の貸借取引残高、日次)。
// 公表が夕方以降のもの、または 1 日 1 回取れば足りるものなので引け後 intake (18:00) の先頭で回す。
async function collectFlows(env: Env): Promise<void> {
	const { results, failed } = await fanOut(env, [
		{ kind: "short-interest", part: "lending" },
		...WATCHLIST.map((code) => ({
			kind: "short-interest",
			part: "positions",
			code,
		})),
		{ kind: "short-interest", part: "market" },
		{ kind: "investor-flows" },
		{ kind: "large-holdings" },
		{ kind: "memory-prices" },
		{ kind: "tw-monthly-revenue" },
		{ kind: "seaj-sales" },
		{ kind: "margin" },
		{ kind: "jsf-balance" },
	]);
	if (failed.length > 0) console.error("flows jobs failed:", failed);
	await notifyJobFailure(env, "flows", failed);
	console.log("scheduled flows done:", JSON.stringify({ results, failed }));
}

// D1 の表ごとの最新日を見て、遅れている収集を運用チャンネルに知らせる (freshness.ts)。
async function notifyStaleSources(env: Env, today: string): Promise<void> {
	try {
		const stale = staleSources(await readFreshness(env, today), today);
		if (stale.length > 0)
			await notifyOps(env, `⚠️ データ更新の途絶: ${stale.join(", ")}`);
	} catch (e) {
		console.error("freshness check failed:", e);
	}
}

// Cron Trigger 発火時。event.cron でどの cron が鳴ったか判別して種別を振り分ける。
export async function runScheduled(
	event: ScheduledController,
	env: Env,
): Promise<void> {
	const kind = CRON_KIND[event.cron] ?? "intake"; // 未知の cron は intake にフォールバック
	// JST 土日は東証が開かないため、どの種別もスキップする (新規がほぼ無く無駄なため)。
	// 寄り前 intake は UTC 日曜 23:30 = JST 月曜 08:30 に発火し、JST 曜日では月曜扱いに
	// なるのでこのガードを通過する (= 米国月曜朝の寄りを反映する地合い取得は残る)。
	if (isJstWeekend(event.scheduledTime)) {
		console.log(
			`scheduled skipped (JST weekend): cron=${event.cron} kind=${kind}`,
		);
		return;
	}
	if (kind === "intake") {
		// intake cron (8:30/18:00) では IR とニュースを両方収集する。
		// 寄り前(8:30)のときだけ先に当日の premarket を D1 に取る (失敗しても収集は続行)。
		// premarket が揃った直後に market-brief (朝のマーケットブリーフ) も kick する。市場全体の
		// 事実サマリーなので、下で発火する個別 ticker-brief より「先」に Slack へ出す必要がある。
		// schedule cron で別に撃つと ticker-brief より後ろにずれるため、ここで premarket 取得後
		// すぐに発火する。
		const evening = event.cron === EVENING_INTAKE_CRON;
		if (event.cron === MORNING_INTAKE_CRON) {
			await collectBackdrop(env).catch((e) =>
				console.error("backdrop failed:", e),
			);
			// 銘柄非依存なので client_payload は空。App 認証が無ければ no-op (false)。
			await dispatchEventPayload(
				env,
				"market-brief",
				{},
				event.scheduledTime,
			).catch((e) => console.error("market-brief dispatch failed:", e));
			// 日本SQ週 (SQ日を含む月〜金) は毎朝 sq-brief (SQ週の値動きシナリオ) も kick する。
			if (jpSqWeek(jstDate(event.scheduledTime))) {
				await dispatchEventPayload(
					env,
					"sq-brief",
					{},
					event.scheduledTime,
				).catch((e) => console.error("sq-brief dispatch failed:", e));
			}
			// 重要イベント (watchlist 決算/FOMC/日銀/ピア決算/SQ/リバランス) の事前リマインダー。
			// 3日前・前日・当日の朝にだけ Slack に1本流す (該当なしの朝は無音)。失敗しても収集は続行。
			await remindUpcomingEvents(env, event.scheduledTime).catch((e) =>
				console.error("event-reminder failed:", e),
			);
		}
		// 引け後 (18:00) は flows を先に D1 へ入れ、この回のブリーフに夕方の需給データを載せる。
		// fanOut なので flows の CPU はこの invocation に積まれない。
		if (evening) {
			await collectFlows(env).catch((e) => console.error("flows failed:", e));
		}
		// intake (寄り前 8:30 / 引け後 18:00) は新規の有無によらず全銘柄を brief 付きで signal-update し、
		// 全銘柄の ticker-brief まで出す (定時ブリーフ。新着が無い銘柄は簡易版)。場中 (prices, 5分毎) は
		// LLM コストを抑えるため新規ベース (下の分岐) で、ticker-brief は新着材料があった銘柄だけ。
		// IR(公式サイト) + 適時開示(TDnet) + ニュースを銘柄ごと、市場テーマニュースと証券会社レーティングを
		// 1 本ずつ、別 invocation で収集する。市場テーマニュースは新規見出しに watchlist 銘柄の言及
		// (matchTickers) があればその銘柄を fresh に合流させる (例: 「サムスン、HBM増産」→ 6857)。
		// レーティングの日報は当日夕方〜夜に出揃うため、主に引け後 (18:00) の回で拾う。
		const { entries, results } = await fanOutArticles(env, "intake", [
			...irDisclosureJobs(),
			...WATCHLIST.map((code) => ({ kind: "news", code })),
			{ kind: "market-news" },
			{ kind: "ratings" },
		]);
		const intake = mergeArticleResults(entries);
		console.log(
			"scheduled intake articles done:",
			JSON.stringify(results),
			"fresh:",
			intake.fresh.join(","),
		);
		// 収集の後に撃ち、入ったばかりの IR/ニュースを同じ回の context-builder に読ませる。
		// 収集の前には撃たない: Free プランのサブリクエスト上限 (50/invocation) に dispatch 1 回で
		// 銘柄数 + 1 件を食うため。寄り前 (8:30) の market-brief は上で撃ち終えており、市場全体→個別の
		// 順序は保たれる。
		await dispatchSignalUpdate(env, WATCHLIST, { brief: true });
		// 新規ニュース (銘柄 + 市場テーマ) を専用チャンネルに通知する。webhook 未設定なら no-op。
		await notifyFreshNews(env, intake);
		// 「HTTP 200 なのに一覧パース0件」= ソースサイトの DOM 変更で収集が静かに止まっている疑い。
		// 場中 (prices, 5分毎) では鳴らさず intake と昼スロットでだけ警告し、連投を避ける。
		await notifyCollectHealth(env, intake);
		// 引け後 (18:00) は eod / flows の収集が済んでいるので、表ごとの途絶を確かめる (1日1回)。
		if (evening) {
			await notifyStaleSources(env, jstDate(event.scheduledTime));
		}
		return;
	}
	if (kind === "prices") {
		// 場中 5分毎。価格スナップショットに加え、銘柄ニュース速報も拾う (新着で即判定するため)。
		const p = await collectTimeseries(env, "prices", null);
		// 場中リアルタイム指数 (日経225/KOSPI) も相乗り収集する。地合いの「アジア同時進行」の材料。
		// 失敗しても prices の主収集は壊さない (best-effort)。
		const idx = await collectLiveIndexes(env).catch((e) => {
			console.error("live-indexes failed:", e);
			return null;
		});
		const news = await collectNews(env, null);
		// 市場テーマニュースも場中速報として収集する (オープンAI上場延期のような材料は場中に出る)。
		// 新規見出しに watchlist 銘柄の言及 (matchTickers) があれば freshTickers に合流させて
		// 個別判定も起動する。失敗しても prices の主収集は壊さない。
		const mnews = await collectMarketNews(env).catch((e) => {
			console.error("market-news failed:", e);
			return null;
		});
		// JST 12:30 相当スロットでは IR + 適時開示 intake も相乗りさせる (昼の専用 cron を持たないため)。
		// IR・適時開示・ニュースどの新着でも signal-update を撃つので fresh を統合して dispatch する。
		const noon = isNoonIntakeSlot(event.scheduledTime)
			? await fanOutArticles(env, "noon-intake", irDisclosureJobs())
			: null;
		const intake = mergeArticleResults([
			{ kind: "news", out: news },
			{ kind: "market-news", out: mnews },
			...(noon?.entries ?? []),
		]);
		const fresh = intake.fresh;
		console.log(
			"scheduled prices+news done:",
			JSON.stringify({
				prices: p,
				...(idx ? { liveIndexes: idx } : {}),
				news: news.results,
				...(mnews ? { marketNews: mnews } : {}),
				...(noon ? { noonIntake: noon.results } : {}),
			}),
			"fresh:",
			fresh.join(","),
		);
		// 新規ニュース (銘柄 + 市場テーマ) を専用チャンネルに通知する。webhook 未設定なら no-op。
		await notifyFreshNews(env, intake);
		// パース0件・PDF 抽出失敗の警告は 1日1回の昼スロットでだけ流す (5分毎に鳴らさない)。
		if (noon) await notifyCollectHealth(env, intake);
		// JST 15:00 の引け前スロットは、新規の有無によらず全銘柄を判定する (intake と同思想)。
		// 大引け前にその時点で判明している材料だけで「翌日の寄り越えに玉を持つか」を判断するため、
		// ニュースの薄い銘柄も取り残さない。デバウンスも掛けない (1日1回の確定枠)。
		if (isPreCloseSlot(event.scheduledTime)) {
			await dispatchSignalUpdate(env, WATCHLIST);
			return;
		}
		// 場中の通常スロットは同一銘柄の短時間連発を抑える (デバウンス)。intake (上の分岐) は抑えない。
		await dispatchSignalUpdate(env, fresh, { debounce: true });
		return;
	}
	if (kind === "eod") {
		// 引け後の1日1回。日足 (watchlist + TOPIX + 日経225、足りない過去分の補完込み)・fundamentals・
		// 次回決算予定日・ピア決算日 (毎日上書き)・日経225/JPX日経400 の監視銘柄の入替 (前営業日以降の公表分)・
		// FOMC/日銀/米CPI/米雇用統計 (月初だけ) を、1 ジョブ = 1 invocation で回す。
		const { results: eodJobs, failed: eodFailed } = await fanOut(env, [
			...DAILY_CODES.map((code) => ({ kind: "daily", code })),
			...WATCHLIST.map((code) => ({ kind: "fundamentals", code })),
			{ kind: "earnings" },
			{ kind: "peer-earnings" },
			{ kind: "peer-earnings-jp" },
			{ kind: "index-changes" },
			...(isJstMonthStart(event.scheduledTime)
				? [{ kind: "macro-events" }]
				: []),
		]);
		if (eodFailed.length > 0) console.error("eod jobs failed:", eodFailed);
		await notifyJobFailure(env, "eod", eodFailed);
		// 強制決済スコア (追証売り/踏み上げ) を当日 daily が確定した直後に算出して D1 に保存する。
		// daily を上で収集済みなので最新足が揃っている。margin は intake で取得済みの最新行を読む。
		// 失敗しても eod の主収集は壊さない (catch でログのみ)。
		const fl = await collectForcedLiquidation(env, null).catch((err) => {
			console.error("forced-liquidation failed:", err);
			return null;
		});
		// ポジション事実レポートは当夜に GitHub Actions (position-report) へ委譲する。建玉を持つ
		// ユーザーがいれば repository_dispatch (position-report) を 1 回撃つだけ。ワークフローが
		// /position-users で userId を引き、ユーザーごとに /position-context を読んで LLM が建玉に
		// 関係する材料を紐付け各ユーザーへ DM する。briefs は intake/場中で溜まっており、引け後に
		// 出揃った最新足 close を参照現値にする。建玉ゼロや App 認証情報未設定なら撃たない。
		// 失敗しても eod の主収集は壊さない (catch でログのみ)。
		const pr = await (async () => {
			const users = await listPositionUsers(env);
			if (users.length === 0) return { dispatched: false, users: 0 };
			const ok = await dispatchEventPayload(
				env,
				"position-report",
				{},
				event.scheduledTime,
			);
			return { dispatched: ok, users: users.length };
		})().catch((err) => {
			console.error("position-report dispatch failed:", err);
			return null;
		});
		console.log(
			"scheduled eod done:",
			JSON.stringify({
				jobs: eodJobs,
				failed: eodFailed,
				...(fl ? { forcedLiquidation: fl.results } : {}),
				...(pr ? { positionReview: pr } : {}),
			}),
		);
		return;
	}
	const res = await collectTimeseries(env, kind, null);
	console.log(`scheduled ${kind} done:`, JSON.stringify(res));
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;
	const ms = (iso: string) => new Date(iso).getTime();

	describe("mergeArticleResults", () => {
		it("fresh を重複なく束ね、パース0件に種別の接頭辞を付け、PDF 失敗件数を足す", () => {
			const m = mergeArticleResults([
				{
					kind: "ir",
					out: { freshTickers: ["285A"], emptyParses: [], pdfFallbacks: 1 },
				},
				{
					kind: "disclosure",
					out: {
						freshTickers: ["285A"],
						emptyParses: ["6857"],
						pdfFallbacks: 2,
					},
				},
				{
					kind: "news",
					out: {
						freshTickers: ["6920"],
						freshNews: [{ ticker: "6920", title: "t", url: "u", date: "d" }],
						emptyParses: ["6976"],
					},
				},
				{
					kind: "market-news",
					out: {
						freshTickers: ["6857"],
						freshNews: [{ topic: "AI", title: "m", url: "v", date: "d" }],
						emptyParse: true,
					},
				},
				{ kind: "ratings", out: { freshTickers: ["6976"] } },
			]);
			expect(m.fresh).toEqual(["285A", "6920", "6857", "6976"]);
			expect(m.emptyParses).toEqual(["tdnet:6857", "news:6976", "market-news"]);
			expect(m.pdfFallbacks).toBe(3);
			expect(m.freshNews.map((n) => n.ticker)).toEqual(["6920"]);
			expect(m.freshMarketNews.map((n) => n.topic)).toEqual(["AI"]);
		});
		it("失敗ジョブ ({ error }) と欠けた出力は何も足さない", () => {
			const m = mergeArticleResults([
				{ kind: "ir", out: { error: "HTTP 500" } },
				{ kind: "market-news", out: null },
				{ kind: "news", out: undefined },
			]);
			expect(m).toEqual({
				fresh: [],
				freshNews: [],
				freshMarketNews: [],
				emptyParses: [],
				pdfFallbacks: 0,
			});
		});
	});

	describe("isNoonIntakeSlot", () => {
		// JST 12:30 = UTC 03:30。03:30〜03:34 の5分窓で拾う。
		it("UTC 03:30〜03:34 は昼スロット", () => {
			expect(isNoonIntakeSlot(ms("2026-06-22T03:30:00Z"))).toBe(true);
			expect(isNoonIntakeSlot(ms("2026-06-22T03:34:59Z"))).toBe(true);
		});
		it("窓の外 (03:29 / 03:35 / 別の時) は昼スロットでない", () => {
			expect(isNoonIntakeSlot(ms("2026-06-22T03:29:59Z"))).toBe(false);
			expect(isNoonIntakeSlot(ms("2026-06-22T03:35:00Z"))).toBe(false);
			expect(isNoonIntakeSlot(ms("2026-06-22T00:30:00Z"))).toBe(false);
		});
	});

	describe("isPreCloseSlot", () => {
		// JST 15:00 = UTC 06:00。06:00〜06:04 の5分窓で拾う。
		it("UTC 06:00〜06:04 は引け前スロット", () => {
			expect(isPreCloseSlot(ms("2026-06-22T06:00:00Z"))).toBe(true);
			expect(isPreCloseSlot(ms("2026-06-22T06:04:59Z"))).toBe(true);
		});
		it("窓の外 (05:59 / 06:05 / 別の時) は引け前スロットでない", () => {
			expect(isPreCloseSlot(ms("2026-06-22T05:59:59Z"))).toBe(false);
			expect(isPreCloseSlot(ms("2026-06-22T06:05:00Z"))).toBe(false);
			expect(isPreCloseSlot(ms("2026-06-22T03:30:00Z"))).toBe(false);
		});
	});

	describe("isJstWeekend", () => {
		// scheduledTime を JST に直した曜日で判定する。
		it("JST 土日は true", () => {
			// 2026-06-20 は土曜。JST 10:00 = UTC 前日 01:00。
			expect(isJstWeekend(ms("2026-06-20T01:00:00Z"))).toBe(true); // 土 JST 10:00
			expect(isJstWeekend(ms("2026-06-21T01:00:00Z"))).toBe(true); // 日 JST 10:00
		});
		it("JST 平日は false", () => {
			expect(isJstWeekend(ms("2026-06-22T01:00:00Z"))).toBe(false); // 月 JST 10:00
			expect(isJstWeekend(ms("2026-06-19T01:00:00Z"))).toBe(false); // 金 JST 10:00
		});
		it("UTC 日曜 23:30 = JST 月曜 08:30 は稼働 (TZ ズレの境界)", () => {
			// 寄り前 intake `30 23 * * *`。UTC 日曜夜 → JST 月曜朝なので平日扱い。
			expect(isJstWeekend(ms("2026-06-21T23:30:00Z"))).toBe(false);
		});
		it("UTC 土曜 23:30 = JST 日曜 08:30 はスキップ", () => {
			expect(isJstWeekend(ms("2026-06-20T23:30:00Z"))).toBe(true);
		});
	});

	describe("isJstMonthStart", () => {
		it("JST 1〜3日は月初スロット", () => {
			expect(isJstMonthStart(ms("2026-07-01T07:00:00Z"))).toBe(true); // JST 16:00 1日
			expect(isJstMonthStart(ms("2026-07-03T07:00:00Z"))).toBe(true);
		});
		it("JST 4日以降は false", () => {
			expect(isJstMonthStart(ms("2026-07-04T07:00:00Z"))).toBe(false);
			expect(isJstMonthStart(ms("2026-07-15T07:00:00Z"))).toBe(false);
		});
		it("UTC 月末 16:00 = JST 翌月 1日 01:00 は月初扱い (TZ ズレ)", () => {
			// UTC 6/30 16:00 → JST 7/1 01:00。eod は UTC 07:00 発火なので実際はこの時刻だが、
			// JST 日付で月初を判定することの確認。
			expect(isJstMonthStart(ms("2026-06-30T16:00:00Z"))).toBe(true);
		});
	});
}
