// Cloudflare Worker: stock-signals 収集。エントリポイントの組み立てのみ。
//   - scheduled(): Cron Trigger 発火時。cron.ts の runScheduled に委譲。
//   - fetch():     Hono アプリ。ルート実装は routes/*.ts、IR収集本体は ir-collect.ts。
//
// 収集の中身 (IR/ニュース/適時開示/レーティング/価格/決算/地合い) は各 collect モジュールに、
// HTTP ルーティングは routes/ に、cron 配線は cron.ts に分離してある。ここは配線だけ持つ。

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runScheduled } from "./lib/cron";
import type { Env } from "./lib/env";
import { auth } from "./routes/auth";
import { context } from "./routes/context";
import { contextInput } from "./routes/context-input";
import { judgeContext } from "./routes/judge-context";
import { latest } from "./routes/latest";
import { marketContext } from "./routes/market-context";
import { misc } from "./routes/misc";
import { pull } from "./routes/pull";
import { run } from "./routes/run";
import { slack } from "./routes/slack";
import { threadContext } from "./routes/thread-context";

const app = new Hono<{ Bindings: Env }>();

// /health は疎通確認用に無認証で残す (外形監視/curl で叩けるように)。auth より前に置く。
app.get("/health", (c) => c.text("ok"));

// /slack/command, /slack/interact (スラッシュコマンド /crash, /signal), /slack/events (Events API の
// 返信受信) は Slack が Bearer を付けられないので auth の対象外。なりすまし防止は Slack 署名検証
// (ルート内の verifySlackSignature) が担う。auth より前に置く。
// ※ /slack/post (Actions からの投稿) は misc 側にあり SYNC_TOKEN 認証配下 (Slack 発ではない)。
app.route("/", slack); // /slack/command, /slack/interact, /slack/events

// それ以外の全エンドポイントは SYNC_TOKEN を要求する (未設定なら認証なし = dev)。
app.use("*", auth);

app.route("/run", run);
app.route("/latest", latest);
app.route("/", pull); // /pull, /pull-news
app.route("/", context); // /context (GET=read, POST=upsert)
app.route("/", judgeContext); // /judge-context (signal-judge/crash/slack-reply 用バンドル)
app.route("/", contextInput); // /context-input (context-builder 用バンドル)
app.route("/", marketContext); // /market-context (market-check 用バンドル)
app.route("/", threadContext); // /thread-context (slack-reply 用バンドル)
app.route("/", misc); // /dispatch-test, /test-slack

// 未捕捉例外を一元処理する。各ルートが投げる HTTPException (res に Response.json を載せている)
// はその res をそのまま返す。それ以外の素の Error (collect 系のネットワーク失敗等) は 500 で
// 同じ { ok:false, error } JSON 形に揃える (デフォルトのプレーンテキスト 500 を避ける)。
app.onError((err, c) => {
	if (err instanceof HTTPException) return err.getResponse();
	// 5xx は tail で原因を追えるよう message + stack をログに出す (best-effort)。
	console.error(
		`unhandled error on ${c.req.method} ${c.req.path}: ${
			err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)
		}`,
	);
	return c.json(
		{ ok: false, error: err instanceof Error ? err.message : String(err) },
		500,
	);
});

app.notFound((c) =>
	c.text(
		"stock-signals collector. routes: /run?kind=ir|news|disclosure|ratings|prices|daily|fundamentals|earnings|margin|premarket /latest?kind= /pull?code= /pull-news?code= /context?code= /judge-context?code=&now= /context-input?code= /market-context?now= /thread-context?channel=&thread_ts=&kind=&text= /index-rebalance?now= /health /test-slack /slack/post /slack/command /slack/interact /slack/events",
		404,
	),
);

export default {
	async scheduled(
		event: ScheduledController,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<void> {
		await runScheduled(event, env);
	},

	fetch: app.fetch,
};
