// Cloudflare Worker: 疎通確認系ルート (要認証)。/dispatch-test と /test-slack。
// /health は無認証なので index.ts 側で auth ミドルウェアより前に分岐させる。

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../lib/env";
import { dispatchSignalUpdate } from "../lib/github-dispatch";
import { notifySlack } from "../lib/slack";

export const misc = new Hono<{ Bindings: Env }>();

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
