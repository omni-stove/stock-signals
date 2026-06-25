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
// ACTION_ID / BLOCK_ID は routes の interact が view_submission 解析に使うので export する。
export const BLOCK_ID = "ticker_block";
export const ACTION_ID = "ticker_select";
// callback_id は "<PICKER_CALLBACK_ID>:<cmd>"。view_submission には元コマンドの手掛かりが
// 残らないので、どの解析 (signal/crash) を撃つかを callback_id に埋めて往復させる。
// pickerView が組み立て、interact 側は ":" split で cmd を取るだけなので export 不要。
const PICKER_CALLBACK_ID = "ticker_picker";

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

// ── /position : ユーザーの保有ポジション登録 modal ──────────────────────────
// /signal /crash は「銘柄を選んで dispatch」だが /position は「建玉を入力して D1 保存」なので
// COMMANDS とは別系統。modal の callback_id でこちらの submission だと判別する。
// 入力: 銘柄 (static_select) / 口座区分 (現物・信用) / 方向 (買い建て・売り建て) /
//       平均建値 (数値文字列) / 株数 (数値文字列)。株数 0 を出すと手仕舞い (routes 側で行削除)。
export const POSITION_CALLBACK_ID = "position_form";
// POS_* の block_id/action_id は positionFormView と parsePositionSubmission の対 (同一ファイル内)
// でしか突き合わせないので export 不要。routes は callback_id (POSITION_CALLBACK_ID) だけ見る。
const POS_ACCOUNT_BLOCK = "pos_account_block";
const POS_ACCOUNT_ACTION = "pos_account";
const POS_SIDE_BLOCK = "pos_side_block";
const POS_SIDE_ACTION = "pos_side";
const POS_PRICE_BLOCK = "pos_price_block";
const POS_PRICE_ACTION = "pos_price";
const POS_QTY_BLOCK = "pos_qty_block";
const POS_QTY_ACTION = "pos_qty";

// 口座区分 / 方向の選択肢 (value はそのまま positions テーブルに入る正規値)。
const ACCOUNT_OPTIONS = [
	{ text: "現物", value: "cash" },
	{ text: "信用", value: "margin" },
];
const SIDE_OPTIONS = [
	{ text: "買い建て (long)", value: "long" },
	{ text: "売り建て (short)", value: "short" },
];

function selectInput(
	blockId: string,
	actionId: string,
	label: string,
	options: { text: string; value: string }[],
) {
	return {
		type: "input",
		block_id: blockId,
		label: { type: "plain_text", text: label },
		element: {
			type: "static_select",
			action_id: actionId,
			placeholder: { type: "plain_text", text: label },
			initial_option: {
				text: { type: "plain_text", text: options[0].text },
				value: options[0].value,
			},
			options: options.map((o) => ({
				text: { type: "plain_text", text: o.text },
				value: o.value,
			})),
		},
	};
}

function plainTextInput(blockId: string, actionId: string, label: string) {
	return {
		type: "input",
		block_id: blockId,
		label: { type: "plain_text", text: label },
		element: {
			type: "plain_text_input",
			action_id: actionId,
			placeholder: { type: "plain_text", text: label },
		},
	};
}

// /position の入力 modal。銘柄ピッカー (pickerView) と同じ static_select を流用し、口座/方向/
// 建値/株数を足す。Submit を押すと view_submission が /slack/interact に飛び、保存後に clear で閉じる。
export function positionFormView() {
	return {
		type: "modal",
		callback_id: POSITION_CALLBACK_ID,
		title: { type: "plain_text", text: "ポジション登録" },
		submit: { type: "plain_text", text: "保存" },
		close: { type: "plain_text", text: "閉じる" },
		blocks: [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "保有ポジションを登録します (現物/信用ごとに平均建値で1件)。株数 0 で手仕舞い。",
				},
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
			selectInput(
				POS_ACCOUNT_BLOCK,
				POS_ACCOUNT_ACTION,
				"口座",
				ACCOUNT_OPTIONS,
			),
			selectInput(POS_SIDE_BLOCK, POS_SIDE_ACTION, "方向", SIDE_OPTIONS),
			plainTextInput(POS_PRICE_BLOCK, POS_PRICE_ACTION, "平均建値 (円)"),
			plainTextInput(POS_QTY_BLOCK, POS_QTY_ACTION, "株数"),
		],
	};
}

// ── /profile : ユーザーの好み・特記事項 登録 modal ───────────────────────────
// /position と同系統 (modal を開いて D1 保存)。玉の持ち方・リスク許容度を登録し、slack-reply が
// 本人の返信に効かせる。callback_id でこちらの submission だと判別する。
// 入力: リスク許容度 (select) / 保有スタイル (select) / 最大ポジション率% (数値、任意) /
//       特記事項メモ (複数行テキスト、任意)。select は「指定なし」も選べる (全項目空 → 行削除)。
export const PROFILE_CALLBACK_ID = "profile_form";
// userId 欠落時のエラーをどこかの入力欄に出すため、先頭ブロックだけ routes に公開する。
export const PROF_RISK_BLOCK = "prof_risk_block";
const PROF_RISK_ACTION = "prof_risk";
const PROF_STYLE_BLOCK = "prof_style_block";
const PROF_STYLE_ACTION = "prof_style";
const PROF_MAXPCT_BLOCK = "prof_maxpct_block";
const PROF_MAXPCT_ACTION = "prof_maxpct";
const PROF_NOTE_BLOCK = "prof_note_block";
const PROF_NOTE_ACTION = "prof_note";

// select の選択肢。先頭の「指定なし」(value="") を初期値にして、未設定を表せるようにする。
const RISK_OPTIONS = [
	{ text: "指定なし", value: "" },
	{ text: "低 (慎重)", value: "low" },
	{ text: "中", value: "mid" },
	{ text: "高 (積極)", value: "high" },
];
const STYLE_OPTIONS = [
	{ text: "指定なし", value: "" },
	{ text: "スイング", value: "swing" },
	{ text: "デイトレ", value: "day" },
	{ text: "中長期", value: "mid_long" },
];

// 任意入力なので optional: true を付ける (Slack が空を許容する)。
function optionalSelectInput(
	blockId: string,
	actionId: string,
	label: string,
	options: { text: string; value: string }[],
) {
	return {
		type: "input",
		optional: true,
		block_id: blockId,
		label: { type: "plain_text", text: label },
		element: {
			type: "static_select",
			action_id: actionId,
			placeholder: { type: "plain_text", text: label },
			initial_option: {
				text: { type: "plain_text", text: options[0].text },
				value: options[0].value,
			},
			options: options.map((o) => ({
				text: { type: "plain_text", text: o.text },
				value: o.value,
			})),
		},
	};
}

function optionalTextInput(
	blockId: string,
	actionId: string,
	label: string,
	multiline: boolean,
) {
	return {
		type: "input",
		optional: true,
		block_id: blockId,
		label: { type: "plain_text", text: label },
		element: {
			type: "plain_text_input",
			action_id: actionId,
			multiline,
			placeholder: { type: "plain_text", text: label },
		},
	};
}

// /profile の入力 modal。全項目任意。Submit を押すと view_submission が /slack/interact に飛び、
// 保存 (全項目空なら削除) 後に clear で閉じる。
export function profileFormView() {
	return {
		type: "modal",
		callback_id: PROFILE_CALLBACK_ID,
		title: { type: "plain_text", text: "好み・特記事項" },
		submit: { type: "plain_text", text: "保存" },
		close: { type: "plain_text", text: "閉じる" },
		blocks: [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "売買スタイルの好みを登録します (スレッド返信で考慮されます)。全項目を空にすると登録を解除します。",
				},
			},
			optionalSelectInput(
				PROF_RISK_BLOCK,
				PROF_RISK_ACTION,
				"リスク許容度",
				RISK_OPTIONS,
			),
			optionalSelectInput(
				PROF_STYLE_BLOCK,
				PROF_STYLE_ACTION,
				"保有スタイル (玉の持ち方)",
				STYLE_OPTIONS,
			),
			optionalTextInput(
				PROF_MAXPCT_BLOCK,
				PROF_MAXPCT_ACTION,
				"1銘柄あたり最大ポジション率 (%)",
				false,
			),
			optionalTextInput(
				PROF_NOTE_BLOCK,
				PROF_NOTE_ACTION,
				"特記事項 (例: 玉は分割で建てる / 決算跨ぎは持たない)",
				true,
			),
		],
	};
}

// view_submission の state から /profile 入力を取り出して検証する純粋関数。
// 全項目任意。select の「指定なし」(value="") と空文字は null に正規化する。
// 最大ポジション率だけ「入力があれば 0<x<=100 の数値」を検証する。
// 戻り値: 成功は {ok:true, ...正規値 (未指定は null)}、失敗は {ok:false, errors}。
type ProfileInput = {
	riskTolerance: string | null;
	holdStyle: string | null;
	maxPositionPct: number | null;
	note: string | null;
};
export type ProfileParse =
	| { ok: true; value: ProfileInput }
	| { ok: false; errors: Record<string, string> };

export function parseProfileSubmission(
	state:
		| Record<
				string,
				Record<string, { value?: string; selected_option?: { value?: string } }>
		  >
		| undefined,
): ProfileParse {
	const errors: Record<string, string> = {};
	const v = state ?? {};

	// select: 「指定なし」(value="") / 未選択は null。既知値以外も null に倒す (防御)。
	const riskRaw =
		v[PROF_RISK_BLOCK]?.[PROF_RISK_ACTION]?.selected_option?.value ?? "";
	const riskTolerance =
		riskRaw === "low" || riskRaw === "mid" || riskRaw === "high"
			? riskRaw
			: null;

	const styleRaw =
		v[PROF_STYLE_BLOCK]?.[PROF_STYLE_ACTION]?.selected_option?.value ?? "";
	const holdStyle =
		styleRaw === "swing" || styleRaw === "day" || styleRaw === "mid_long"
			? styleRaw
			: null;

	// 最大ポジション率: 空なら null。入力があれば 0 より大きく 100 以下の数値。
	const pctRaw = (
		v[PROF_MAXPCT_BLOCK]?.[PROF_MAXPCT_ACTION]?.value ?? ""
	).replace(/[,\s%]/g, "");
	let maxPositionPct: number | null = null;
	if (pctRaw !== "") {
		const n = Number(pctRaw);
		if (!Number.isFinite(n) || n <= 0 || n > 100)
			errors[PROF_MAXPCT_BLOCK] =
				"最大ポジション率は 0 より大きく 100 以下の数値で入力してください (空欄可)。";
		else maxPositionPct = n;
	}

	// 特記事項: 空なら null。前後空白を落とす。
	const noteRaw = (v[PROF_NOTE_BLOCK]?.[PROF_NOTE_ACTION]?.value ?? "").trim();
	const note = noteRaw === "" ? null : noteRaw;

	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: { riskTolerance, holdStyle, maxPositionPct, note },
	};
}

// view_submission の state から /position 入力を取り出して検証する純粋関数。
// 数値文字列のパース・範囲チェックをここに集約し、routes は保存と応答に専念する。
// 戻り値: 成功は {ok:true, ...正規値}、失敗は {ok:false, errors} (block_id→メッセージ)。
type PositionInput = {
	ticker: string;
	account: string;
	side: string;
	avgPrice: number;
	qty: number;
};
export type PositionParse =
	| { ok: true; value: PositionInput }
	| { ok: false; errors: Record<string, string> };

export function parsePositionSubmission(
	state:
		| Record<
				string,
				Record<
					string,
					{
						value?: string;
						selected_option?: { value?: string };
					}
				>
		  >
		| undefined,
	knownTickers: readonly string[],
): PositionParse {
	const errors: Record<string, string> = {};
	const v = state ?? {};

	const ticker = v[BLOCK_ID]?.[ACTION_ID]?.selected_option?.value ?? "";
	if (!knownTickers.includes(ticker))
		errors[BLOCK_ID] = "銘柄を選んでください。";

	const account =
		v[POS_ACCOUNT_BLOCK]?.[POS_ACCOUNT_ACTION]?.selected_option?.value ?? "";
	if (account !== "cash" && account !== "margin")
		errors[POS_ACCOUNT_BLOCK] = "口座を選んでください。";

	const side =
		v[POS_SIDE_BLOCK]?.[POS_SIDE_ACTION]?.selected_option?.value ?? "";
	if (side !== "long" && side !== "short")
		errors[POS_SIDE_BLOCK] = "方向を選んでください。";

	// 建値: 正の数のみ。カンマ・空白は除去して受ける。
	const priceRaw = (
		v[POS_PRICE_BLOCK]?.[POS_PRICE_ACTION]?.value ?? ""
	).replace(/[,\s]/g, "");
	const avgPrice = Number(priceRaw);
	if (!priceRaw || !Number.isFinite(avgPrice) || avgPrice <= 0)
		errors[POS_PRICE_BLOCK] = "平均建値は正の数で入力してください。";

	// 株数: 0 以上の整数。0 は手仕舞い (routes 側で行削除)。
	const qtyRaw = (v[POS_QTY_BLOCK]?.[POS_QTY_ACTION]?.value ?? "").replace(
		/[,\s]/g,
		"",
	);
	const qty = Number(qtyRaw);
	if (qtyRaw === "" || !Number.isInteger(qty) || qty < 0)
		errors[POS_QTY_BLOCK] =
			"株数は 0 以上の整数で入力してください (0 で手仕舞い)。";

	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return { ok: true, value: { ticker, account, side, avgPrice, qty } };
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

	describe("parseProfileSubmission", () => {
		const sel = (value: string) => ({ selected_option: { value } });
		const txt = (value: string) => ({ value });

		it("全項目を正規値で取り出す", () => {
			const r = parseProfileSubmission({
				prof_risk_block: { prof_risk: sel("high") },
				prof_style_block: { prof_style: sel("swing") },
				prof_maxpct_block: { prof_maxpct: txt("20") },
				prof_note_block: { prof_note: txt("玉は分割で建てる") },
			});
			expect(r).toEqual({
				ok: true,
				value: {
					riskTolerance: "high",
					holdStyle: "swing",
					maxPositionPct: 20,
					note: "玉は分割で建てる",
				},
			});
		});

		it("指定なし (空 value) / 空欄は null に倒す", () => {
			const r = parseProfileSubmission({
				prof_risk_block: { prof_risk: sel("") },
				prof_style_block: { prof_style: sel("") },
				prof_maxpct_block: { prof_maxpct: txt("") },
				prof_note_block: { prof_note: txt("   ") },
			});
			expect(r).toEqual({
				ok: true,
				value: {
					riskTolerance: null,
					holdStyle: null,
					maxPositionPct: null,
					note: null,
				},
			});
		});

		it("state 自体が空でも全 null で成功する", () => {
			expect(parseProfileSubmission(undefined)).toEqual({
				ok: true,
				value: {
					riskTolerance: null,
					holdStyle: null,
					maxPositionPct: null,
					note: null,
				},
			});
		});

		it("未知の select 値は null に倒す (防御)", () => {
			const r = parseProfileSubmission({
				prof_risk_block: { prof_risk: sel("extreme") },
			});
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.value.riskTolerance).toBeNull();
		});

		it("% 記号・カンマ付きの率も受ける", () => {
			const r = parseProfileSubmission({
				prof_maxpct_block: { prof_maxpct: txt("12.5%") },
			});
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.value.maxPositionPct).toBe(12.5);
		});

		it("範囲外の率はエラー (0 以下 / 100 超)", () => {
			const lo = parseProfileSubmission({
				prof_maxpct_block: { prof_maxpct: txt("0") },
			});
			expect(lo.ok).toBe(false);
			const hi = parseProfileSubmission({
				prof_maxpct_block: { prof_maxpct: txt("150") },
			});
			expect(hi.ok).toBe(false);
		});

		it("数値でない率はエラー", () => {
			const r = parseProfileSubmission({
				prof_maxpct_block: { prof_maxpct: txt("たくさん") },
			});
			expect(r.ok).toBe(false);
		});
	});
}
