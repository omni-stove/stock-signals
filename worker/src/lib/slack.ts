// Cloudflare Worker: 新規IRの Slack 通知。index.ts から切り出し。
// 収集側 (ir-collect.ts) が新規記事を集めて notifySlack に渡す。Webhook 未設定なら no-op。

import type { Env } from "./env";

// Bot トークンで chat.postMessage する。返信対話の起点になる解析結果投稿 (signal-judge /
// crash-scenario) と、その返信への返答投稿の両方に使う。webhook と違い ts を取得できるので、
// 親投稿の ts を D1 (slack_threads) に控えてスレッド返信から銘柄を復元できる。
// thread_ts を渡すとスレッド返信として投稿する (返答はこれで同スレッドにぶら下げる)。
// 成功時は { ts, channel } を、失敗/未設定時は null を返す。
export async function postMessage(
	env: Env,
	args: {
		channel: string;
		text: string;
		blocks?: unknown[];
		thread_ts?: string;
	},
): Promise<{ ts: string; channel: string } | null> {
	if (!env.SLACK_BOT_TOKEN) return null;
	try {
		const res = await fetch("https://slack.com/api/chat.postMessage", {
			method: "POST",
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
			},
			body: JSON.stringify({
				channel: args.channel,
				text: args.text,
				...(args.blocks ? { blocks: args.blocks } : {}),
				...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
			}),
		});
		// Slack API は HTTP 200 でも body.ok=false でエラーを返す (invalid_auth など)。
		const body = (await res.json()) as {
			ok: boolean;
			ts?: string;
			channel?: string;
			error?: string;
		};
		if (!body.ok) {
			console.error(`chat.postMessage failed: ${body.error}`);
			return null;
		}
		return { ts: body.ts ?? "", channel: body.channel ?? args.channel };
	} catch (e) {
		console.error(`chat.postMessage error: ${(e as Error).message}`);
		return null;
	}
}

// 指定メッセージに絵文字リアクションを付ける (reactions.add)。スレッド返信を受け付けた
// 直後に「処理中」を可視化する用途。要 reactions:write スコープ。channel + ts (返信メッセージ
// の ts) で対象を指定する。best-effort: 失敗/未設定でも呼び出し側を止めない。
// already_reacted (再送で二重に付くケース) は成功扱いにする。
export async function addReaction(
	env: Env,
	args: { channel: string; timestamp: string; name: string },
): Promise<boolean> {
	if (!env.SLACK_BOT_TOKEN) return false;
	try {
		const res = await fetch("https://slack.com/api/reactions.add", {
			method: "POST",
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
			},
			body: JSON.stringify({
				channel: args.channel,
				timestamp: args.timestamp,
				name: args.name,
			}),
		});
		const body = (await res.json()) as { ok: boolean; error?: string };
		if (!body.ok && body.error !== "already_reacted") {
			console.error(`reactions.add failed: ${body.error}`);
			return false;
		}
		return true;
	} catch (e) {
		console.error(`reactions.add error: ${(e as Error).message}`);
		return false;
	}
}

export type NotifyItem = {
	ticker: string;
	title: string;
	url: string;
	date: string;
	category: string;
};

// IRカテゴリ → Slack表示用の見出し。holdings(適時開示)を最も目立たせる。
function categoryHeading(cat: string): string {
	switch (cat) {
		case "holdings":
			return "📢 適時開示 (持株会社)";
		case "corporate":
			return "🏢 企業情報";
		case "business":
			return "🔧 製品・事業";
		case "personal":
			return "🛒 個人向け";
		default:
			return "📄 IR";
	}
}

// 新規取得したIRを Slack に通知する。Webhook未設定なら何もしない。
// 1リクエストで全件まとめて送る (1記事1メッセージにすると場中に連投になるため)。
// 送り先は IR専用の SLACK_IR_WEBHOOK_URL を優先し、無ければ SLACK_WEBHOOK_URL にフォールバック
// (レポート判定と同一チャンネルに出る従来挙動)。
export async function notifySlack(
	env: Env,
	items: NotifyItem[],
): Promise<void> {
	const webhook = env.SLACK_IR_WEBHOOK_URL || env.SLACK_WEBHOOK_URL;
	if (!webhook || items.length === 0) return;

	// holdings(適時開示) を先頭に寄せて目立たせる。
	const order = (c: string) => (c === "holdings" ? 0 : 1);
	const sorted = [...items].sort(
		(a, b) => order(a.category) - order(b.category),
	);

	const blocks: unknown[] = [
		{
			type: "header",
			text: {
				type: "plain_text",
				text: `🆕 新規IR ${items.length}件 (${sorted[0].ticker})`,
				emoji: true,
			},
		},
	];
	for (const it of sorted) {
		blocks.push({
			type: "section",
			text: {
				type: "mrkdwn",
				text: `${categoryHeading(it.category)}  \`${it.date}\`\n<${it.url}|${it.title}>`,
			},
		});
	}

	// フォールバック text (通知プレビュー用)。
	const fallback = sorted
		.map((it) => `[${it.category}] ${it.date} ${it.title}`)
		.join("\n");

	try {
		const res = await fetch(webhook, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: fallback, blocks }),
		});
		if (!res.ok) {
			console.error(
				`slack notify failed: HTTP ${res.status} ${await res.text()}`,
			);
		}
	} catch (e) {
		// 通知失敗は収集を止めない (best-effort)。
		console.error(`slack notify error: ${(e as Error).message}`);
	}
}
