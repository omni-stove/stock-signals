// Cloudflare Worker: stock-signals 収集。エントリポイントの組み立てのみ。
//   - scheduled(): Cron Trigger 発火時。cron.ts の runScheduled に委譲。
//   - fetch():     Hono アプリ。ルート実装は routes/*.ts、IR収集本体は ir-collect.ts。
//
// 収集の中身 (IR/ニュース/適時開示/レーティング/価格/決算/地合い) は各 collect モジュールに、
// HTTP ルーティングは routes/ に、cron 配線は cron.ts に分離してある。ここは配線だけ持つ。

import { Hono } from "hono";
import { runScheduled } from "./lib/cron";
import type { Env } from "./lib/env";
import { auth } from "./routes/auth";
import { context } from "./routes/context";
import { latest } from "./routes/latest";
import { misc } from "./routes/misc";
import { pull } from "./routes/pull";
import { run } from "./routes/run";
import { slack } from "./routes/slack";

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
app.route("/", misc); // /dispatch-test, /test-slack

app.notFound((c) =>
	c.text(
		"stock-signals collector. routes: /run?kind=ir|news|disclosure|ratings|prices|daily|fundamentals|earnings|margin|premarket /latest?kind= /pull?code= /pull-news?code= /context?code= /health /test-slack /slack/post /slack/command /slack/interact /slack/events",
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
