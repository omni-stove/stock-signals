// Cloudflare Worker: Slack スラッシュコマンド (/crash, /brief) の受け口。
//
// 経路: Slack で `/crash` または `/brief` → POST /slack/command (このルート)。
//   - 引数あり (`/crash 285A`)         → その銘柄で即 repository_dispatch (該当 event_type)。
//   - 引数なし / 未知コード (`/crash`) → views.open で銘柄ピッカー modal を開く。modal 内の
//       銘柄ボタンを押すと block_actions が POST /slack/interact に届き、そこで dispatch +
//       views.update で結果文へ差し替える (Submit ボタンは持たず、押した瞬間に発火する)。
//       ボタン平置きはスマホ最適化 (プルダウンの段数・スクロール探しを無くす)。
//   コマンドの違い (どの解析を撃つか / 文言 / ピッカーの value 接頭辞) は COMMANDS で持つ。
//   /crash → crash-scenario (暴落プリモーテム)、/brief → ticker-brief (材料ブリーフ)。
//
// 認証: Bearer (SYNC_TOKEN) は Slack が付けられないので使わない。なりすまし防止は
//   Slack 署名検証 (verifySlackSignature) のみ。そのため index.ts では /slack/* を
//   auth ミドルウェアより前に登録する (/health と同じ扱い)。SLACK_SIGNING_SECRET 未設定なら
//   検証不能なので 503 を返し、口を開けない。
//
// dispatch 実体は GitHub Actions の各ワークフロー (repository_dispatch: <event_type>)。
// このルートは「起動するだけ」で、解析本文は skill が Slack に投稿する。

import { and, desc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { type ContextSection, sectionsToBlocks } from "../lib/context-format";
import { db } from "../lib/db";
import type { Env } from "../lib/env";
import { dispatchEvent, dispatchEventPayload } from "../lib/github-dispatch";
import { applyTrade } from "../lib/positions";
import type { ProfileRow } from "../lib/profile";
import {
	contexts,
	daily,
	positions,
	prices,
	slackThreads,
	userProfiles,
} from "../lib/schema";
import { addReaction, openView, postMessage } from "../lib/slack";
import {
	ACTION_ID,
	BLOCK_ID,
	buildMeText,
	COMMANDS,
	CONTEXT_CMD,
	CONTEXT_PICK,
	type Command,
	ephemeral,
	type MePosition,
	PORT_ROWS_BLOCK,
	PORTFOLIO_CALLBACK_ID,
	POSITION_CALLBACK_ID,
	PROF_RISK_BLOCK,
	PROFILE_CALLBACK_ID,
	parsePortfolioSubmission,
	parsePositionSubmission,
	parseProfileSubmission,
	parseTradeSubmission,
	pickerView,
	portfolioFormView,
	positionFormView,
	profileFormView,
	type SlackEventEnvelope,
	shouldHandleReply,
	TRADE_ACTION_BLOCK,
	TRADE_CALLBACK_ID,
	tradeFormView,
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

// /context : その銘柄の living context 本文を D1 から引いて SLACK_CONTEXT_CHANNEL へ全文投稿する
// (dispatch せず Worker 内で完結)。本人へは ephemeral 文言を返す。command/interact 双方から使う。
//   - SLACK_CONTEXT_CHANNEL 未設定 → 投稿先が無い旨を返す。
//   - 行が無い / body 空      → まだコンテキストが無い旨を返す。
//   - 投稿失敗               → 失敗の旨を返す。
async function fireContext(env: Env, ticker: string): Promise<string> {
	const channel = env.SLACK_CONTEXT_CHANNEL;
	if (!channel)
		return `${ticker} の context 投稿先が未設定です (SLACK_CONTEXT_CHANNEL を設定してください)。`;

	const row =
		(await db(env.DB)
			.select({
				body: contexts.body,
				sections: contexts.sections,
				updatedAt: contexts.updatedAt,
			})
			.from(contexts)
			.where(eq(contexts.ticker, ticker))
			.get()) ?? null;
	if (!row?.body)
		return `${ticker} の living context はまだありません (IR/ニュース取得で生成されます)。`;

	// sections があれば update 通知と同じ blocks で投稿し、見え方を揃える。
	// 旧データ (sections null) は素テキスト body にフォールバック。
	const parsed = row.sections
		? (JSON.parse(row.sections) as {
				title: string;
				sections: ContextSection[];
			})
		: null;
	const posted = parsed
		? await postMessage(env, {
				channel,
				...sectionsToBlocks(parsed.title, parsed.sections),
			})
		: await postMessage(env, {
				channel,
				text: `:page_facing_up: *${ticker}* の living context (更新 ${row.updatedAt})\n\n${row.body}`,
			});
	return posted
		? `📄 ${ticker} の living context を context チャンネルへ流しました。`
		: `${ticker} の context 投稿に失敗しました (SLACK_BOT_TOKEN / chat:write を確認してください)。`;
}

// /mystatus : 本人 (userId) の登録済みプロフィール + 全保有建玉を引いて確認テキストを組む。
// dispatch せず Worker 内で完結し、結果は本人にだけ ephemeral で返す (登録系の /position /profile の
// 読み取り対になる)。各建玉の参照現値は thread-context と同じく prices(live) → daily close の順。
async function fireMe(env: Env, userId: string): Promise<string> {
	const drizzle = db(env.DB);

	const profileRow =
		((await drizzle
			.select({
				riskTolerance: userProfiles.riskTolerance,
				holdStyle: userProfiles.holdStyle,
				maxPositionPct: userProfiles.maxPositionPct,
				cashBalance: userProfiles.cashBalance,
				note: userProfiles.note,
			})
			.from(userProfiles)
			.where(eq(userProfiles.userId, userId))
			.get()) as ProfileRow | undefined) ?? null;

	const posRows = await drizzle
		.select({
			ticker: positions.ticker,
			account: positions.account,
			side: positions.side,
			avgPrice: positions.avgPrice,
			qty: positions.qty,
		})
		.from(positions)
		.where(eq(positions.userId, userId))
		.all();

	// 各建玉の参照現値を銘柄ごとに引く (prices live → daily close → null)。
	const mePositions: MePosition[] = [];
	for (const r of posRows) {
		const live = await drizzle
			.select({ price: prices.price })
			.from(prices)
			.where(eq(prices.ticker, r.ticker))
			.orderBy(desc(prices.fetchedAt))
			.limit(1)
			.get();
		let price = live?.price ?? null;
		if (price == null) {
			const close = await drizzle
				.select({ close: daily.close })
				.from(daily)
				.where(eq(daily.ticker, r.ticker))
				.orderBy(desc(daily.date))
				.limit(1)
				.get();
			price = close?.close ?? null;
		}
		mePositions.push({ ...r, price });
	}

	return buildMeText(profileRow, mePositions);
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

// POST /slack/command : スラッシュコマンド (/crash, /brief, /context, /position, /profile, /mystatus) の受け口。
// form.command (例 "/crash") の先頭 / を外して分岐する。/crash /brief は COMMANDS を引いて
// 解析を dispatch する。/context は D1 の living context を context チャンネルへ流す (dispatch しない別系統)。
// /position /profile は dispatch ではなく登録 modal を開く (別系統)。/mystatus は登録済みの profile/建玉を
// 本人に ephemeral で確認表示する読み取り専用 (dispatch も modal も無い)。
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

	// /portfolio は全建玉 + 現金を 1 つのテキストエリアに prefill した一括編集 modal を開く。
	// 現在の建玉・現金を D1 から引いて initial_value に載せ、view_submission は /slack/interact が
	// PORTFOLIO_CALLBACK_ID で判別し、本人の positions を全置換 + 現金を反映する。
	if (cmdKey === "portfolio") {
		const userId = form.get("user_id") ?? "";
		if (!userId) return ephemeral("ユーザー情報を取得できませんでした。");
		const drizzle = db(c.env.DB);
		const posRows = await drizzle
			.select({
				ticker: positions.ticker,
				account: positions.account,
				side: positions.side,
				avgPrice: positions.avgPrice,
				qty: positions.qty,
			})
			.from(positions)
			.where(eq(positions.userId, userId))
			.all();
		const prof = await drizzle
			.select({ cashBalance: userProfiles.cashBalance })
			.from(userProfiles)
			.where(eq(userProfiles.userId, userId))
			.get();
		// prefill は現値を使わないので price: null で MePosition 化する。
		const mePositions: MePosition[] = posRows.map((r) => ({
			...r,
			price: null,
		}));
		const triggerId = form.get("trigger_id") ?? "";
		const opened = await openView(c.env, {
			trigger_id: triggerId,
			view: portfolioFormView(mePositions, prof?.cashBalance ?? null),
		});
		if (!opened)
			return ephemeral(
				"ポートフォリオ編集フォームを開けませんでした (SLACK_BOT_TOKEN / commands スコープを確認してください)。",
			);
		return c.body(null, 200);
	}

	// /trade は約定 (買い増し / 部分決済) を既存建玉に反映する modal を開く。view_submission は
	// /slack/interact が TRADE_CALLBACK_ID で判別し、applyTrade で建玉を再計算して D1 へ保存する。
	if (cmdKey === "trade") {
		const triggerId = form.get("trigger_id") ?? "";
		const opened = await openView(c.env, {
			trigger_id: triggerId,
			view: tradeFormView(),
		});
		if (!opened)
			return ephemeral(
				"約定反映フォームを開けませんでした (SLACK_BOT_TOKEN / commands スコープを確認してください)。",
			);
		return c.body(null, 200);
	}

	// /profile は好み・特記事項の登録 modal を開く (dispatch しない別系統)。view_submission は
	// /slack/interact が PROFILE_CALLBACK_ID で判別して D1 へ保存する。
	if (cmdKey === "profile") {
		const triggerId = form.get("trigger_id") ?? "";
		const opened = await openView(c.env, {
			trigger_id: triggerId,
			view: profileFormView(),
		});
		if (!opened)
			return ephemeral(
				"好み登録フォームを開けませんでした (SLACK_BOT_TOKEN / commands スコープを確認してください)。",
			);
		return c.body(null, 200);
	}

	// /mystatus は dispatch も modal も挟まず、本人の登録済みプロフィール + 全建玉を引いて ephemeral で
	// 返す読み取り専用コマンド (/position /profile の確認対)。user_id は form に必ず載る。
	if (cmdKey === "mystatus") {
		const userId = form.get("user_id") ?? "";
		if (!userId) return ephemeral("ユーザー情報を取得できませんでした。");
		return ephemeral(await fireMe(c.env, userId));
	}

	// /context は dispatch せず Worker 内で D1 から本文を引いて context チャンネルへ流す別系統。
	// 引数が有効な銘柄なら即取得、それ以外は銘柄ピッカー modal を開く (callback_id に context を埋める)。
	if (cmdKey === CONTEXT_CMD) {
		const arg = (form.get("text") ?? "").trim().toUpperCase();
		if (WATCHLIST.includes(arg))
			return ephemeral(await fireContext(c.env, arg));
		const triggerId = form.get("trigger_id") ?? "";
		const headline =
			arg && !WATCHLIST.includes(arg)
				? `未対応の銘柄コード: ${arg}。下から選んでください。`
				: CONTEXT_PICK;
		const opened = await openView(c.env, {
			trigger_id: triggerId,
			view: pickerView(CONTEXT_CMD, headline),
		});
		if (!opened)
			return ephemeral(
				"銘柄ピッカーを開けませんでした (SLACK_BOT_TOKEN / commands スコープを確認してください)。",
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
// 解析結果 (ticker-brief / crash-scenario) の投稿にスレッド返信されたら、その投稿の ts で
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

	// /portfolio の一括編集 submission。本人の positions を全削除してからパース行を一括 insert し、
	// 現金 (入力があれば) を user_profiles.cash_balance に反映する (他プロフィール項目は保持)。
	// テキストが空 → rows:[] なら全削除のみ (全建玉手仕舞い)。DM で置換後の建玉数を本人に通知する。
	if (payload.view?.callback_id === PORTFOLIO_CALLBACK_ID) {
		const userId = payload.user?.id ?? "";
		const parsed = parsePortfolioSubmission(
			payload.view?.state?.values,
			WATCHLIST,
		);
		if (!parsed.ok)
			return c.json({ response_action: "errors", errors: parsed.errors });
		if (!userId)
			return c.json({
				response_action: "errors",
				errors: { [PORT_ROWS_BLOCK]: "ユーザー情報を取得できませんでした。" },
			});
		const { cashBalance, rows } = parsed.value;
		const drizzle = db(c.env.DB);
		const now = new Date().toISOString();

		// 本人の全建玉を置換: 削除 → 1 行 1 insert (D1 のバインド変数上限を避け timeseries と同流儀)
		// → 現金反映。D1 の batch で 1 往復・原子的にまとめ、途中失敗で建玉が消えたまま残らないようにする。
		const ops = [
			drizzle.delete(positions).where(eq(positions.userId, userId)),
			...rows.map((r) =>
				drizzle.insert(positions).values({
					userId,
					ticker: r.ticker,
					account: r.account,
					side: r.side,
					avgPrice: r.avgPrice,
					qty: r.qty,
					updatedAt: now,
				}),
			),
			// 現金は入力があるときだけ反映 (空欄は据え置き)。他プロフィール項目は set しない。
			...(cashBalance != null
				? [
						drizzle
							.insert(userProfiles)
							.values({ userId, cashBalance, updatedAt: now })
							.onConflictDoUpdate({
								target: [userProfiles.userId],
								set: { cashBalance, updatedAt: now },
							}),
					]
				: []),
		];
		// ops は先頭に delete が必ず入るので非空 (batch は [first, ...rest] を要求する)。
		await drizzle.batch(
			ops as [(typeof ops)[number], ...(typeof ops)[number][]],
		);

		// 置換結果を本人に DM 通知 (view_submission の応答に本文は載せられないため)。
		const summary =
			rows.length === 0
				? "全建玉を手仕舞いしました (登録 0 件)"
				: rows
						.map((r) => {
							const acc = r.account === "cash" ? "現物" : "信用";
							const side = r.side === "long" ? "買" : "売";
							return `• ${r.ticker} / ${acc} / ${side} — ${r.avgPrice} 円 × ${r.qty} 株`;
						})
						.join("\n");
		const cashLine =
			cashBalance != null
				? `\n投資余力: ${cashBalance.toLocaleString("en-US")} 円`
				: "";
		await postMessage(c.env, {
			channel: userId,
			text: `:white_check_mark: ポートフォリオを更新しました (${rows.length} 件)${cashLine}\n${summary}`,
		});
		return c.json({ response_action: "clear" });
	}

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
		// 登録結果を本人に DM 通知 (view_submission の応答に本文は載せられないため)。
		// channel に user_id を渡すと chat.postMessage が DM チャンネルを開いて送る。best-effort。
		const accountLabel = p.account === "cash" ? "現物" : "信用";
		const sideLabel = p.side === "long" ? "買い建て" : "売り建て";
		const posText =
			p.qty === 0
				? `:white_check_mark: ポジションを手仕舞いしました\n*${p.ticker}* / ${accountLabel}`
				: `:white_check_mark: ポジションを登録しました\n*${p.ticker}* / ${accountLabel} / ${sideLabel}\n平均建値 ${p.avgPrice} 円 × ${p.qty} 株`;
		await postMessage(c.env, { channel: userId, text: posText });
		return c.json({ response_action: "clear" });
	}

	// /trade の約定反映 submission。対象建玉 (userId×ticker×account) を引き、applyTrade で
	// 加重平均 (増し) / 株数減算 (減らし) を計算して保存する。0 株になれば行削除。
	// 建玉キーは /position と同じ (userId, ticker, account) で side は含めない (両建て非対応)。
	if (payload.view?.callback_id === TRADE_CALLBACK_ID) {
		const userId = payload.user?.id ?? "";
		const parsed = parseTradeSubmission(payload.view?.state?.values, WATCHLIST);
		if (!parsed.ok)
			return c.json({ response_action: "errors", errors: parsed.errors });
		if (!userId)
			return c.json({
				response_action: "errors",
				errors: { [BLOCK_ID]: "ユーザー情報を取得できませんでした。" },
			});
		const t = parsed.value;
		const drizzle = db(c.env.DB);
		// 対象建玉 (現値ではなく登録済みの建値・株数) を引く。無ければ null (増しは新規建玉)。
		const cur =
			(await drizzle
				.select({ avgPrice: positions.avgPrice, qty: positions.qty })
				.from(positions)
				.where(
					and(
						eq(positions.userId, userId),
						eq(positions.ticker, t.ticker),
						eq(positions.account, t.account),
					),
				)
				.get()) ?? null;

		const result = applyTrade(cur, t.action, t.execPrice, t.execQty);
		if (!result.ok) {
			// 約定種別ブロックにエラーを出す (減らす建玉が無い / 保有超過)。
			const msg =
				result.reason === "no_position"
					? "減らせる建玉がありません。先に /position か買い増しで建ててください。"
					: result.reason === "over_reduce"
						? "保有株数を超えて減らせません。約定株数を見直してください。"
						: "約定の入力が不正です。";
			return c.json({
				response_action: "errors",
				errors: { [TRADE_ACTION_BLOCK]: msg },
			});
		}

		const accountLabel = t.account === "cash" ? "現物" : "信用";
		const sideLabel = t.side === "long" ? "買い建て" : "売り建て";
		const actionLabel = t.action === "add" ? "買い増し" : "部分決済";
		let tradeText: string;
		if (result.qty === 0) {
			await drizzle
				.delete(positions)
				.where(
					and(
						eq(positions.userId, userId),
						eq(positions.ticker, t.ticker),
						eq(positions.account, t.account),
					),
				);
			tradeText = `:white_check_mark: ${actionLabel}で手仕舞いしました\n*${t.ticker}* / ${accountLabel}\n約定 ${t.execPrice} 円 × ${t.execQty} 株`;
		} else {
			const now = new Date().toISOString();
			await drizzle
				.insert(positions)
				.values({
					userId,
					ticker: t.ticker,
					account: t.account,
					side: t.side,
					avgPrice: result.avgPrice,
					qty: result.qty,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: [positions.userId, positions.ticker, positions.account],
					set: {
						side: t.side,
						avgPrice: result.avgPrice,
						qty: result.qty,
						updatedAt: now,
					},
				});
			tradeText = `:white_check_mark: ${actionLabel}を反映しました\n*${t.ticker}* / ${accountLabel} / ${sideLabel}\n約定 ${t.execPrice} 円 × ${t.execQty} 株 → 平均建値 ${result.avgPrice} 円 × ${result.qty} 株`;
		}
		await postMessage(c.env, { channel: userId, text: tradeText });
		return c.json({ response_action: "clear" });
	}

	// /profile の登録フォーム submission。全項目任意で upsert する。全項目空 (全 null) は
	// プロフィール解除として行を削除する。clear で modal を閉じる (position と同様、本文は返せない)。
	if (payload.view?.callback_id === PROFILE_CALLBACK_ID) {
		// プロフィールは Slack ユーザー単位。view_submission payload には Slack が必ず user.id を載せる。
		const userId = payload.user?.id ?? "";
		const parsed = parseProfileSubmission(payload.view?.state?.values);
		if (!parsed.ok)
			return c.json({ response_action: "errors", errors: parsed.errors });
		if (!userId)
			return c.json({
				response_action: "errors",
				errors: { [PROF_RISK_BLOCK]: "ユーザー情報を取得できませんでした。" },
			});
		const p = parsed.value;
		const drizzle = db(c.env.DB);
		const allEmpty =
			p.riskTolerance == null &&
			p.holdStyle == null &&
			p.maxPositionPct == null &&
			p.cashBalance == null &&
			p.note == null;
		if (allEmpty) {
			await drizzle.delete(userProfiles).where(eq(userProfiles.userId, userId));
		} else {
			const now = new Date().toISOString();
			await drizzle
				.insert(userProfiles)
				.values({
					userId,
					riskTolerance: p.riskTolerance,
					holdStyle: p.holdStyle,
					maxPositionPct: p.maxPositionPct,
					cashBalance: p.cashBalance,
					note: p.note,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: [userProfiles.userId],
					set: {
						riskTolerance: p.riskTolerance,
						holdStyle: p.holdStyle,
						maxPositionPct: p.maxPositionPct,
						cashBalance: p.cashBalance,
						note: p.note,
						updatedAt: now,
					},
				});
		}
		// 登録結果を本人に DM 通知 (position と同様、view_submission の応答に本文は載せられないため)。
		let profText: string;
		if (allEmpty) {
			profText = ":white_check_mark: 好み・特記事項の登録を解除しました";
		} else {
			const riskLabel =
				p.riskTolerance == null
					? "指定なし"
					: { low: "低 (慎重)", mid: "中", high: "高 (積極)" }[p.riskTolerance];
			const styleLabel =
				p.holdStyle == null
					? "指定なし"
					: { swing: "スイング", day: "デイトレ", mid_long: "中長期" }[
							p.holdStyle
						];
			const lines = [
				":white_check_mark: 好み・特記事項を登録しました",
				`リスク許容度: ${riskLabel}`,
				`保有スタイル: ${styleLabel}`,
				`最大ポジション率: ${p.maxPositionPct == null ? "指定なし" : `${p.maxPositionPct}%`}`,
				`投資余力 (現金残高): ${p.cashBalance == null ? "指定なし" : `${p.cashBalance.toLocaleString("en-US")} 円`}`,
			];
			if (p.note != null) lines.push(`特記事項: ${p.note}`);
			profText = lines.join("\n");
		}
		await postMessage(c.env, { channel: userId, text: profText });
		return c.json({ response_action: "clear" });
	}

	// callback_id "<PICKER_CALLBACK_ID>:<cmd>" の cmd 部だけ取り出す。
	const cmdKey = (payload.view?.callback_id ?? "").split(":")[1] ?? "";
	const ticker =
		payload.view?.state?.values?.[BLOCK_ID]?.[ACTION_ID]?.selected_option
			?.value ?? "";

	// /context は dispatch せず Worker 内で取得して context チャンネルへ流す別系統。
	// 投稿の成否に関わらず modal は clear で閉じる (結果は context チャンネルで確認する)。
	if (cmdKey === CONTEXT_CMD) {
		if (!WATCHLIST.includes(ticker))
			return c.json({
				response_action: "errors",
				errors: {
					[BLOCK_ID]: "銘柄が取得できませんでした。選び直してください。",
				},
			});
		await fireContext(c.env, ticker);
		return c.json({ response_action: "clear" });
	}

	const cmd = COMMANDS[cmdKey];

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
