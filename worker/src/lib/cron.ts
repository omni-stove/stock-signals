// Cloudflare Worker: Cron Trigger の配線。index.ts の scheduled() から切り出し。
// 発火した cron 式を event.cron で判別して取得種別に振り分ける。

import { collectDisclosures } from "./disclosure";
import { collectEarnings } from "./earnings";
import type { Env } from "./env";
import { dispatchEventPayload, dispatchSignalUpdate } from "./github-dispatch";
import { collectAll } from "./ir-collect";
import { DEFAULT_LIMIT } from "./ir-sources";
import { collectMacroEvents } from "./macro-events";
import { collectMargin } from "./margin";
import { collectNews } from "./news";
import { collectPeerEarnings } from "./peer-earnings";
import { collectBackdrop } from "./premarket";
import { collectRatings } from "./ratings";
import { collectTimeseries, WATCHLIST } from "./timeseries";

// 発火した cron 式 → 取得種別。wrangler.toml の [triggers] crons と対応させること。
// Cloudflare の cron trigger 上限は5個。新規 cron は足せないので、複数ソースの収集は
// 既存 cron に相乗りさせ、scheduled() 内で順に実行する:
//   - intake (8:30/20:00):  IR + ニュースを収集し、新規があれば signal-report 起動。
//                           寄り前(8:30)のみ地合い(米国指数+日経先物)も先に取得する。
//                           引け後は 20:00 (決算・適時開示が19時台以降に出ても当夜のうちに拾うため)。
//   - prices (場中5分毎):   prices + ニュース速報を収集し、新規ニュースで signal-report 起動。
//                           さらに JST 12:30 相当スロットでは IR intake も相乗りさせる (昼の専用 cron を
//                           立てず4個に収めるため。下の isNoonIntakeSlot 参照)。
//   - eod    (16:00 引け後): daily + fundamentals + 決算予定日推定 をまとめて実行
const CRON_KIND: Record<string, "intake" | "prices" | "eod"> = {
	"30 23 * * *": "intake",
	"0 11 * * *": "intake",
	"*/5 0-6 * * *": "prices",
	"0 7 * * *": "eod", // JST 16:00 引け後: daily + fundamentals + earnings
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
// (FOMC/日銀) を eod cron に月1回だけ相乗りさせるための「月初スロット」。JST 1日が土日だと
// その日の eod は isJstWeekend で全スキップされるため、1〜3日を窓にして月内で確実に1回拾う。
// 同月内で複数回走っても macro_events は (date,kind) PK の INSERT OR REPLACE で冪等。
function isJstMonthStart(scheduledTime: number): boolean {
	const jst = new Date(scheduledTime + 9 * 60 * 60 * 1000);
	const d = jst.getUTCDate();
	return d >= 1 && d <= 3;
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
		// intake cron (8:30/12:30/18:30) では IR とニュースを両方収集する。
		// 寄り前(8:30)のときだけ先に当日の地合いを D1 に取る。直後に発火する signal-judge が
		// pre-open weighting で当日 premarket 行を読めるようにするため (失敗しても収集は続行)。
		// premarket が揃った直後に market-check (地合いゲート) も kick する。地合いは前段ゲート
		// なので、下で発火する個別 signal-judge より「先」に Slack へ出す必要がある。schedule cron
		// で別に撃つと signal-judge より後ろにずれるため、ここで premarket 取得後すぐに発火する。
		if (event.cron === "30 23 * * *") {
			await collectBackdrop(env).catch((e) =>
				console.error("backdrop failed:", e),
			);
			// 銘柄非依存なので client_payload は空。App 認証が無ければ no-op (false)。
			await dispatchEventPayload(
				env,
				"market-check",
				{},
				event.scheduledTime,
			).catch((e) => console.error("market-check dispatch failed:", e));
		}
		// IR(kioxia公式) + 適時開示(全銘柄TDnet) + ニュース(全銘柄) のいずれかに新規があった
		// 銘柄をまとめて signal-report を起動する。適時開示は /pull の ir カーソルに合流する。
		const ir = await collectAll(env, null, DEFAULT_LIMIT);
		const disc = await collectDisclosures(env, null);
		const news = await collectNews(env, null);
		// 証券会社レーティング (個社別 目標株価) も intake で収集する。日報は当日夕方〜夜に
		// 出揃うため、引け後 (20:00) intake で拾うと取りこぼしが少ない。新規があれば
		// 目標株価変更も判定材料なので signal-report 起動対象に含める。
		const rat = await collectRatings(env, null);
		// 信用残 (週次の需給データ) は引け後 (20:00) intake にだけ相乗りさせる。週1更新なので
		// 毎日取っても (ticker, 集計基準日) PK で1週1行に収束する (margin.ts 参照)。新しい週次行が
		// 公表された夜だけ freshTickers に乗り、上の IR/開示/ニュース/レーティングと束ねて 1 回
		// だけ dispatch する (信用残だけ更新された夜でも、揃ったタイミングで判定が走る)。
		const mgn =
			event.cron === "0 11 * * *"
				? await collectMargin(env, null).catch((e) => {
						console.error("margin failed:", e);
						return { results: null, freshTickers: [] as string[] };
					})
				: { results: null, freshTickers: [] as string[] };
		const fresh = [
			...new Set([
				...ir.freshTickers,
				...disc.freshTickers,
				...news.freshTickers,
				...rat.freshTickers,
				...mgn.freshTickers,
			]),
		];
		console.log(
			"scheduled ir+disclosure+news+ratings+margin done:",
			JSON.stringify({
				ir: ir.results,
				disclosure: disc.results,
				news: news.results,
				ratings: rat.results,
				...(mgn.results ? { margin: mgn.results } : {}),
			}),
			"fresh:",
			fresh.join(","),
		);
		// intake (寄り前 8:30 / 引け後 20:00) は新規の有無によらず全銘柄を signal-update する。
		// fresh だけを撃つと、出来高/話題の薄い銘柄 (例: 6857 が数日ニュース 0) が一度も判定されず
		// 取り残されるため。context-builder は新規 0 なら no-update でコンテキストを触らないが、
		// signal-judge はワークフロー側で無条件に発火する (context-builder.yml の dispatch ステップ)
		// ので、価格/地合いの変化だけは寄り前/引け後ごとに必ず拾える。
		// 場中 (prices, 5分毎) は LLM コストを抑えるため従来どおり新規ベース (下の分岐)。
		await dispatchSignalUpdate(env, WATCHLIST);
		return;
	}
	if (kind === "prices") {
		// 場中 5分毎。価格スナップショットに加え、銘柄ニュース速報も拾う (新着で即判定するため)。
		const p = await collectTimeseries(env, "prices", null);
		const news = await collectNews(env, null);
		// JST 12:30 相当スロットでは IR + 適時開示 intake も相乗りさせる (昼の専用 cron を持たないため)。
		// IR・適時開示・ニュースどの新着でも signal-report を起動するので fresh を統合して dispatch する。
		let ir: { freshTickers: string[] } | null = null;
		let disc: { freshTickers: string[] } | null = null;
		if (isNoonIntakeSlot(event.scheduledTime)) {
			ir = await collectAll(env, null, DEFAULT_LIMIT);
			disc = await collectDisclosures(env, null);
		}
		const fresh = [
			...new Set([
				...news.freshTickers,
				...(ir?.freshTickers ?? []),
				...(disc?.freshTickers ?? []),
			]),
		];
		console.log(
			"scheduled prices+news done:",
			JSON.stringify({
				prices: p,
				news: news.results,
				...(ir ? { irNoonIntake: ir } : {}),
				...(disc ? { disclosureNoonIntake: disc } : {}),
			}),
			"fresh:",
			fresh.join(","),
		);
		// 場中は同一銘柄の短時間連発を抑える (デバウンス)。intake (上の分岐) は抑えない。
		await dispatchSignalUpdate(env, fresh, true);
		return;
	}
	if (kind === "eod") {
		// 引け後の1日1回。daily + fundamentals + 次回決算予定日の推定をまとめて実行。
		const d = await collectTimeseries(env, "daily", null);
		const f = await collectTimeseries(env, "fundamentals", null);
		const e = await collectEarnings(env, null);
		// 海外SOX系ピア (MU/NVDA 等) の次回決算日も毎 eod 取得する。次回日は決算ごとに繰り上がる
		// ため月初1回では最大1ヶ月古くなる。watchlist の earnings と同頻度・同思想 (毎日上書き)。
		// 失敗しても eod の主収集は壊さない (catch でログのみ)。
		const pe = await collectPeerEarnings(env, null).catch((err) => {
			console.error("peer-earnings failed:", err);
			return null;
		});
		// マクロイベント (FOMC/日銀) は月初スロットでだけ相乗り収集する。会合は年8回・先の日程が
		// 確定公表されており月1で十分。失敗しても eod の主収集は壊さない (catch でログのみ)。
		let macro: Record<string, unknown> | null = null;
		if (isJstMonthStart(event.scheduledTime)) {
			macro = await collectMacroEvents(env).catch((err) => {
				console.error("macro-events failed:", err);
				return null;
			});
		}
		console.log(
			"scheduled eod done:",
			JSON.stringify({
				daily: d,
				fundamentals: f,
				earnings: e,
				...(pe ? { peerEarnings: pe } : {}),
				...(macro ? { macroEvents: macro } : {}),
			}),
		);
		return;
	}
	const res = await collectTimeseries(env, kind, null);
	console.log(`scheduled ${kind} done:`, JSON.stringify(res));
}
