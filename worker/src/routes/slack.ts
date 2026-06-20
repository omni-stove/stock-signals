// Cloudflare Worker: Slack スラッシュコマンド /crash の受け口。
//
// 経路: Slack で `/crash` → POST /slack/command (このルート)。
//   - 引数あり (`/crash 285A`)         → その銘柄で即 repository_dispatch (crash-scenario)。
//   - 引数なし / 未知コード (`/crash`) → WATCHLIST から銘柄ピッカー (ephemeral + static_select)
//       を返し、選択 → POST /slack/interact (block_actions) で dispatch。真の modal (views.open)
//       はボットトークンが要るが Worker は持たない設計なので、ephemeral 内の select で代替する。
//
// 認証: Bearer (SYNC_TOKEN) は Slack が付けられないので使わない。なりすまし防止は
//   Slack 署名検証 (verifySlackSignature) のみ。そのため index.ts では /slack/* を
//   auth ミドルウェアより前に登録する (/health と同じ扱い)。SLACK_SIGNING_SECRET 未設定なら
//   検証不能なので 503 を返し、口を開けない。
//
// dispatch 実体は GitHub Actions の crash-scenario.yml (repository_dispatch: crash-scenario)。
// このルートは「起動するだけ」で、暴落シナリオ本文は skill が SLACK_WEBHOOK_URL に投稿する。

import { type Context, Hono } from "hono";
import type { Env } from "../lib/env";
import { dispatchEvent, dispatchEventPayload } from "../lib/github-dispatch";
import { addReaction } from "../lib/slack";
import { verifySlackSignature } from "../lib/slack-verify";
import { WATCHLIST } from "../lib/timeseries";

export const slack = new Hono<{ Bindings: Env }>();

const EVENT_TYPE = "crash-scenario";
// 銘柄選択 UI の block_id / action_id。/slack/interact 側で突き合わせる。
const BLOCK_ID = "ticker_block";
const ACTION_ID = "ticker_select";

// ephemeral (本人にだけ見える) 応答。dispatch の起動可否はチャンネルに撒かない。
function ephemeral(text: string): Response {
	return Response.json({ response_type: "ephemeral", text });
}

// WATCHLIST から銘柄選択用の static_select option を組み立てる。
// 表示名は持たない (Worker は watchlist.yaml を読まない設計) のでコードをそのまま出す。
function tickerOptions() {
	return WATCHLIST.map((code) => ({
		text: { type: "plain_text", text: code },
		value: code,
	}));
}

// Slack Events API (message.channels) の受信エンベロープ。
type SlackMessageEvent = {
	type?: string;
	subtype?: string;
	bot_id?: string;
	text?: string;
	user?: string;
	channel?: string;
	ts?: string;
	thread_ts?: string;
};
type SlackEventEnvelope = {
	type?: string;
	challenge?: string;
	event?: SlackMessageEvent;
};

// message イベントに「スレッド返信として反応すべきか」を判定する純粋関数。
// 反応する条件: event_callback の message で、subtype/bot_id が無く (= 人間の新規投稿)、
// thread_ts を持ち (= スレッド内)、それが ts と異なる (= 親自身ではなく返信)。
// これに当てはまらないものは全て無視する (bot 自身の投稿による無限ループや雑談スレを弾く)。
// 型ガードにして、通過後は ev が thread_ts: string を持つ message として扱えるようにする。
function shouldHandleReply(body: SlackEventEnvelope): body is {
	type: "event_callback";
	event: SlackMessageEvent & { thread_ts: string };
} {
	const ev = body.event;
	return Boolean(
		body.type === "event_callback" &&
			ev?.type === "message" &&
			!ev.subtype &&
			!ev.bot_id &&
			ev.thread_ts &&
			ev.thread_ts !== ev.ts,
	);
}

// dispatch を撃ち、結果メッセージを返す (command/interact 双方から使う)。
async function fire(env: Env, ticker: string, nowMs: number): Promise<string> {
	const ok = await dispatchEvent(env, EVENT_TYPE, ticker, nowMs);
	return ok
		? `⚠️ ${ticker} の暴落プリモーテムを起動しました。結果は数分後にこのチャンネルへ届きます。`
		: `${ticker} の起動に失敗しました (GitHub App 認証 / dispatch を確認してください)。`;
}

// 署名検証 + raw body 取得をまとめる。検証 NG なら Response を返す (呼び出し側で early return)。
async function verified(
	c: Context<{ Bindings: Env }>,
): Promise<{ raw: string } | { err: Response }> {
	const env = c.env;
	if (!env.SLACK_SIGNING_SECRET)
		return { err: c.json({ error: "SLACK_SIGNING_SECRET unset" }, 503) };
	const raw = await c.req.text();
	const ok = await verifySlackSignature(
		env,
		raw,
		c.req.header("x-slack-request-timestamp") ?? null,
		c.req.header("x-slack-signature") ?? null,
		Math.floor(Date.now() / 1000),
	);
	if (!ok) return { err: c.json({ error: "bad signature" }, 401) };
	return { raw };
}

// POST /slack/command : スラッシュコマンド /crash の受け口。
slack.post("/slack/command", async (c) => {
	const v = await verified(c);
	if ("err" in v) return v.err;

	// Slack は application/x-www-form-urlencoded で送る (text / trigger_id 等)。
	const form = new URLSearchParams(v.raw);
	const arg = (form.get("text") ?? "").trim().toUpperCase();
	const nowMs = Date.now();

	// 引数が有効な銘柄コードなら modal を挟まず即発火する。
	if (WATCHLIST.includes(arg)) {
		return ephemeral(await fire(c.env, arg, nowMs));
	}

	// それ以外 (空 / 未知コード) は銘柄を選ばせる。真の modal (views.open) はボットトークンが
	// 要るが、この Worker は持たない設計なので、ephemeral メッセージ内の static_select で
	// 代替する (本人にだけ見える銘柄ピッカー)。選択すると /slack/interact に飛ぶ。
	return Response.json({
		response_type: "ephemeral",
		text:
			arg && !WATCHLIST.includes(arg)
				? `未対応の銘柄コード: ${arg}。下から選んでください。`
				: "暴落プリモーテムを実行する銘柄を選んでください。",
		blocks: [
			{
				type: "actions",
				block_id: BLOCK_ID,
				elements: [
					{
						type: "static_select",
						action_id: ACTION_ID,
						placeholder: { type: "plain_text", text: "銘柄を選択" },
						options: tickerOptions(),
					},
				],
			},
		],
	});
});

// 返信対話の dispatch 先 (slack-reply.yml の on.repository_dispatch.types と一致させる)。
const REPLY_EVENT_TYPE = "slack-reply";

// POST /slack/events : Slack Events API の受け口 (message.channels)。
// 解析結果 (signal-judge / crash-scenario) の投稿にスレッド返信されたら、その投稿の ts で
// slack_threads を引いて銘柄を復元し、slack-reply ワークフローを dispatch する。Action が
// Issue本文+数値+スレッド履歴を読んで返答を生成し、同スレッドへ投稿する。
//
// 制約: Slack は 3 秒以内の 200 応答を要求し、遅いと再送→多重発火する。dispatch は
// waitUntil でバックグラウンドに回し、本体は即 200 を返す。無限ループ防止のため bot 自身の
// 投稿 (bot_id あり) には反応しない。slack_threads に親が無いスレッド (watchlist 外の雑談) も無視。
slack.post("/slack/events", async (c) => {
	const v = await verified(c);
	if ("err" in v) return v.err;

	const body = JSON.parse(v.raw) as SlackEventEnvelope;

	// Event Subscriptions の URL 検証 (初回登録時の challenge 応答)。
	if (body.type === "url_verification")
		return c.json({ challenge: body.challenge });

	// スレッド返信のみ対象。判定ロジックは shouldHandleReply に集約 (in-source test 対象)。
	// 型ガード通過後は ev.thread_ts が string として確定する。
	if (!shouldHandleReply(body)) return c.body(null, 200);
	const ev = body.event;

	// 親 ts (thread_ts) で銘柄を復元。slack_threads に無ければ対象外スレッド → 無視。
	const row = await c.env.DB.prepare(
		"SELECT ticker, kind, channel FROM slack_threads WHERE thread_ts = ?",
	)
		.bind(ev.thread_ts)
		.first<{ ticker: string; kind: string; channel: string }>();
	if (!row) return c.body(null, 200);

	const text = (ev.text ?? "").trim();
	if (!text) return c.body(null, 200);

	// 受付の可視化: ユーザーの返信メッセージ自体 (ev.ts) に 👀 を付け「受け付けた/処理中」を即返す。
	// 返答生成は数分かかるので、無反応だと届いたか分からない。best-effort で 200 応答は止めない。
	if (ev.ts) {
		const channel = ev.channel ?? row.channel;
		c.executionCtx.waitUntil(
			addReaction(c.env, { channel, timestamp: ev.ts, name: "eyes" }),
		);
	}

	// 3秒制約: dispatch は投げっぱなしにして即 200 を返す。Action が返答を同スレッドに投稿する。
	c.executionCtx.waitUntil(
		dispatchEventPayload(
			c.env,
			REPLY_EVENT_TYPE,
			{
				ticker: row.ticker,
				kind: row.kind,
				channel: row.channel,
				thread_ts: ev.thread_ts,
				text,
			},
			Date.now(),
		).then((ok) => {
			if (!ok) console.error(`slack-reply dispatch failed: ${row.ticker}`);
		}),
	);
	return c.body(null, 200);
});

// POST /slack/interact : ephemeral の static_select で銘柄を選んだときに飛んでくる
// (block_actions)。payload= に JSON が URL エンコードで入る。
slack.post("/slack/interact", async (c) => {
	const v = await verified(c);
	if ("err" in v) return v.err;

	const form = new URLSearchParams(v.raw);
	const payload = JSON.parse(form.get("payload") ?? "{}") as {
		type?: string;
		actions?: { action_id?: string; selected_option?: { value?: string } }[];
	};

	if (payload.type !== "block_actions") return c.body(null, 200);
	const action = payload.actions?.find((a) => a.action_id === ACTION_ID);
	const ticker = action?.selected_option?.value ?? "";
	if (!WATCHLIST.includes(ticker))
		return ephemeral("銘柄が取得できませんでした。");

	// replace_original で select を結果メッセージに差し替える (本人のみ可視のまま)。
	return Response.json({
		response_type: "ephemeral",
		replace_original: true,
		text: await fire(c.env, ticker, Date.now()),
	});
});

// in-source tests (本番ビルドでは tree-shake される。vitest.config.ts 参照)。
// D1/R2/dispatch を伴うハンドラ本体ではなく、そこから切り出した純粋ロジックだけを検証する。
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("ephemeral", () => {
		it("response_type=ephemeral の JSON Response を返す", async () => {
			const res = ephemeral("hello");
			expect(await res.json()).toEqual({
				response_type: "ephemeral",
				text: "hello",
			});
		});
	});

	describe("tickerOptions", () => {
		it("WATCHLIST 各コードを static_select option 形式にする", () => {
			const opts = tickerOptions();
			expect(opts).toHaveLength(WATCHLIST.length);
			expect(opts[0]).toEqual({
				text: { type: "plain_text", text: WATCHLIST[0] },
				value: WATCHLIST[0],
			});
		});
	});

	describe("shouldHandleReply", () => {
		const base = {
			type: "event_callback",
			event: { type: "message", ts: "200", thread_ts: "100" },
		} as const;

		it("人間によるスレッド返信なら true", () => {
			expect(shouldHandleReply(base)).toBe(true);
		});
		it("bot 自身の投稿は無視 (無限ループ防止)", () => {
			expect(
				shouldHandleReply({ ...base, event: { ...base.event, bot_id: "B1" } }),
			).toBe(false);
		});
		it("subtype 付き (編集/削除等) は無視", () => {
			expect(
				shouldHandleReply({
					...base,
					event: { ...base.event, subtype: "message_changed" },
				}),
			).toBe(false);
		});
		it("thread_ts が無い (スレッド外の新規投稿) は無視", () => {
			expect(
				shouldHandleReply({
					type: "event_callback",
					event: { type: "message", ts: "200" },
				}),
			).toBe(false);
		});
		it("thread_ts === ts (親メッセージ自身) は無視", () => {
			expect(
				shouldHandleReply({
					...base,
					event: { type: "message", ts: "100", thread_ts: "100" },
				}),
			).toBe(false);
		});
		it("event_callback 以外 (url_verification 等) は無視", () => {
			expect(shouldHandleReply({ ...base, type: "url_verification" })).toBe(
				false,
			);
		});
		it("message 以外のイベント種別は無視", () => {
			expect(
				shouldHandleReply({
					...base,
					event: { ...base.event, type: "reaction_added" },
				}),
			).toBe(false);
		});
	});
}
