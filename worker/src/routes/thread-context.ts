// Cloudflare Worker: slack-reply に渡すスレッド文脈を 1 call で返すバンドルエンドポイント。
//
//   GET /thread-context?channel=C123&thread_ts=1700000000.000100&kind=signal-judge&text=<ユーザー返信>
//
// 旧 slack-reply.yml の "Build thread context" ステップ (= conversations.replies を Action から
// 直 curl し jq で整形) を Worker に寄せる。judge-context / market-context / context-input と同じく、
// 決定論的な fetch + 整形は Worker 側に集約し、skill には Read させるだけにする方針に揃える。
//
// 出力は旧 jq の整形結果に positions を加えたもの (slack-reply skill が読む形):
//   { channel, thread_ts, kind, replies: [{ user, text, ts }, ...], positions: {...} }
// replies は親 + 全返信を ts 昇順で。conversations.replies が失敗 (ok:false / トークン未設定) しても
// channel/thread_ts/kind は query から必ず埋め、replies は空配列でフォールバックする。
// text (= client_payload のユーザー返信本文) が履歴に未反映なら末尾に user メッセージとして足す
// (Slack のイベント反映遅延で最新の問いが replies に来ていないケースの保険)。
//
// positions: ユーザーが /position で登録した保有建玉。signal-judge / crash-scenario は汎用判定の
// まま据え置き、ポジション考慮は slack-reply だけが行うため、judge-context ではなくここに乗せる。
// 参照現値は prices の live があればそれ、無ければ daily 最新 close を使い、各行の含み損益%を出す。
// code (= 銘柄コード) は client_payload の ticker を Worker が渡す。未指定 / 未登録は status:none。

import { desc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { db } from "../lib/db";
import type { Env } from "../lib/env";
import { buildPositions, type PositionRow } from "../lib/positions";
import { daily, positions, prices } from "../lib/schema";
import { appendUserReply, fetchReplies } from "../lib/slack";

export const threadContext = new Hono<{ Bindings: Env }>();

threadContext.get("/thread-context", async (c: Context<{ Bindings: Env }>) => {
	const env = c.env;
	const channel = c.req.query("channel") ?? "";
	const threadTs = c.req.query("thread_ts") ?? "";
	const kind = c.req.query("kind") ?? "";
	const text = c.req.query("text") ?? "";
	const code = c.req.query("code") ?? "";

	// 親 + 全返信を ts 昇順で。失敗・未設定は空配列 (fetchReplies が握りつぶす)。
	const replies = await fetchReplies(env, {
		channel,
		thread_ts: threadTs,
	});

	// ユーザーの最新返信 (text) が履歴に未反映なら末尾に足す (マージは lib/slack に集約)。
	const merged = appendUserReply(replies, text, threadTs);

	// 保有ポジション: 当該銘柄の全行 (現物/信用) を引く。code 未指定なら空。
	const positionRows = code
		? ((await db(env.DB)
				.select({
					account: positions.account,
					side: positions.side,
					avgPrice: positions.avgPrice,
					qty: positions.qty,
				})
				.from(positions)
				.where(eq(positions.ticker, code))
				.all()) as PositionRow[])
		: [];

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
	});
});
