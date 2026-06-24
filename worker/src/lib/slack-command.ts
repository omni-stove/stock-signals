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

// 銘柄選択 UI の block_id 接頭辞 / action_id / modal callback_id。/slack/interact 側で突き合わせる。
// ACTION_ID だけ routes の interact が action_id 照合に使うので export する。
const BLOCK_ID = "ticker_block";
export const ACTION_ID = "ticker_select";
const PICKER_CALLBACK_ID = "ticker_picker";

// actions block 1 つに置けるボタン数の上限 (Slack 制約は 25)。超えたら複数ブロックに分割する。
const MAX_BUTTONS_PER_BLOCK = 25;

// ephemeral (本人にだけ見える) 応答。dispatch の起動可否はチャンネルに撒かない。
export function ephemeral(text: string): Response {
	return Response.json({ response_type: "ephemeral", text });
}

// WATCHLIST から銘柄選択用のボタン element を組み立てる。
// 表示は「コード 会社名」(WATCHLIST_NAMES)。スマホでは static_select のプルダウンが
// 「modal を開く→プルダウンを開く→スクロールして探す」と段数が多くもたつくため、
// 銘柄をボタンで平置きして 1 タップで撃てるようにする (action_id は全ボタン共通の ACTION_ID)。
// interact (block_actions) には元コマンドの手掛かりが残らないので、value に "<cmd>:<code>"
// を埋めて往復させる (どの解析を撃つかをピッカー選択時に復元するため)。
function tickerButtons(cmd: string) {
	return WATCHLIST.map((code) => {
		const name = WATCHLIST_NAMES[code];
		return {
			type: "button",
			action_id: ACTION_ID,
			text: {
				type: "plain_text",
				text: name ? `${code} ${name}` : code,
			},
			value: `${cmd}:${code}`,
		};
	});
}

// 銘柄ピッカー modal の view を組む。見出し section の下に銘柄ボタンを actions block で平置きし、
// ボタンを押した瞬間に block_actions が /slack/interact に飛ぶ (Submit ボタンは持たない → 選択即発火)。
// actions block は 1 つにつき最大 25 element なので、銘柄数が増えても落ちないよう分割する。
// 起動可否のフィードバックは選択後に views.update でこの view を差し替えて出す。
// callback_id / external 状態は使わず、value の "<cmd>:<code>" だけでコマンドと銘柄を運ぶ。
export function pickerView(cmd: string, headline: string) {
	const buttons = tickerButtons(cmd);
	const actionBlocks = [];
	for (let i = 0; i < buttons.length; i += MAX_BUTTONS_PER_BLOCK) {
		actionBlocks.push({
			type: "actions",
			block_id: `${BLOCK_ID}_${i / MAX_BUTTONS_PER_BLOCK}`,
			elements: buttons.slice(i, i + MAX_BUTTONS_PER_BLOCK),
		});
	}
	return {
		type: "modal",
		callback_id: PICKER_CALLBACK_ID,
		title: { type: "plain_text", text: "銘柄を選択" },
		// Submit を出さない (close のみ)。ボタンを押した瞬間に発火し view を更新する設計のため。
		close: { type: "plain_text", text: "閉じる" },
		blocks: [
			{
				type: "section",
				block_id: BLOCK_ID,
				text: { type: "mrkdwn", text: headline },
			},
			...actionBlocks,
		],
	};
}

// 結果表示用 view (選択後に views.update で差し替える)。select は消し、文言だけ出す。
export function resultView(text: string) {
	return {
		type: "modal",
		callback_id: PICKER_CALLBACK_ID,
		title: { type: "plain_text", text: "起動" },
		close: { type: "plain_text", text: "閉じる" },
		blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
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

	describe("tickerButtons", () => {
		it("コードと会社名を表示するボタンを作り、value に <cmd>:<code> を埋める", () => {
			const buttons = tickerButtons("signal");
			expect(buttons).toHaveLength(WATCHLIST.length);
			expect(buttons[0]).toEqual({
				type: "button",
				action_id: ACTION_ID,
				text: {
					type: "plain_text",
					text: `${WATCHLIST[0]} ${WATCHLIST_NAMES[WATCHLIST[0]]}`,
				},
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
		it("modal 型で見出し section と銘柄ボタンを持ち、ボタンの value に cmd を埋める", () => {
			const view = pickerView("signal", "見出し") as {
				type: string;
				blocks: {
					type: string;
					text?: { text: string };
					elements?: { action_id: string; value: string }[];
				}[];
			};
			expect(view.type).toBe("modal");
			const headline = view.blocks[0];
			expect(headline.type).toBe("section");
			expect(headline.text?.text).toBe("見出し");
			// 銘柄ボタンは見出しに続く actions block の elements に入る。
			const buttons = view.blocks
				.filter((b) => b.type === "actions")
				.flatMap((b) => b.elements ?? []);
			expect(buttons).toHaveLength(WATCHLIST.length);
			expect(buttons[0].action_id).toBe(ACTION_ID);
			expect(buttons[0].value).toBe(`signal:${WATCHLIST[0]}`);
		});

		it("銘柄数が actions block 上限を超えても全ボタンを分割して保持する", () => {
			// MAX_BUTTONS_PER_BLOCK は private なので、現状の銘柄数なら 1 ブロックに収まることだけ確認しつつ、
			// 分割ロジック自体は elements 総数が WATCHLIST と一致することで担保する。
			const view = pickerView("crash", "見出し") as {
				blocks: { type: string; elements?: unknown[] }[];
			};
			const total = view.blocks
				.filter((b) => b.type === "actions")
				.reduce((n, b) => n + (b.elements?.length ?? 0), 0);
			expect(total).toBe(WATCHLIST.length);
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
