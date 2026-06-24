// Cloudflare Worker: Slack スラッシュコマンド (/crash, /signal) の受け口。
//
// 経路: Slack で `/crash` または `/signal` → POST /slack/command (このルート)。
//   - 引数あり (`/crash 285A`)         → その銘柄で即 repository_dispatch (該当 event_type)。
//   - 引数なし / 未知コード (`/crash`) → views.open で銘柄ピッカー modal を開く。modal 内の
//       銘柄ボタンを押すと block_actions が POST /slack/interact に届き、そこで dispatch +
//       views.update で結果文へ差し替える (Submit ボタンは持たず、押した瞬間に発火する)。
//       ボタン平置きはスマホ最適化 (プルダウンの段数・スクロール探しを無くす)。
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

import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { db } from "../lib/db";
import type { Env } from "../lib/env";
import { dispatchEvent, dispatchEventPayload } from "../lib/github-dispatch";
import { positions, slackThreads } from "../lib/schema";
import { addReaction, openView } from "../lib/slack";
import {
	ACTION_ID,
	BLOCK_ID,
	COMMANDS,
	type Command,
	ephemeral,
	POSITION_CALLBACK_ID,
	parsePositionSubmission,
	pickerView,
	positionFormView,
	type SlackEventEnvelope,
	shouldHandleReply,
} from "../lib/slack-command";
import { verifySlackSignature } from "../lib/slack-verify";
import { WATCHLIST } from "../lib/timeseries";

export const slack = new Hono<{ Bindings: Env }>();

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

// POST /slack/command : スラッシュコマンド (/crash, /signal, /position) の受け口。
// form.command (例 "/crash") の先頭 / を外して分岐する。/crash /signal は COMMANDS を引いて
// 解析を dispatch する。/position は dispatch ではなく保有ポジション登録 modal を開く (別系統)。
slack.post("/slack/command", async (c) => {
	const v = await verified(c);
	if ("err" in v) return v.err;

	// Slack は application/x-www-form-urlencoded で送る (command / text / trigger_id 等)。
	const form = new URLSearchParams(v.raw);
	const cmdKey = (form.get("command") ?? "").replace(/^\//, "");

	// /position はポジション登録 modal を開く (dispatch しない別系統)。view_submission は
	// /slack/interact が POSITION_CALLBACK_ID で判別して D1 へ保存する。
	if (cmdKey === "position") {
		const triggerId = form.get("trigger_id") ?? "";
		const opened = await openView(c.env, {
			trigger_id: triggerId,
			view: positionFormView(),
		});
		if (!opened)
			return ephemeral(
				"ポジション登録フォームを開けませんでした (SLACK_BOT_TOKEN / commands スコープを確認してください)。",
			);
		return c.body(null, 200);
	}

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
				// 返信した本人の Slack user_id。slack-reply が /thread-context へ渡し、
				// その人の建玉 (positions) だけを引いて含み損益を答えるのに使う。
				user: ev.user ?? "",
			},
			Date.now(),
		).then((ok) => {
			if (!ok) console.error(`slack-reply dispatch failed: ${row.ticker}`);
		}),
	);
	return c.body(null, 200);
});

// POST /slack/interact : 銘柄ピッカー modal の Submit (実行) を押したときに飛んでくる
// (view_submission)。payload= に JSON が URL エンコードで入る。
//   - どの解析か   : view.callback_id "<PICKER_CALLBACK_ID>:<cmd>" から復元する。
//   - どの銘柄か   : view.state.values[BLOCK_ID][ACTION_ID].selected_option.value から取る。
// dispatch (GitHub App JWT 取得を含む) は3秒制約に収まるので await し、成否で応答を分ける:
//   成功 → response_action: "clear" で modal が自動で閉じる (起動結果は数分後にチャンネルへ届く)。
//   失敗 → response_action: "errors" で入力欄にエラーを出す (modal は閉じず押し直せる)。
slack.post("/slack/interact", async (c) => {
	const v = await verified(c);
	if ("err" in v) return v.err;

	const form = new URLSearchParams(v.raw);
	const payload = JSON.parse(form.get("payload") ?? "{}") as {
		type?: string;
		user?: { id?: string };
		view?: {
			callback_id?: string;
			state?: {
				values?: Record<
					string,
					Record<
						string,
						{ value?: string; selected_option?: { value?: string } }
					>
				>;
			};
		};
	};

	if (payload.type !== "view_submission") return c.body(null, 200);

	// /position の登録フォーム submission。input を検証して positions に upsert する。
	// qty=0 は手仕舞いとして行を削除する。clear で modal を閉じ、結果は ephemeral で本人に返せない
	// (view_submission の応答に本文は載せられない) ため clear のみ。
	if (payload.view?.callback_id === POSITION_CALLBACK_ID) {
		// 建玉は Slack ユーザー単位。返信時に本人の行だけ引けるよう、登録者の user_id を必ず保存する。
		// view_submission payload には Slack が必ず user.id を載せる。万一欠けたら保存せずエラー表示。
		const userId = payload.user?.id ?? "";
		const parsed = parsePositionSubmission(
			payload.view?.state?.values,
			WATCHLIST,
		);
		if (!parsed.ok)
			return c.json({ response_action: "errors", errors: parsed.errors });
		if (!userId)
			return c.json({
				response_action: "errors",
				errors: { [BLOCK_ID]: "ユーザー情報を取得できませんでした。" },
			});
		const p = parsed.value;
		const drizzle = db(c.env.DB);
		if (p.qty === 0) {
			await drizzle
				.delete(positions)
				.where(
					and(
						eq(positions.userId, userId),
						eq(positions.ticker, p.ticker),
						eq(positions.account, p.account),
					),
				);
		} else {
			await drizzle
				.insert(positions)
				.values({
					userId,
					ticker: p.ticker,
					account: p.account,
					side: p.side,
					avgPrice: p.avgPrice,
					qty: p.qty,
					updatedAt: new Date().toISOString(),
				})
				.onConflictDoUpdate({
					target: [positions.userId, positions.ticker, positions.account],
					set: {
						side: p.side,
						avgPrice: p.avgPrice,
						qty: p.qty,
						updatedAt: new Date().toISOString(),
					},
				});
		}
		return c.json({ response_action: "clear" });
	}

	// callback_id "<PICKER_CALLBACK_ID>:<cmd>" の cmd 部だけ取り出す。
	const cmdKey = (payload.view?.callback_id ?? "").split(":")[1] ?? "";
	const cmd = COMMANDS[cmdKey];
	const ticker =
		payload.view?.state?.values?.[BLOCK_ID]?.[ACTION_ID]?.selected_option
			?.value ?? "";

	// 不正値: 入力欄にエラーを出して modal は閉じない (押し直せるように)。
	if (!cmd || !WATCHLIST.includes(ticker)) {
		return c.json({
			response_action: "errors",
			errors: {
				[BLOCK_ID]: "銘柄が取得できませんでした。選び直してください。",
			},
		});
	}

	const ok = await dispatchEvent(c.env, cmd.eventType, ticker, Date.now());
	if (ok) {
		// clear で modal を閉じる (起動結果は数分後にチャンネルへ届く)。
		return c.json({ response_action: "clear" });
	}
	// dispatch 失敗時は入力欄にエラーを出して閉じない。
	return c.json({
		response_action: "errors",
		errors: { [BLOCK_ID]: cmd.failed(ticker) },
	});
});
