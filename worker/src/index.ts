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
import { latest } from "./routes/latest";
import { misc } from "./routes/misc";
import { pull } from "./routes/pull";
import { run } from "./routes/run";

const app = new Hono<{ Bindings: Env }>();

// /health は疎通確認用に無認証で残す (外形監視/curl で叩けるように)。auth より前に置く。
app.get("/health", (c) => c.text("ok"));

// それ以外の全エンドポイントは SYNC_TOKEN を要求する (未設定なら認証なし = dev)。
app.use("*", auth);

app.route("/run", run);
app.route("/latest", latest);
app.route("/", pull); // /pull, /pull-news
app.route("/", misc); // /dispatch-test, /test-slack

app.notFound((c) =>
	c.text(
		"stock-signals collector. routes: /run?kind=ir|news|disclosure|ratings|prices|daily|fundamentals|earnings|margin|premarket /latest?kind= /pull?code= /pull-news?code= /health /test-slack",
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
