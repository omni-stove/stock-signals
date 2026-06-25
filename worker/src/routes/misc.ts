// Cloudflare Worker: 疎通確認系ルート (要認証)。/dispatch-test と /test-slack。
// /health は無認証なので index.ts 側で auth ミドルウェアより前に分岐させる。

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../lib/db";
import type { Env } from "../lib/env";
import { checkIndexRebalance } from "../lib/event-context";
import { dispatchSignalUpdate } from "../lib/github-dispatch";
import { resolveMarketPhase } from "../lib/market-phase";
import { parseMarketRegime } from "../lib/market-regime";
import { marketRegime, slackThreads } from "../lib/schema";
import { notifySlack, postMessage } from "../lib/slack";

export const misc = new Hono<{ Bindings: Env }>();

// /index-rebalance?now=<ISO8601 任意>
//   今日 (JST) が指数リバランス (MSCI/FTSE/日経/TOPIX) の近接窓に入っていれば、その観測行断片を
//   "; " 連結で返す (窓外なら空文字)。post-signal.sh が投稿末尾に貼る「📅 リバランス窓」用。
//   方向判断 (judge) には渡さない時間アノマリーなので judge-context とは別の軽量口にしている。
misc.get("/index-rebalance", (c) => {
	const { today } = resolveMarketPhase(c.req.query("now") ?? null, Date.now());
	return c.json({
		ok: true,
		today,
		note: checkIndexRebalance(today).join("; "),
	});
});

// /dispatch-test?code=285A
//   App認証→repository_dispatch の疎通確認用。IR取得はせず、指定銘柄で強制発火する。
//   新規の有無に関係なく signal-report (workflow_dispatch相当) を起動できるので、
//   発火経路 (JWT署名→installation token→dispatch) のE2E確認に使う。
misc.get("/dispatch-test", async (c) => {
	const env = c.env;
	const code = c.req.query("code") || "285A";
	const configured = !!(
		env.GH_APP_ID &&
		env.GH_APP_PRIVATE_KEY &&
		env.GH_APP_INSTALL_ID
	);
	await dispatchSignalUpdate(env, [code]);
	return c.json({ ok: true, dispatched: configured, ticker: code });
});

// /test-slack : Webhook疎通確認。ダミー1件を実際にSlackへ送る。
misc.get("/test-slack", async (c) => {
	const env = c.env;
	if (!env.SLACK_IR_WEBHOOK_URL && !env.SLACK_WEBHOOK_URL) {
		throw new HTTPException(400, {
			res: Response.json(
				{
					ok: false,
					error: "SLACK_IR_WEBHOOK_URL / SLACK_WEBHOOK_URL とも未設定",
				},
				{ status: 400 },
			),
		});
	}
	await notifySlack(env, [
		{
			ticker: "285A",
			title: "【テスト】Slack通知の疎通確認",
			url: "https://www.kioxia-holdings.com/ja-jp/news.html",
			date: "2026-06-17",
			category: "holdings",
		},
	]);
	return c.json({ ok: true, sent: true });
});

// POST /slack/post : Bot トークンで Slack に投稿する (要 SYNC_TOKEN 認証)。
// webhook と違い ts が取れるので、解析結果の投稿 (thread_ts 無し) は slack_threads に控え、
// その ts へのスレッド返信から銘柄を復元できるようにする (返信対話の起点)。
//   body(JSON): { channel, ticker, kind, text, blocks?, thread_ts? }
//     - thread_ts 無し = 新規スレッドの親 (解析結果)。投稿後 ts を slack_threads に INSERT。
//     - thread_ts 有り = 返答 (slack-reply)。同スレッドにぶら下げるだけ (記録しない)。
//   channel 省略時は SLACK_REPLY_CHANNEL を使う。SLACK_BOT_TOKEN 未設定なら 503。
misc.post("/slack/post", async (c) => {
	const env = c.env;
	if (!env.SLACK_BOT_TOKEN) {
		throw new HTTPException(503, {
			res: Response.json(
				{ ok: false, error: "SLACK_BOT_TOKEN unset" },
				{ status: 503 },
			),
		});
	}
	const b = (await c.req.json().catch(() => ({}))) as {
		channel?: string;
		ticker?: string;
		kind?: string;
		text?: string;
		blocks?: unknown[];
		thread_ts?: string;
	};
	const channel = b.channel || env.SLACK_REPLY_CHANNEL;
	if (!channel || !b.text) {
		throw new HTTPException(400, {
			res: Response.json(
				{
					ok: false,
					error: "channel (or SLACK_REPLY_CHANNEL) and text required",
				},
				{ status: 400 },
			),
		});
	}

	const posted = await postMessage(env, {
		channel,
		text: b.text,
		blocks: b.blocks,
		thread_ts: b.thread_ts,
	});
	if (!posted) {
		throw new HTTPException(502, {
			res: Response.json(
				{ ok: false, error: "chat.postMessage failed" },
				{ status: 502 },
			),
		});
	}

	// market-check の地合いコールは market_regime に当日分を控える (judge-context が前段ゲートに使う)。
	// b.text = ヘッドライン (`🌐 地合い: <regime>・<stance>`)。3 値が読めた時だけ書く。
	if (b.kind === "market-check" && b.text) {
		const parsed = parseMarketRegime(b.text);
		if (parsed) {
			const nowIso = new Date().toISOString();
			const { today } = resolveMarketPhase(null, Date.now());
			await db(env.DB)
				.insert(marketRegime)
				.values({
					date: today,
					regime: parsed.regime,
					stance: parsed.stance,
					headline: b.text,
					fetchedAt: nowIso,
				})
				.onConflictDoUpdate({
					target: marketRegime.date,
					set: {
						regime: parsed.regime,
						stance: parsed.stance,
						headline: b.text,
						fetchedAt: nowIso,
					},
				})
				.run();
		}
	}

	// 解析結果 (親投稿) のみ slack_threads に控える。返答 (thread_ts 有り) は記録しない。
	if (!b.thread_ts && b.ticker) {
		const createdAt = new Date().toISOString();
		const kind = b.kind || "signal-judge";
		await db(env.DB)
			.insert(slackThreads)
			.values({
				threadTs: posted.ts,
				ticker: b.ticker,
				kind,
				channel: posted.channel,
				createdAt,
			})
			.onConflictDoUpdate({
				target: slackThreads.threadTs,
				set: { ticker: b.ticker, kind, channel: posted.channel, createdAt },
			})
			.run();
	}
	return c.json({ ok: true, ts: posted.ts, channel: posted.channel });
});
