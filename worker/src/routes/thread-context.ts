// Cloudflare Worker: slack-reply に渡すスレッド文脈を 1 call で返すバンドルエンドポイント。
//
//   GET /thread-context?channel=C123&thread_ts=1700000000.000100&kind=signal-judge&text=<ユーザー返信>
//
// 旧 slack-reply.yml の "Build thread context" ステップ (= conversations.replies を Action から
// 直 curl し jq で整形) を Worker に寄せる。judge-context / market-context / context-input と同じく、
// 決定論的な fetch + 整形は Worker 側に集約し、skill には Read させるだけにする方針に揃える。
//
// 出力は旧 jq の整形結果と完全一致させる (slack-reply skill が読む形):
//   { channel, thread_ts, kind, replies: [{ user, text, ts }, ...] }
// replies は親 + 全返信を ts 昇順で。conversations.replies が失敗 (ok:false / トークン未設定) しても
// channel/thread_ts/kind は query から必ず埋め、replies は空配列でフォールバックする。
// text (= client_payload のユーザー返信本文) が履歴に未反映なら末尾に user メッセージとして足す
// (Slack のイベント反映遅延で最新の問いが replies に来ていないケースの保険)。

import { type Context, Hono } from "hono";
import type { Env } from "../lib/env";
import { appendUserReply, fetchReplies } from "../lib/slack";

export const threadContext = new Hono<{ Bindings: Env }>();

threadContext.get("/thread-context", async (c: Context<{ Bindings: Env }>) => {
	const env = c.env;
	const channel = c.req.query("channel") ?? "";
	const threadTs = c.req.query("thread_ts") ?? "";
	const kind = c.req.query("kind") ?? "";
	const text = c.req.query("text") ?? "";

	// 親 + 全返信を ts 昇順で。失敗・未設定は空配列 (fetchReplies が握りつぶす)。
	const replies = await fetchReplies(env, {
		channel,
		thread_ts: threadTs,
	});

	// ユーザーの最新返信 (text) が履歴に未反映なら末尾に足す (マージは lib/slack に集約)。
	const merged = appendUserReply(replies, text, threadTs);

	return c.json({ channel, thread_ts: threadTs, kind, replies: merged });
});
