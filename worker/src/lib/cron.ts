// Cloudflare Worker: Cron Trigger の配線。index.ts の scheduled() から切り出し。
// 発火した cron 式を event.cron で判別して取得種別に振り分ける。

import { collectDisclosures } from "./disclosure";
import { collectEarnings } from "./earnings";
import type { Env } from "./env";
import { dispatchSignalUpdate } from "./github-dispatch";
import { collectAll } from "./ir-collect";
import { DEFAULT_LIMIT } from "./ir-sources";
import { collectMargin } from "./margin";
import { collectNews } from "./news";
import { collectBackdrop } from "./premarket";
import { collectRatings } from "./ratings";
import { collectTimeseries } from "./timeseries";

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

// Cron Trigger 発火時。event.cron でどの cron が鳴ったか判別して種別を振り分ける。
export async function runScheduled(
	event: ScheduledController,
	env: Env,
): Promise<void> {
	const kind = CRON_KIND[event.cron] ?? "intake"; // 未知の cron は intake にフォールバック
	if (kind === "intake") {
		// intake cron (8:30/12:30/18:30) では IR とニュースを両方収集する。
		// 寄り前(8:30)のときだけ先に当日の地合いを D1 に取る。直後に発火する signal-judge が
		// pre-open weighting で当日 premarket 行を読めるようにするため (失敗しても収集は続行)。
		if (event.cron === "30 23 * * *") {
			await collectBackdrop(env).catch((e) =>
				console.error("backdrop failed:", e),
			);
		}
		// 信用残 (週次の需給データ) は引け後 (20:00) intake にだけ相乗りさせる。週1更新なので
		// 毎日取っても (ticker, 集計基準日) PK で1週1行に収束する (margin.ts 参照)。新規行が
		// 出ても signal-judge は次回の他材料発火時に最新を読むため、ここでは dispatch しない。
		if (event.cron === "0 11 * * *") {
			await collectMargin(env, null).catch((e) =>
				console.error("margin failed:", e),
			);
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
		const fresh = [
			...new Set([
				...ir.freshTickers,
				...disc.freshTickers,
				...news.freshTickers,
				...rat.freshTickers,
			]),
		];
		console.log(
			"scheduled ir+disclosure+news+ratings done:",
			JSON.stringify({
				ir: ir.results,
				disclosure: disc.results,
				news: news.results,
				ratings: rat.results,
			}),
			"fresh:",
			fresh.join(","),
		);
		await dispatchSignalUpdate(env, fresh);
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
		console.log(
			"scheduled eod done:",
			JSON.stringify({ daily: d, fundamentals: f, earnings: e }),
		);
		return;
	}
	const res = await collectTimeseries(env, kind, null);
	console.log(`scheduled ${kind} done:`, JSON.stringify(res));
}
