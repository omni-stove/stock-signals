// Cloudflare Worker: slack-reply に渡すスレッド文脈を 1 call で返すバンドルエンドポイント。
//
//   GET /thread-context?channel=C123&thread_ts=1700000000.000100&kind=ticker-brief&text=<ユーザー返信>
//
// conversations.replies を Worker から取得し整形する。
//
// 出力:
//   { channel, thread_ts, kind, replies: [{ user, text, ts }, ...], positions: {...}, profile: {...} }
// replies は親 + 全返信を ts 昇順で。conversations.replies が失敗 (ok:false / トークン未設定) しても
// channel/thread_ts/kind は query から必ず埋め、replies は空配列でフォールバックする。
// text (= client_payload のユーザー返信本文) が履歴に未反映なら末尾に user メッセージとして足す
// (Slack のイベント反映遅延で最新の問いが replies に来ていないケースの保険)。
//
// positions: ユーザーが /position で登録した保有建玉。ticker-brief / crash-scenario は汎用解析の
// まま据え置き、ポジション考慮は slack-reply だけが行うため、judge-context ではなくここに乗せる。
// 参照現値は prices の live があればそれ、無ければ daily 最新 close を使い、各行の含み損益%を出す。
// code (= 銘柄コード) は client_payload の ticker を Worker が渡す。未指定 / 未登録は status:none。
//
// profile: ユーザーが /profile で登録した好み・特記事項 (玉の持ち方/リスク許容度等)。positions と同じく
// 返信した本人 (user) の行を引いて同梱する。銘柄非依存なので user だけで引く。未登録は status:none。

import { and, desc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { db } from "../lib/db";
import type { Env } from "../lib/env";
import { buildPositions, type PositionRow } from "../lib/positions";
import { buildProfile, type ProfileRow } from "../lib/profile";
import { daily, positions, prices, userProfiles } from "../lib/schema";
import { appendUserReply, fetchReplies } from "../lib/slack";

export const threadContext = new Hono<{ Bindings: Env }>();

threadContext.get("/thread-context", async (c: Context<{ Bindings: Env }>) => {
	const env = c.env;
	const channel = c.req.query("channel") ?? "";
	const threadTs = c.req.query("thread_ts") ?? "";
	const kind = c.req.query("kind") ?? "";
	const text = c.req.query("text") ?? "";
	const code = c.req.query("code") ?? "";
	// 返信した本人の Slack user_id。建玉はユーザー単位なので、この人の行だけを引く。
	const user = c.req.query("user") ?? "";

	// 親 + 全返信を ts 昇順で。失敗・未設定は空配列 (fetchReplies が握りつぶす)。
	const replies = await fetchReplies(env, {
		channel,
		thread_ts: threadTs,
	});

	// ユーザーの最新返信 (text) が履歴に未反映なら末尾に足す (マージは lib/slack に集約)。
	const merged = appendUserReply(replies, text, threadTs);

	// 保有ポジション: 返信した本人 (user) の当該銘柄の全行 (現物/信用) を引く。
	// code または user が未指定なら空 (= status:none)。建玉はユーザー単位なので両方必須。
	const positionRows =
		code && user
			? ((await db(env.DB)
					.select({
						account: positions.account,
						side: positions.side,
						avgPrice: positions.avgPrice,
						qty: positions.qty,
					})
					.from(positions)
					.where(and(eq(positions.userId, user), eq(positions.ticker, code)))
					.all()) as PositionRow[])
			: [];

	// 好み・特記事項: 返信した本人 (user) の行を引く。銘柄非依存なので user だけで引く。
	// user 未指定なら null (= status:none)。
	const profileRow = user
		? (((await db(env.DB)
				.select({
					riskTolerance: userProfiles.riskTolerance,
					holdStyle: userProfiles.holdStyle,
					maxPositionPct: userProfiles.maxPositionPct,
					cashBalance: userProfiles.cashBalance,
					note: userProfiles.note,
				})
				.from(userProfiles)
				.where(eq(userProfiles.userId, user))
				.get()) as ProfileRow | undefined) ?? null)
		: null;

	// 参照現値: prices の最新行 (live/直近) があればそれ、無ければ daily 最新 close。
	let refPrice: number | null = null;
	if (positionRows.length > 0) {
		const latestPrice = await db(env.DB)
			.select({ price: prices.price })
			.from(prices)
			.where(eq(prices.ticker, code))
			.orderBy(desc(prices.fetchedAt))
			.limit(1)
			.get();
		refPrice = latestPrice?.price ?? null;
		if (refPrice == null) {
			const latestDaily = await db(env.DB)
				.select({ close: daily.close })
				.from(daily)
				.where(eq(daily.ticker, code))
				.orderBy(desc(daily.date))
				.limit(1)
				.get();
			refPrice = latestDaily?.close ?? null;
		}
	}

	return c.json({
		channel,
		thread_ts: threadTs,
		kind,
		replies: merged,
		positions: buildPositions(positionRows, refPrice),
		profile: buildProfile(profileRow),
	});
});
