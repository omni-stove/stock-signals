// Slack スラッシュコマンド (/crash, /brief) の純粋ロジック。
// ルート (routes/slack.ts) は署名検証・D1・dispatch を担い、view 組み立て・コマンド定義・
// イベント判定といった副作用のない部分はここに集約してテストを同伴させる。

import {
	computeMarginCall,
	MAINTENANCE_MIN,
	pnlAmount,
	pnlPct,
} from "./positions";
import type { ProfileRow } from "./profile";
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
	brief: {
		eventType: "ticker-brief",
		pick: "材料ブリーフを実行する銘柄を選んでください。",
		fired: (t) =>
			`📰 ${t} の材料ブリーフを起動しました。結果は数分後にこのチャンネルへ届きます。`,
		failed: (t) =>
			`${t} の起動に失敗しました (GitHub App 認証 / dispatch を確認してください)。`,
	},
};

// 銘柄選択 UI の block_id / action_id / modal callback_id 接頭辞。/slack/interact 側で突き合わせる。
// ACTION_ID / BLOCK_ID は routes の interact が view_submission 解析に使うので export する。
export const BLOCK_ID = "ticker_block";
export const ACTION_ID = "ticker_select";
// callback_id は "<PICKER_CALLBACK_ID>:<cmd>"。view_submission には元コマンドの手掛かりが
// 残らないので、どの解析 (brief/crash) を撃つかを callback_id に埋めて往復させる。
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
// どの解析 (brief/crash) を撃つかは callback_id "<PICKER_CALLBACK_ID>:<cmd>" に埋めて往復させる。
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

// ── /context : 銘柄の living context 本文を取得して context チャンネルへ投稿 ──
// /signal /crash と同じ銘柄ピッカーを使うが、dispatch ではなく Worker 内で GET /context して
// SLACK_CONTEXT_CHANNEL へ全文を流す (update 通知と同じ覗き窓に集約する)。pickerView の
// callback_id 接頭辞を COMMANDS とは別にして、interact 側で /context の submission だと判別する。
export const CONTEXT_CMD = "context";
export const CONTEXT_PICK =
	"living context を取得する銘柄を選んでください (結果は context チャンネルに流れます)。";

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

// ── /trade : 約定 (買い増し / 部分決済) を既存建玉に反映 ──────────────────────
// /position が「平均建値を直接上書き」なのに対し、/trade は「約定 1 回」を入力し、既存建玉に
// 加重平均で反映する (増し=平均建値を再計算して株数加算 / 減らし=平均建値据え置きで株数減算)。
// 計算は applyTrade (positions.ts) に集約。対象建玉は (銘柄×口座×方向) で /position と同じキー。
export const TRADE_CALLBACK_ID = "trade_form";
// applyTrade の検証エラー (建玉が無い/超過) を表示する先として routes も参照するので export。
export const TRADE_ACTION_BLOCK = "trade_action_block";
const TRADE_ACTION_ACTION = "trade_action";
const TRADE_PRICE_BLOCK = "trade_price_block";
const TRADE_PRICE_ACTION = "trade_price";
const TRADE_QTY_BLOCK = "trade_qty_block";
const TRADE_QTY_ACTION = "trade_qty";

// 約定種別 (value は applyTrade の TradeAction とそろえる)。
const TRADE_ACTION_OPTIONS = [
	{ text: "買い増し / 増し建て (add)", value: "add" },
	{ text: "部分決済 / 減らし (reduce)", value: "reduce" },
];

// /trade の入力 modal。銘柄/口座/方向で対象建玉を指定し、約定種別・約定単価・約定株数を入れる。
export function tradeFormView() {
	return {
		type: "modal",
		callback_id: TRADE_CALLBACK_ID,
		title: { type: "plain_text", text: "約定を反映" },
		submit: { type: "plain_text", text: "反映" },
		close: { type: "plain_text", text: "閉じる" },
		blocks: [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "約定 1 回を既存建玉に反映します (増し=平均建値を再計算、減らし=平均建値据え置き)。対象が無い増しは新規建玉になります。",
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
			selectInput(
				TRADE_ACTION_BLOCK,
				TRADE_ACTION_ACTION,
				"約定種別",
				TRADE_ACTION_OPTIONS,
			),
			plainTextInput(TRADE_PRICE_BLOCK, TRADE_PRICE_ACTION, "約定単価 (円)"),
			plainTextInput(TRADE_QTY_BLOCK, TRADE_QTY_ACTION, "約定株数"),
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
const PROF_CASH_BLOCK = "prof_cash_block";
const PROF_CASH_ACTION = "prof_cash";
const PROF_NOTE_BLOCK = "prof_note_block";
const PROF_NOTE_ACTION = "prof_note";

// select の選択肢。先頭の「指定なし」(value="") を初期値にして、未設定を表せるようにする。
// Slack の static_select は option/initial_option の value に空文字を許さない
// (views.open が invalid_arguments で落ちる)。「指定なし」は sentinel 値にし、
// parseProfileSubmission のホワイトリスト判定で null に倒す。
const NONE = "__none__";
const RISK_OPTIONS = [
	{ text: "指定なし", value: NONE },
	{ text: "低 (慎重)", value: "low" },
	{ text: "中", value: "mid" },
	{ text: "高 (積極)", value: "high" },
];
const STYLE_OPTIONS = [
	{ text: "指定なし", value: NONE },
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
				PROF_CASH_BLOCK,
				PROF_CASH_ACTION,
				"投資余力 (現金残高、円)",
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

// ── /portfolio : 全建玉 + 現金を 1 つのテキストエリアで一括編集する modal ─────────────
// /position /trade は「1 銘柄 1 約定ずつ modal を開き直す」が、/portfolio は現在の全建玉を
// 1 行 1 建玉のテキストに prefill し、その本文を丸ごと書き換えて Submit 一発で置き換える
// (行を消す=手仕舞い / 値を書き換える=更新 / 行を足す=新規)。保存は「本人の positions を
// 全削除 → パースした行を一括 insert」+ 現金を user_profiles.cash_balance に反映 (routes 側)。
// テキスト 1 本にしたのは、Slack modal が可変長フォーム (行の動的追加) を扱いにくく、既存の
// 「Submit 一発・純粋関数で検証」という流儀に一番素直に乗るため。
export const PORTFOLIO_CALLBACK_ID = "portfolio_form";
const PORT_CASH_BLOCK = "port_cash_block";
const PORT_CASH_ACTION = "port_cash";
// userId 欠落エラーを出す先として routes に公開する (rows ブロックにまとめて出す)。
export const PORT_ROWS_BLOCK = "port_rows_block";
const PORT_ROWS_ACTION = "port_rows";

// 1 行の書式: "<コード> <現物|信用> <買|売> <建値> <株数>"。区切りは空白 1 個以上。
// 例: "285A 現物 買 1000 100"。prefill もこの書式で出すので、往復でぶれない。
const PORT_ACCOUNT_LABEL: Record<string, string> = {
	cash: "現物",
	margin: "信用",
};
const PORT_SIDE_LABEL: Record<string, string> = { long: "買", short: "売" };
// パース時のラベル逆引き。表示語 (現物/信用/買/売) の揺れも軽く吸収する。
const PORT_ACCOUNT_PARSE: Record<string, "cash" | "margin"> = {
	現物: "cash",
	信用: "margin",
	cash: "cash",
	margin: "margin",
};
const PORT_SIDE_PARSE: Record<string, "long" | "short"> = {
	買: "long",
	売: "short",
	買い: "long",
	売り: "short",
	long: "long",
	short: "short",
};

// /portfolio に prefill する本文を組む純粋関数。現在の全建玉を 1 行 1 建玉のテキストにする。
// 行順は表示の安定のため銘柄コード→口座でソート。建玉が無ければ空文字 (空欄からの新規入力)。
function buildPortfolioText(positions: MePosition[]): string {
	const sorted = [...positions].sort(
		(a, b) =>
			a.ticker.localeCompare(b.ticker) || a.account.localeCompare(b.account),
	);
	return sorted
		.map((p) => {
			const account = PORT_ACCOUNT_LABEL[p.account] ?? p.account;
			const side = PORT_SIDE_LABEL[p.side] ?? p.side;
			return `${p.ticker} ${account} ${side} ${p.avgPrice} ${p.qty}`;
		})
		.join("\n");
}

// /portfolio の入力 modal。現金 (任意) と全建玉テキスト (prefill) を持つ。Submit で
// view_submission が /slack/interact に飛び、PORTFOLIO_CALLBACK_ID で判別して一括保存する。
export function portfolioFormView(
	positions: MePosition[],
	cashBalance: number | null,
) {
	const help = WATCHLIST.map((code) => {
		const name = WATCHLIST_NAMES[code];
		return name ? `${code} (${name})` : code;
	}).join(" / ");
	return {
		type: "modal",
		callback_id: PORTFOLIO_CALLBACK_ID,
		title: { type: "plain_text", text: "ポートフォリオ一括編集" },
		submit: { type: "plain_text", text: "一括保存" },
		close: { type: "plain_text", text: "閉じる" },
		blocks: [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "現在の全建玉を 1 行 1 建玉で編集します。行を消すと手仕舞い、値を書き換えると更新、行を足すと新規。書式は `コード 現物|信用 買|売 建値 株数` (例 `285A 現物 買 1000 100`)。",
				},
			},
			{
				type: "input",
				optional: true,
				block_id: PORT_CASH_BLOCK,
				label: { type: "plain_text", text: "投資余力 (現金残高、円)" },
				element: {
					type: "plain_text_input",
					action_id: PORT_CASH_ACTION,
					...(cashBalance != null
						? { initial_value: String(cashBalance) }
						: {}),
					placeholder: {
						type: "plain_text",
						text: "例 400000 (空欄で据え置き)",
					},
				},
			},
			{
				type: "input",
				optional: true,
				block_id: PORT_ROWS_BLOCK,
				label: { type: "plain_text", text: "建玉 (1 行 1 建玉)" },
				element: {
					type: "plain_text_input",
					action_id: PORT_ROWS_ACTION,
					multiline: true,
					initial_value: buildPortfolioText(positions),
					placeholder: {
						type: "plain_text",
						text: "285A 現物 買 1000 100\n6976 信用 売 1200 50",
					},
				},
			},
			{
				type: "context",
				elements: [{ type: "mrkdwn", text: `対応銘柄: ${help}` }],
			},
		],
	};
}

// /portfolio の submission を検証する純粋関数。現金 (任意) と建玉行を取り出し、
// 全行を検証して正規化した建玉配列を返す。1 行でも不正なら、その行番号つきでエラー。
// 同一 (銘柄, 口座) が複数行あるのは重複としてエラー (positions の PK と衝突するため)。
// 建玉テキストが空なら positions を全削除する意図とみなす (rows: [])。
type PortfolioRow = {
	ticker: string;
	account: "cash" | "margin";
	side: "long" | "short";
	avgPrice: number;
	qty: number;
};
export type PortfolioParse =
	| {
			ok: true;
			value: { cashBalance: number | null; rows: PortfolioRow[] };
	  }
	| { ok: false; errors: Record<string, string> };

export function parsePortfolioSubmission(
	state:
		| Record<
				string,
				Record<string, { value?: string; selected_option?: { value?: string } }>
		  >
		| undefined,
	knownTickers: readonly string[],
): PortfolioParse {
	const errors: Record<string, string> = {};
	const v = state ?? {};

	// 現金: 空なら null (据え置き)。入力があれば 0 以上の数値。
	const cashRaw = (v[PORT_CASH_BLOCK]?.[PORT_CASH_ACTION]?.value ?? "").replace(
		/[,\s円]/g,
		"",
	);
	let cashBalance: number | null = null;
	if (cashRaw !== "") {
		const n = Number(cashRaw);
		if (!Number.isFinite(n) || n < 0)
			errors[PORT_CASH_BLOCK] =
				"投資余力は 0 以上の数値で入力してください (空欄で据え置き)。";
		else cashBalance = n;
	}

	// 建玉行: 空行は無視。1 行ずつ 5 トークンにパースして検証する。
	const raw = v[PORT_ROWS_BLOCK]?.[PORT_ROWS_ACTION]?.value ?? "";
	const rows: PortfolioRow[] = [];
	const rowErrors: string[] = [];
	const seen = new Set<string>(); // "<ticker>:<account>" の重複検出
	const lines = raw.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "") continue;
		const n = i + 1;
		// 全角スペースも区切りとして受ける。
		const parts = line.split(/[\s　]+/);
		if (parts.length !== 5) {
			rowErrors.push(
				`${n}行目: 「コード 口座 方向 建値 株数」の5項目で入力してください。`,
			);
			continue;
		}
		const [tickerRaw, accRaw, sideRaw, priceRaw, qtyRaw] = parts;
		const ticker = tickerRaw.toUpperCase();
		if (!knownTickers.includes(ticker)) {
			rowErrors.push(`${n}行目: 未対応の銘柄コード「${tickerRaw}」。`);
			continue;
		}
		const account = PORT_ACCOUNT_PARSE[accRaw];
		if (!account) {
			rowErrors.push(
				`${n}行目: 口座は「現物」か「信用」で入力してください (「${accRaw}」)。`,
			);
			continue;
		}
		const side = PORT_SIDE_PARSE[sideRaw];
		if (!side) {
			rowErrors.push(
				`${n}行目: 方向は「買」か「売」で入力してください (「${sideRaw}」)。`,
			);
			continue;
		}
		const avgPrice = Number(priceRaw.replace(/,/g, ""));
		if (!Number.isFinite(avgPrice) || avgPrice <= 0) {
			rowErrors.push(
				`${n}行目: 建値は正の数で入力してください (「${priceRaw}」)。`,
			);
			continue;
		}
		const qty = Number(qtyRaw.replace(/,/g, ""));
		if (!Number.isInteger(qty) || qty <= 0) {
			rowErrors.push(
				`${n}行目: 株数は 1 以上の整数で入力してください (0 は行を消して手仕舞い) (「${qtyRaw}」)。`,
			);
			continue;
		}
		const key = `${ticker}:${account}`;
		if (seen.has(key)) {
			rowErrors.push(
				`${n}行目: ${ticker} の${PORT_ACCOUNT_LABEL[account]}が重複しています (1口座1行にまとめてください)。`,
			);
			continue;
		}
		seen.add(key);
		rows.push({ ticker, account, side, avgPrice, qty });
	}
	if (rowErrors.length > 0) errors[PORT_ROWS_BLOCK] = rowErrors.join("\n");

	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return { ok: true, value: { cashBalance, rows } };
}

// ── /mystatus : 本人の好み・特記事項 + 全保有建玉を ephemeral でまとめて返す ──────────
// /position /profile は「登録」、/mystatus は登録済みの内容を本人だけに「確認表示」する読み取り専用。
// dispatch も modal も挟まず、routes が D1 から本人行を引いて buildMeText に渡し ephemeral で返す。
// ラベル (リスク許容度/口座/方向) の語彙は登録時の DM 通知 (routes/slack.ts) と揃える。

// /mystatus 表示用の建玉 1 行 (routes が select + 銘柄ごとの参照現値で組む)。
export interface MePosition {
	ticker: string;
	account: string; // cash | margin
	side: string; // long | short
	avgPrice: number;
	qty: number;
	price: number | null; // 銘柄ごとの参照現値 (live → daily close、無ければ null)
}

const RISK_LABEL: Record<string, string> = {
	low: "低 (慎重)",
	mid: "中",
	high: "高 (積極)",
};
const STYLE_LABEL: Record<string, string> = {
	swing: "スイング",
	day: "デイトレ",
	mid_long: "中長期",
};
const ACCOUNT_LABEL: Record<string, string> = { cash: "現物", margin: "信用" };
const SIDE_LABEL: Record<string, string> = {
	long: "買い建て",
	short: "売り建て",
};

// 金額を 3 桁区切りの文字列に (例 1234567 → "1,234,567")。
function yen(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

// /me の本文を組む純粋関数。profile (null=未登録) と全建玉行を Slack mrkdwn テキストにまとめる。
// 含み損益% は pnlPct を再利用 (現値無しは「現値なし」と表示)。両方空なら未登録の旨を返す。
export function buildMeText(
	profile: ProfileRow | null,
	positions: MePosition[],
): string {
	const lines: string[] = [];

	const hasProfile =
		profile != null &&
		(profile.riskTolerance != null ||
			profile.holdStyle != null ||
			profile.maxPositionPct != null ||
			profile.cashBalance != null ||
			(profile.note != null && profile.note !== ""));
	lines.push("*プロフィール*");
	if (hasProfile && profile) {
		lines.push(
			`• リスク許容度: ${profile.riskTolerance == null ? "指定なし" : (RISK_LABEL[profile.riskTolerance] ?? profile.riskTolerance)}`,
		);
		lines.push(
			`• 保有スタイル: ${profile.holdStyle == null ? "指定なし" : (STYLE_LABEL[profile.holdStyle] ?? profile.holdStyle)}`,
		);
		lines.push(
			`• 最大ポジション率: ${profile.maxPositionPct == null ? "指定なし" : `${profile.maxPositionPct}%`}`,
		);
		lines.push(
			`• 投資余力 (現金残高): ${profile.cashBalance == null ? "指定なし" : `${yen(profile.cashBalance)} 円`}`,
		);
		if (profile.note != null && profile.note !== "")
			lines.push(`• 特記事項: ${profile.note}`);
	} else {
		lines.push("• 未登録 (`/profile` で登録できます)");
	}

	lines.push("");
	lines.push("*保有ポジション*");
	if (positions.length === 0) {
		lines.push("• なし (`/position` で登録できます)");
	} else {
		for (const p of positions) {
			const name = WATCHLIST_NAMES[p.ticker];
			const head = name ? `${p.ticker} ${name}` : p.ticker;
			const account = ACCOUNT_LABEL[p.account] ?? p.account;
			const side = SIDE_LABEL[p.side] ?? p.side;
			const cost = Math.round(p.avgPrice * p.qty); // 建玉金額 (建値 × 株数)
			const pnl = pnlPct(p.side, p.avgPrice, p.price);
			const amt = pnlAmount(p.side, p.avgPrice, p.qty, p.price);
			const pnlText =
				pnl == null || amt == null
					? "現値なし"
					: `${amt >= 0 ? "+" : ""}${yen(amt)} 円 (${pnl >= 0 ? "+" : ""}${pnl}% / 現値 ${yen(p.price ?? 0)} 円)`;
			lines.push(
				`• *${head}* / ${account} / ${side} — 建値 ${yen(p.avgPrice)} 円 × ${p.qty} 株 = ${yen(cost)} 円 / 含み損益 ${pnlText}`,
			);
		}
	}

	// 追証ライン: 信用建玉があるときだけ、現物代用 + 現金 + 評価損益から委託保証金維持率を出す。
	const mc = computeMarginCall(
		positions.map((p) => ({
			ticker: p.ticker,
			account: p.account,
			side: p.side,
			avgPrice: p.avgPrice,
			qty: p.qty,
			price: p.price,
		})),
		profile?.cashBalance ?? null,
	);
	if (mc) {
		const minPct = MAINTENANCE_MIN * 100;
		lines.push("");
		lines.push("*追証ライン (信用)*");
		if (mc.maintenanceRate == null) {
			lines.push("• 建代金なし");
		} else {
			const ratePct = Math.round(mc.maintenanceRate * 1000) / 10; // 小数第1位%
			lines.push(
				`• 委託保証金維持率: ${ratePct}% (追証ライン ${minPct}%) — 委託保証金 ${yen(mc.deposit)} 円 / 建代金 ${yen(mc.marginNotional)} 円`,
			);
			if (mc.inCall) {
				lines.push(
					`• :rotating_light: 追証発生中 — 維持率が ${minPct}% を下回っています (不足 ${yen(-mc.room)} 円)`,
				);
			} else {
				lines.push(
					`• あと ${yen(mc.room)} 円の評価損で追証 (維持率 ${minPct}% 到達)`,
				);
				// 銘柄ごとに、その銘柄だけが動いたら追証に届く株価を出す (drop 小さい=近い順)。
				for (const t of mc.triggers) {
					const name = WATCHLIST_NAMES[t.ticker];
					const head = name ? `${t.ticker} ${name}` : t.ticker;
					// drop>0: 下落で追証 / drop<0: 上昇で追証 (short)。dropPct も同符号。
					const dir = t.drop >= 0 ? "下落" : "上昇";
					lines.push(
						`• ${head}: 単独なら ${yen(Math.abs(t.drop))} 円${dir} (${t.dropPct >= 0 ? "-" : "+"}${Math.abs(t.dropPct)}%) → ${yen(t.triggerPrice)} 円で追証 (現値 ${yen(t.price)} 円)`,
					);
				}
			}
			lines.push(
				`※ 現物は代用有価証券として現値×80%で算入した概算。各銘柄行は「その銘柄だけが動いた場合」で、実残高とは異なります。`,
			);
		}
	}

	return lines.join("\n");
}

// view_submission の state から /profile 入力を取り出して検証する純粋関数。
// 全項目任意。select の「指定なし」(value="") と空文字は null に正規化する。
// 最大ポジション率だけ「入力があれば 0<x<=100 の数値」を検証する。
// 戻り値: 成功は {ok:true, ...正規値 (未指定は null)}、失敗は {ok:false, errors}。
type ProfileInput = {
	riskTolerance: string | null;
	holdStyle: string | null;
	maxPositionPct: number | null;
	cashBalance: number | null;
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

	// select: 「指定なし」(sentinel) / 未選択は null。既知値以外も null に倒す (防御)。
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

	// 投資余力 (現金残高): 空なら null。入力があれば 0 以上の数値。
	const cashRaw = (v[PROF_CASH_BLOCK]?.[PROF_CASH_ACTION]?.value ?? "").replace(
		/[,\s円]/g,
		"",
	);
	let cashBalance: number | null = null;
	if (cashRaw !== "") {
		const n = Number(cashRaw);
		if (!Number.isFinite(n) || n < 0)
			errors[PROF_CASH_BLOCK] =
				"投資余力は 0 以上の数値で入力してください (空欄可)。";
		else cashBalance = n;
	}

	// 特記事項: 空なら null。前後空白を落とす。
	const noteRaw = (v[PROF_NOTE_BLOCK]?.[PROF_NOTE_ACTION]?.value ?? "").trim();
	const note = noteRaw === "" ? null : noteRaw;

	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: { riskTolerance, holdStyle, maxPositionPct, cashBalance, note },
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

// view_submission の state から /trade 入力を取り出して検証する純粋関数。
// 対象建玉キー (ticker/account/side) + 約定 (action/execPrice/execQty) を返す。
// 既存建玉との突き合わせ・加重平均は routes が applyTrade で行う (ここは入力検証のみ)。
type TradeInput = {
	ticker: string;
	account: string;
	side: string;
	action: "add" | "reduce";
	execPrice: number;
	execQty: number;
};
export type TradeParse =
	| { ok: true; value: TradeInput }
	| { ok: false; errors: Record<string, string> };

export function parseTradeSubmission(
	state:
		| Record<
				string,
				Record<string, { value?: string; selected_option?: { value?: string } }>
		  >
		| undefined,
	knownTickers: readonly string[],
): TradeParse {
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

	const actionRaw =
		v[TRADE_ACTION_BLOCK]?.[TRADE_ACTION_ACTION]?.selected_option?.value ?? "";
	if (actionRaw !== "add" && actionRaw !== "reduce")
		errors[TRADE_ACTION_BLOCK] = "約定種別を選んでください。";
	const action = actionRaw as "add" | "reduce";

	// 約定単価: 正の数のみ。
	const priceRaw = (
		v[TRADE_PRICE_BLOCK]?.[TRADE_PRICE_ACTION]?.value ?? ""
	).replace(/[,\s]/g, "");
	const execPrice = Number(priceRaw);
	if (!priceRaw || !Number.isFinite(execPrice) || execPrice <= 0)
		errors[TRADE_PRICE_BLOCK] = "約定単価は正の数で入力してください。";

	// 約定株数: 1 以上の整数 (0 は約定にならない)。
	const qtyRaw = (v[TRADE_QTY_BLOCK]?.[TRADE_QTY_ACTION]?.value ?? "").replace(
		/[,\s]/g,
		"",
	);
	const execQty = Number(qtyRaw);
	if (qtyRaw === "" || !Number.isInteger(execQty) || execQty <= 0)
		errors[TRADE_QTY_BLOCK] = "約定株数は 1 以上の整数で入力してください。";

	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: { ticker, account, side, action, execPrice, execQty },
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
		it("crash / brief を別々の event_type に対応づける", () => {
			expect(COMMANDS.crash.eventType).toBe("crash-scenario");
			expect(COMMANDS.brief.eventType).toBe("ticker-brief");
		});
	});

	describe("pickerView", () => {
		it("modal 型で見出し section と Submit を持ち、callback_id に cmd を埋める", () => {
			const view = pickerView("brief", "見出し") as {
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
			expect(view.callback_id).toBe(`${PICKER_CALLBACK_ID}:brief`);
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
				prof_cash_block: { prof_cash: txt("1,000,000") },
				prof_note_block: { prof_note: txt("玉は分割で建てる") },
			});
			expect(r).toEqual({
				ok: true,
				value: {
					riskTolerance: "high",
					holdStyle: "swing",
					maxPositionPct: 20,
					cashBalance: 1000000,
					note: "玉は分割で建てる",
				},
			});
		});

		it("指定なし (空 value) / 空欄は null に倒す", () => {
			const r = parseProfileSubmission({
				prof_risk_block: { prof_risk: sel("") },
				prof_style_block: { prof_style: sel("") },
				prof_maxpct_block: { prof_maxpct: txt("") },
				prof_cash_block: { prof_cash: txt("") },
				prof_note_block: { prof_note: txt("   ") },
			});
			expect(r).toEqual({
				ok: true,
				value: {
					riskTolerance: null,
					holdStyle: null,
					maxPositionPct: null,
					cashBalance: null,
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
					cashBalance: null,
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

		it("現金残高はカンマ・円付きを受ける", () => {
			const r = parseProfileSubmission({
				prof_cash_block: { prof_cash: txt("1,500,000円") },
			});
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.value.cashBalance).toBe(1500000);
		});

		it("現金残高 0 は受ける", () => {
			const r = parseProfileSubmission({
				prof_cash_block: { prof_cash: txt("0") },
			});
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.value.cashBalance).toBe(0);
		});

		it("負の現金残高 / 数値でない現金残高はエラー", () => {
			expect(
				parseProfileSubmission({
					prof_cash_block: { prof_cash: txt("-100") },
				}).ok,
			).toBe(false);
			expect(
				parseProfileSubmission({
					prof_cash_block: { prof_cash: txt("いっぱい") },
				}).ok,
			).toBe(false);
		});
	});

	describe("parseTradeSubmission", () => {
		const sel = (value: string) => ({ selected_option: { value } });
		const txt = (value: string) => ({ value });
		const code = WATCHLIST[0];

		it("全項目を正規値で取り出す", () => {
			const r = parseTradeSubmission(
				{
					ticker_block: { ticker_select: sel(code) },
					pos_account_block: { pos_account: sel("cash") },
					pos_side_block: { pos_side: sel("long") },
					trade_action_block: { trade_action: sel("add") },
					trade_price_block: { trade_price: txt("1,010") },
					trade_qty_block: { trade_qty: txt("100") },
				},
				WATCHLIST,
			);
			expect(r).toEqual({
				ok: true,
				value: {
					ticker: code,
					account: "cash",
					side: "long",
					action: "add",
					execPrice: 1010,
					execQty: 100,
				},
			});
		});

		it("未知の銘柄 / 不正な約定種別はエラー", () => {
			const r = parseTradeSubmission(
				{
					ticker_block: { ticker_select: sel("XXXX") },
					trade_action_block: { trade_action: sel("foo") },
				},
				WATCHLIST,
			);
			expect(r.ok).toBe(false);
			if (!r.ok) {
				expect(r.errors.ticker_block).toBeDefined();
				expect(r.errors.trade_action_block).toBeDefined();
			}
		});

		it("約定単価 0 / 約定株数 0 はエラー", () => {
			const r = parseTradeSubmission(
				{
					ticker_block: { ticker_select: sel(code) },
					pos_account_block: { pos_account: sel("cash") },
					pos_side_block: { pos_side: sel("long") },
					trade_action_block: { trade_action: sel("reduce") },
					trade_price_block: { trade_price: txt("0") },
					trade_qty_block: { trade_qty: txt("0") },
				},
				WATCHLIST,
			);
			expect(r.ok).toBe(false);
			if (!r.ok) {
				expect(r.errors.trade_price_block).toBeDefined();
				expect(r.errors.trade_qty_block).toBeDefined();
			}
		});
	});

	describe("buildPortfolioText", () => {
		const [a, b] = WATCHLIST;
		it("全建玉を 1 行 1 建玉のテキストにする (コード→口座でソート)", () => {
			const text = buildPortfolioText([
				{
					ticker: b,
					account: "margin",
					side: "short",
					avgPrice: 1200,
					qty: 50,
					price: null,
				},
				{
					ticker: a,
					account: "cash",
					side: "long",
					avgPrice: 1000,
					qty: 100,
					price: null,
				},
			]);
			// b > a なら a が先。cash が margin より前 (localeCompare)。
			const first = a.localeCompare(b) <= 0 ? a : b;
			expect(text.split("\n")[0].startsWith(first)).toBe(true);
			expect(text).toContain(`${a} 現物 買 1000 100`);
			expect(text).toContain(`${b} 信用 売 1200 50`);
		});
		it("建玉なしは空文字", () => {
			expect(buildPortfolioText([])).toBe("");
		});
	});

	describe("parsePortfolioSubmission", () => {
		const txt = (value: string) => ({ value });
		const [code, code2] = WATCHLIST;
		const call = (cash: string, rows: string) =>
			parsePortfolioSubmission(
				{
					port_cash_block: { port_cash: txt(cash) },
					port_rows_block: { port_rows: txt(rows) },
				},
				WATCHLIST,
			);

		it("現金と複数行を正規値で取り出す", () => {
			const r = call(
				"400,000円",
				`${code} 現物 買 1000 100\n${code2} 信用 売 1200 50`,
			);
			expect(r).toEqual({
				ok: true,
				value: {
					cashBalance: 400000,
					rows: [
						{
							ticker: code,
							account: "cash",
							side: "long",
							avgPrice: 1000,
							qty: 100,
						},
						{
							ticker: code2,
							account: "margin",
							side: "short",
							avgPrice: 1200,
							qty: 50,
						},
					],
				},
			});
		});

		it("空行・全角スペースを許容する", () => {
			const r = call("", `\n${code}　現物　買　1000　100\n\n`);
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(r.value.cashBalance).toBeNull();
				expect(r.value.rows).toHaveLength(1);
			}
		});

		it("建玉テキスト空は rows:[] (全削除の意図)", () => {
			const r = call("", "   \n  ");
			expect(r).toEqual({ ok: true, value: { cashBalance: null, rows: [] } });
		});

		it("現金空は据え置き (null)", () => {
			const r = call("", `${code} 現物 買 1000 100`);
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.value.cashBalance).toBeNull();
		});

		it("項目数不足・未知銘柄・不正な口座/方向/建値/株数を行番号つきで弾く", () => {
			const r = call(
				"",
				[
					`${code} 現物 買 1000`, // 4項目
					"XXXX 現物 買 1000 100", // 未知銘柄
					`${code} げん 買 1000 100`, // 口座
					`${code} 現物 かい 1000 100`, // 方向
					`${code} 現物 買 0 100`, // 建値
					`${code} 現物 買 1000 0`, // 株数
				].join("\n"),
			);
			expect(r.ok).toBe(false);
			if (!r.ok) {
				const e = r.errors.port_rows_block;
				expect(e).toContain("1行目");
				expect(e).toContain("2行目");
				expect(e).toContain("3行目");
				expect(e).toContain("4行目");
				expect(e).toContain("5行目");
				expect(e).toContain("6行目");
			}
		});

		it("同一 (銘柄, 口座) の重複行はエラー", () => {
			const r = call("", `${code} 現物 買 1000 100\n${code} 現物 買 1100 50`);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.errors.port_rows_block).toContain("重複");
		});

		it("同一銘柄でも現物と信用は別行で共存できる", () => {
			const r = call("", `${code} 現物 買 1000 100\n${code} 信用 買 1050 100`);
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.value.rows).toHaveLength(2);
		});

		it("負の現金はエラー", () => {
			const r = call("-100", "");
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.errors.port_cash_block).toBeDefined();
		});
	});

	describe("buildMeText", () => {
		const code = WATCHLIST[0];

		it("profile と建玉を金額・含み損益つきで整形する", () => {
			const out = buildMeText(
				{
					riskTolerance: "high",
					holdStyle: "swing",
					maxPositionPct: 20,
					cashBalance: 1000000,
					note: "玉は分割で建てる",
				},
				[
					{
						ticker: code,
						account: "cash",
						side: "long",
						avgPrice: 1000,
						qty: 100,
						price: 1100,
					},
				],
			);
			expect(out).toContain("リスク許容度: 高 (積極)");
			expect(out).toContain("保有スタイル: スイング");
			expect(out).toContain("最大ポジション率: 20%");
			expect(out).toContain("投資余力 (現金残高): 1,000,000 円");
			expect(out).toContain("特記事項: 玉は分割で建てる");
			expect(out).toContain("現物");
			expect(out).toContain("買い建て");
			expect(out).toContain("建値 1,000 円 × 100 株 = 100,000 円");
			expect(out).toContain("含み損益 +10,000 円 (+10% / 現値 1,100 円)");
		});

		it("profile 未登録・建玉なしは登録案内を出す", () => {
			const out = buildMeText(null, []);
			expect(out).toContain("未登録 (`/profile` で登録できます)");
			expect(out).toContain("なし (`/position` で登録できます)");
		});

		it("全フィールド空の profile も未登録扱い", () => {
			const out = buildMeText(
				{
					riskTolerance: null,
					holdStyle: null,
					maxPositionPct: null,
					cashBalance: null,
					note: null,
				},
				[],
			);
			expect(out).toContain("未登録 (`/profile` で登録できます)");
		});

		it("現金残高だけの profile も登録扱いで表示する", () => {
			const out = buildMeText(
				{
					riskTolerance: null,
					holdStyle: null,
					maxPositionPct: null,
					cashBalance: 500000,
					note: null,
				},
				[],
			);
			expect(out).toContain("投資余力 (現金残高): 500,000 円");
			expect(out).not.toContain("未登録 (`/profile` で登録できます)");
		});

		it("現値が無い建玉は含み損益を現値なしと表示する", () => {
			const out = buildMeText(null, [
				{
					ticker: code,
					account: "margin",
					side: "short",
					avgPrice: 1200,
					qty: 50,
					price: null,
				},
			]);
			expect(out).toContain("信用");
			expect(out).toContain("売り建て");
			expect(out).toContain("含み損益 現値なし");
		});

		it("含み損益マイナスは符号付きで出す", () => {
			const out = buildMeText(null, [
				{
					ticker: code,
					account: "cash",
					side: "long",
					avgPrice: 1000,
					qty: 100,
					price: 900,
				},
			]);
			expect(out).toContain("含み損益 -10,000 円 (-10% / 現値 900 円)");
		});

		it("現物だけなら追証ブロックは出ない", () => {
			const out = buildMeText(null, [
				{
					ticker: code,
					account: "cash",
					side: "long",
					avgPrice: 1000,
					qty: 100,
					price: 1100,
				},
			]);
			expect(out).not.toContain("追証ライン");
		});

		it("信用建玉があると維持率・追証余力を出す", () => {
			// 建代金 100万 (建値1000×1000株)、現金 40万、現値 1000 → 維持率 40%、余力 20万
			const out = buildMeText(
				{
					riskTolerance: null,
					holdStyle: null,
					maxPositionPct: null,
					cashBalance: 400000,
					note: null,
				},
				[
					{
						ticker: code,
						account: "margin",
						side: "long",
						avgPrice: 1000,
						qty: 1000,
						price: 1000,
					},
				],
			);
			expect(out).toContain("追証ライン (信用)");
			expect(out).toContain("委託保証金維持率: 40% (追証ライン 20%)");
			expect(out).toContain("あと 200,000 円の評価損で追証");
			// 銘柄行: room 20万 / slope 1000 = 200 円下落で追証株価 800。
			expect(out).toContain("単独なら 200 円下落 (-20%) → 800 円で追証");
		});

		it("維持率が 20% を割ると追証発生中を出す", () => {
			// 建代金 100万、現値 700 → 評価損 -30万、現金 40万 → deposit 10万、維持率 10%、不足 10万
			const out = buildMeText(
				{
					riskTolerance: null,
					holdStyle: null,
					maxPositionPct: null,
					cashBalance: 400000,
					note: null,
				},
				[
					{
						ticker: code,
						account: "margin",
						side: "long",
						avgPrice: 1000,
						qty: 1000,
						price: 700,
					},
				],
			);
			expect(out).toContain("追証発生中");
			expect(out).toContain("不足 100,000 円");
		});
	});
}
