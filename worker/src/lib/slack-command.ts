// Slack スラッシュコマンド (/crash, /signal) の純粋ロジック。
// ルート (routes/slack.ts) は署名検証・D1・dispatch を担い、view 組み立て・コマンド定義・
// イベント判定といった副作用のない部分はここに集約してテストを同伴させる。

import { WATCHLIST, WATCHLIST_NAMES } from "./timeseries";

// スラッシュコマンドごとの定義。command (Slack 登録名、先頭 / 抜き) で引く。
// event_type は各ワークフローの on.repository_dispatch.types と一致させる。
// fired は発火成功時、failed は失敗時の文言テンプレ (ticker を差し込む)。
export type Command = {
	eventType: string;
	pick: string; // ピッカーの見出し (どの解析を実行するか)
	fired: (ticker: string) => string;
	failed: (ticker: string) => string;
};
export const COMMANDS: Record<string, Command> = {
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

// 銘柄選択 UI の block_id / action_id / modal callback_id 接頭辞。/slack/interact 側で突き合わせる。
// ACTION_ID / BLOCK_ID / PICKER_CALLBACK_ID は routes の interact が view_submission 解析に使うので export する。
export const BLOCK_ID = "ticker_block";
export const ACTION_ID = "ticker_select";
// callback_id は "<PICKER_CALLBACK_ID>:<cmd>"。view_submission には元コマンドの手掛かりが
// 残らないので、どの解析 (signal/crash) を撃つかを callback_id に埋めて往復させる。
export const PICKER_CALLBACK_ID = "ticker_picker";

// ephemeral (本人にだけ見える) 応答。dispatch の起動可否はチャンネルに撒かない。
export function ephemeral(text: string): Response {
	return Response.json({ response_type: "ephemeral", text });
}

// WATCHLIST から static_select の option を組み立てる。表示は「コード 会社名」(WATCHLIST_NAMES)、
// value は銘柄コード。どの解析を撃つかは view の callback_id に埋めるので option には載せない。
function tickerOptions() {
	return WATCHLIST.map((code) => {
		const name = WATCHLIST_NAMES[code];
		return {
			text: {
				type: "plain_text",
				text: name ? `${code} ${name}` : code,
			},
			value: code,
		};
	});
}

// 銘柄ピッカー modal の view を組む。見出し section の下に銘柄を選ぶ static_select を input block で
// 置き、Submit ボタンを持つ。Submit を押すと view_submission が /slack/interact に飛び、そこで dispatch
// したうえで response_action: "clear" を返すと modal が自動で閉じる (block_actions では clear が効かず
// プログラムから modal を閉じる正規 API も無いため、Submit 方式にして閉じる)。
// どの解析 (signal/crash) を撃つかは callback_id "<PICKER_CALLBACK_ID>:<cmd>" に埋めて往復させる。
export function pickerView(cmd: string, headline: string) {
	return {
		type: "modal",
		callback_id: `${PICKER_CALLBACK_ID}:${cmd}`,
		title: { type: "plain_text", text: "銘柄を選択" },
		// Submit を押すと view_submission が飛ぶ。発火後に clear で閉じる。
		submit: { type: "plain_text", text: "実行" },
		close: { type: "plain_text", text: "閉じる" },
		blocks: [
			{
				type: "section",
				text: { type: "mrkdwn", text: headline },
			},
			{
				type: "input",
				block_id: BLOCK_ID,
				label: { type: "plain_text", text: "銘柄" },
				element: {
					type: "static_select",
					action_id: ACTION_ID,
					placeholder: { type: "plain_text", text: "銘柄を選択" },
					options: tickerOptions(),
				},
			},
		],
	};
}

// Slack Events API (message.channels) の受信エンベロープ。
export type SlackMessageEvent = {
	type?: string;
	subtype?: string;
	bot_id?: string;
	text?: string;
	user?: string;
	channel?: string;
	ts?: string;
	thread_ts?: string;
};
export type SlackEventEnvelope = {
	type?: string;
	challenge?: string;
	event?: SlackMessageEvent;
};

// message イベントに「スレッド返信として反応すべきか」を判定する純粋関数。
// 反応する条件: event_callback の message で、subtype/bot_id が無く (= 人間の新規投稿)、
// thread_ts を持ち (= スレッド内)、それが ts と異なる (= 親自身ではなく返信)。
// これに当てはまらないものは全て無視する (bot 自身の投稿による無限ループや雑談スレを弾く)。
// 型ガードにして、通過後は ev が thread_ts: string を持つ message として扱えるようにする。
export function shouldHandleReply(body: SlackEventEnvelope): body is {
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

// in-source tests (本番ビルドでは tree-shake される。vitest.config.ts 参照)。
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
		it("コードと会社名を表示する option を作り、value に銘柄コードを入れる", () => {
			const opts = tickerOptions();
			expect(opts).toHaveLength(WATCHLIST.length);
			expect(opts[0]).toEqual({
				text: {
					type: "plain_text",
					text: `${WATCHLIST[0]} ${WATCHLIST_NAMES[WATCHLIST[0]]}`,
				},
				value: WATCHLIST[0],
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
		it("modal 型で見出し section と Submit を持ち、callback_id に cmd を埋める", () => {
			const view = pickerView("signal", "見出し") as {
				type: string;
				callback_id: string;
				submit?: { text: string };
				blocks: {
					type: string;
					block_id?: string;
					text?: { text: string };
					element?: {
						type: string;
						action_id: string;
						options?: { value: string }[];
					};
				}[];
			};
			expect(view.type).toBe("modal");
			// callback_id は "<PICKER_CALLBACK_ID>:<cmd>"。view_submission で cmd を復元する。
			expect(view.callback_id).toBe(`${PICKER_CALLBACK_ID}:signal`);
			// Submit を持つ (押すと view_submission が飛び、dispatch 後に clear で閉じる)。
			expect(view.submit).toBeDefined();
			const headline = view.blocks[0];
			expect(headline.type).toBe("section");
			expect(headline.text?.text).toBe("見出し");
			// 銘柄は input block の static_select。block_id/action_id は interact 側の参照キーと一致させる。
			const input = view.blocks.find((b) => b.type === "input");
			expect(input?.block_id).toBe(BLOCK_ID);
			expect(input?.element?.type).toBe("static_select");
			expect(input?.element?.action_id).toBe(ACTION_ID);
			expect(input?.element?.options).toHaveLength(WATCHLIST.length);
			expect(input?.element?.options?.[0].value).toBe(WATCHLIST[0]);
		});

		it("callback_id の cmd は crash でも正しく埋まる", () => {
			const view = pickerView("crash", "見出し") as { callback_id: string };
			expect(view.callback_id).toBe(`${PICKER_CALLBACK_ID}:crash`);
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
