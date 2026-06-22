// Cloudflare Worker: Slack スラッシュコマンド (/crash, /signal) の受け口。
//
// 経路: Slack で `/crash` または `/signal` → POST /slack/command (このルート)。
//   - 引数あり (`/crash 285A`)         → その銘柄で即 repository_dispatch (該当 event_type)。
//   - 引数なし / 未知コード (`/crash`) → views.open で銘柄ピッカー modal を開く。modal 内の
//       static_select を選ぶと block_actions が POST /slack/interact に届き、そこで dispatch +
//       views.update で結果文へ差し替える (Submit ボタンは持たず、選択した瞬間に発火する)。
//   コマンドの違い (どの解析を撃つか / 文言 / ピッカーの value 接頭辞) は COMMANDS で持つ。
//   /crash → crash-scenario (暴落プリモーテム)、/signal → signal-judge (buy/sell 判定)。
//
// 認証: Bearer (SYNC_TOKEN) は Slack が付けられないので使わない。なりすまし防止は
//   Slack 署名検証 (verifySlackSignature) のみ。そのため index.ts では /slack/* を
//   auth ミドルウェアより前に登録する (/health と同じ扱い)。SLACK_SIGNING_SECRET 未設定なら
//   検証不能なので 503 を返し、口を開けない。
//
// dispatch 実体は GitHub Actions の各ワークフロー (repository_dispatch: <event_type>)。
// このルートは「起動するだけ」で、解析本文は skill が Slack に投稿する。

import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { db } from "../lib/db";
import type { Env } from "../lib/env";
import { dispatchEvent, dispatchEventPayload } from "../lib/github-dispatch";
import { slackThreads } from "../lib/schema";
import { addReaction, openView, updateView } from "../lib/slack";
import { verifySlackSignature } from "../lib/slack-verify";
import { WATCHLIST } from "../lib/timeseries";

export const slack = new Hono<{ Bindings: Env }>();

// スラッシュコマンドごとの定義。command (Slack 登録名、先頭 / 抜き) で引く。
// event_type は各ワークフローの on.repository_dispatch.types と一致させる。
// fired は発火成功時、failed は失敗時の文言テンプレ (ticker を差し込む)。
type Command = {
	eventType: string;
	pick: string; // ピッカーの見出し (どの解析を実行するか)
	fired: (ticker: string) => string;
	failed: (ticker: string) => string;
};
const COMMANDS: Record<string, Command> = {
	crash: {
		eventType: "crash-scenario",
		pick: "暴落プリモーテムを実行する銘柄を選んでください。",
		fired: (t) =>
			`⚠️ ${t} の暴落プリモーテムを起動しました。結果は数分後にこのチャンネルへ届きます。`,
		failed: (t) =>
			`${t} の起動に失敗しました (GitHub App 認証 / dispatch を確認してください)。`,
	},
	signal: {
		eventType: "signal-judge",
		pick: "buy/sell 判定を実行する銘柄を選んでください。",
		fired: (t) =>
			`📈 ${t} の buy/sell 判定を起動しました。結果は数分後にこのチャンネルへ届きます。`,
		failed: (t) =>
			`${t} の起動に失敗しました (GitHub App 認証 / dispatch を確認してください)。`,
	},
};

// 銘柄選択 UI の block_id / action_id / modal callback_id。/slack/interact 側で突き合わせる。
const BLOCK_ID = "ticker_block";
const ACTION_ID = "ticker_select";
const PICKER_CALLBACK_ID = "ticker_picker";

// ephemeral (本人にだけ見える) 応答。dispatch の起動可否はチャンネルに撒かない。
function ephemeral(text: string): Response {
	return Response.json({ response_type: "ephemeral", text });
}

// WATCHLIST から銘柄選択用の static_select option を組み立てる。
// 表示名は持たない (Worker は watchlist.yaml を読まない設計) のでコードをそのまま出す。
// interact (block_actions) には元コマンドの手掛かりが残らないので、value に "<cmd>:<code>"
// を埋めて往復させる (どの解析を撃つかをピッカー選択時に復元するため)。
function tickerOptions(cmd: string) {
	return WATCHLIST.map((code) => ({
		text: { type: "plain_text", text: code },
		value: `${cmd}:${code}`,
	}));
}

// 銘柄ピッカー modal の view を組む。section の accessory に static_select を置き、選択した
// 瞬間に block_actions が /slack/interact に飛ぶ (Submit ボタンは持たない → 選択即発火)。
// 起動可否のフィードバックは選択後に views.update でこの view を差し替えて出す。
// callback_id / external 状態は使わず、value の "<cmd>:<code>" だけでコマンドと銘柄を運ぶ。
function pickerView(cmd: string, headline: string) {
	return {
		type: "modal",
		callback_id: PICKER_CALLBACK_ID,
		title: { type: "plain_text", text: "銘柄を選択" },
		// Submit を出さない (close のみ)。選択した瞬間に発火し view を更新する設計のため。
		close: { type: "plain_text", text: "閉じる" },
		blocks: [
			{
				type: "section",
				block_id: BLOCK_ID,
				text: { type: "mrkdwn", text: headline },
				accessory: {
					type: "static_select",
					action_id: ACTION_ID,
					placeholder: { type: "plain_text", text: "銘柄を選択" },
					options: tickerOptions(cmd),
				},
			},
		],
	};
}

// 結果表示用 view (選択後に views.update で差し替える)。select は消し、文言だけ出す。
function resultView(text: string) {
	return {
		type: "modal",
		callback_id: PICKER_CALLBACK_ID,
		title: { type: "plain_text", text: "起動" },
		close: { type: "plain_text", text: "閉じる" },
		blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
	};
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
async function fire(
	env: Env,
	cmd: Command,
	ticker: string,
	nowMs: number,
): Promise<string> {
	const ok = await dispatchEvent(env, cmd.eventType, ticker, nowMs);
	return ok ? cmd.fired(ticker) : cmd.failed(ticker);
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

// POST /slack/command : スラッシュコマンド (/crash, /signal) の受け口。
// form.command (例 "/crash") の先頭 / を外して COMMANDS を引き、どの解析を撃つか決める。
slack.post("/slack/command", async (c) => {
	const v = await verified(c);
	if ("err" in v) return v.err;

	// Slack は application/x-www-form-urlencoded で送る (command / text / trigger_id 等)。
	const form = new URLSearchParams(v.raw);
	const cmdKey = (form.get("command") ?? "").replace(/^\//, "");
	const cmd = COMMANDS[cmdKey];
	// 未登録コマンド (想定外) は静かに無視せず本人に知らせる。
	if (!cmd) return ephemeral(`未対応のコマンド: /${cmdKey}`);
	const arg = (form.get("text") ?? "").trim().toUpperCase();
	const nowMs = Date.now();

	// 引数が有効な銘柄コードなら modal を挟まず即発火する。
	if (WATCHLIST.includes(arg)) {
		return ephemeral(await fire(c.env, cmd, arg, nowMs));
	}

	// それ以外 (空 / 未知コード) は銘柄ピッカー modal を開く (views.open)。trigger_id は約3秒で
	// 失効するので waitUntil に回さずここで await する (Slack の3秒応答制約には収まる)。view 内の
	// static_select を選ぶと block_actions が /slack/interact に届き、そこで dispatch する。
	const triggerId = form.get("trigger_id") ?? "";
	const headline =
		arg && !WATCHLIST.includes(arg)
			? `未対応の銘柄コード: ${arg}。下から選んでください。`
			: cmd.pick;
	const opened = await openView(c.env, {
		trigger_id: triggerId,
		view: pickerView(cmdKey, headline),
	});
	// views.open 失敗 (トークン未設定/失効) は ephemeral でフォールバック通知する。
	if (!opened)
		return ephemeral(
			"銘柄ピッカーを開けませんでした (SLACK_BOT_TOKEN / commands スコープを確認してください)。",
		);
	// modal を開いたら slash command への HTTP 応答は空 200 でよい (本文はチャンネルに撒かない)。
	return c.body(null, 200);
});

// 返信対話の dispatch 先 (slack-reply.yml の on.repository_dispatch.types と一致させる)。
const REPLY_EVENT_TYPE = "slack-reply";

// POST /slack/events : Slack Events API の受け口 (message.channels)。
// 解析結果 (signal-judge / crash-scenario) の投稿にスレッド返信されたら、その投稿の ts で
// slack_threads を引いて銘柄を復元し、slack-reply ワークフローを dispatch する。Action が
// 銘柄コンテキスト+数値+スレッド履歴を読んで返答を生成し、同スレッドへ投稿する。
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
	const row =
		(await db(c.env.DB)
			.select({
				ticker: slackThreads.ticker,
				kind: slackThreads.kind,
				channel: slackThreads.channel,
			})
			.from(slackThreads)
			.where(eq(slackThreads.threadTs, ev.thread_ts))
			.get()) ?? null;
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

// POST /slack/interact : modal 内の static_select で銘柄を選んだときに飛んでくる
// (block_actions)。payload= に JSON が URL エンコードで入る。view.id でその modal を引ける。
slack.post("/slack/interact", async (c) => {
	const v = await verified(c);
	if ("err" in v) return v.err;

	const form = new URLSearchParams(v.raw);
	const payload = JSON.parse(form.get("payload") ?? "{}") as {
		type?: string;
		view?: { id?: string };
		actions?: { action_id?: string; selected_option?: { value?: string } }[];
	};

	if (payload.type !== "block_actions") return c.body(null, 200);
	const action = payload.actions?.find((a) => a.action_id === ACTION_ID);
	// value は command 側で埋めた "<cmd>:<code>"。分解してコマンドと銘柄を復元する。
	const [cmdKey, ticker] = (action?.selected_option?.value ?? "").split(":");
	const cmd = COMMANDS[cmdKey ?? ""];
	const viewId = payload.view?.id ?? "";
	if (!cmd || !WATCHLIST.includes(ticker ?? "")) {
		// 不正値: modal をエラー文へ差し替える (best-effort)。
		if (viewId)
			c.executionCtx.waitUntil(
				updateView(c.env, {
					view_id: viewId,
					view: resultView("銘柄が取得できませんでした。"),
				}),
			);
		return c.body(null, 200);
	}

	// 3秒制約: dispatch (GitHub App JWT 取得を含み数百ms〜) と views.update は waitUntil に回し、
	// HTTP は即 200 を返す。view_id は失効しないので非同期更新で問題ない。modal は選択直後は
	// そのまま残り、dispatch 完了後に結果文へ差し替わる。
	c.executionCtx.waitUntil(
		fire(c.env, cmd, ticker, Date.now()).then((text) =>
			viewId
				? updateView(c.env, { view_id: viewId, view: resultView(text) })
				: undefined,
		),
	);
	return c.body(null, 200);
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
		it("WATCHLIST 各コードを static_select option 形式にし、value に <cmd>:<code> を埋める", () => {
			const opts = tickerOptions("signal");
			expect(opts).toHaveLength(WATCHLIST.length);
			expect(opts[0]).toEqual({
				text: { type: "plain_text", text: WATCHLIST[0] },
				value: `signal:${WATCHLIST[0]}`,
			});
		});
	});

	describe("COMMANDS", () => {
		it("crash / signal を別々の event_type に対応づける", () => {
			expect(COMMANDS.crash.eventType).toBe("crash-scenario");
			expect(COMMANDS.signal.eventType).toBe("signal-judge");
		});
	});

	describe("pickerView", () => {
		it("modal 型で見出しと static_select を持ち、select の value に cmd を埋める", () => {
			const view = pickerView("signal", "見出し") as {
				type: string;
				blocks: {
					text: { text: string };
					accessory: {
						action_id: string;
						options: { value: string }[];
					};
				}[];
			};
			expect(view.type).toBe("modal");
			const block = view.blocks[0];
			expect(block.text.text).toBe("見出し");
			expect(block.accessory.action_id).toBe(ACTION_ID);
			expect(block.accessory.options[0].value).toBe(`signal:${WATCHLIST[0]}`);
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
