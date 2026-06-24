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

// trigger_id を使って modal (views.open) を開く。スラッシュコマンドの銘柄ピッカーを
// ephemeral の static_select ではなく真の modal で出すのに使う。trigger_id は発行から
// 約3秒で失効するので、command ハンドラの中で (waitUntil ではなく) 即座に呼ぶこと。
// best-effort: トークン未設定/失敗時は false を返し、呼び出し側で握りつぶす。
export async function openView(
	env: Env,
	args: { trigger_id: string; view: unknown },
): Promise<boolean> {
	if (!env.SLACK_BOT_TOKEN) return false;
	try {
		const res = await fetch("https://slack.com/api/views.open", {
			method: "POST",
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
			},
			body: JSON.stringify({ trigger_id: args.trigger_id, view: args.view }),
		});
		const body = (await res.json()) as { ok: boolean; error?: string };
		if (!body.ok) {
			console.error(`views.open failed: ${body.error}`);
			return false;
		}
		return true;
	} catch (e) {
		console.error(`views.open error: ${(e as Error).message}`);
		return false;
	}
}

// 既に開いている modal を view_id 指定で差し替える (views.update)。trigger_id と違い view_id は
// 失効しないので、block_actions を受けたあと waitUntil で非同期に呼んでよい。銘柄選択後に
// ピッカーを「起動しました」表示へ差し替えるのに使う。best-effort: 失敗時は false。
export async function updateView(
	env: Env,
	args: { view_id: string; view: unknown },
): Promise<boolean> {
	if (!env.SLACK_BOT_TOKEN) return false;
	try {
		const res = await fetch("https://slack.com/api/views.update", {
			method: "POST",
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
			},
			body: JSON.stringify({ view_id: args.view_id, view: args.view }),
		});
		const body = (await res.json()) as { ok: boolean; error?: string };
		if (!body.ok) {
			console.error(`views.update failed: ${body.error}`);
			return false;
		}
		return true;
	} catch (e) {
		console.error(`views.update error: ${(e as Error).message}`);
		return false;
	}
}

// スレッド1メッセージの正規化形 (user / text / ts)。thread-context が返す replies の要素。
export type SlackReply = { user: string; text: string; ts: string };

// ユーザーの最新返信 (text) が履歴 (replies) に未反映なら末尾に user メッセージとして足す。
// Slack のイベント反映遅延で、最新の問いが conversations.replies にまだ来ていないケースの保険。
// text が空、または既に同じ本文が履歴にあれば二重化せずそのまま返す (純粋関数・破壊しない)。
export function appendUserReply(
	replies: SlackReply[],
	text: string,
	ts: string,
): SlackReply[] {
	if (!text || replies.some((r) => r.text === text)) return replies;
	return [...replies, { user: "user", text, ts }];
}

// スレッドの会話履歴 (親 + 全返信) を ts 昇順で取得する (conversations.replies)。
// slack-reply が返信に答えるための文脈。要 channels:history (public) / groups:history (private)。
// 各メッセージは user / text / ts に正規化して返す (user 不明なら bot_id、それも無ければ "?")。
// best-effort: トークン未設定・ok:false・例外はすべて空配列を返し、呼び出し側でフォールバックさせる。
export async function fetchReplies(
	env: Env,
	args: { channel: string; thread_ts: string; limit?: number },
): Promise<SlackReply[]> {
	if (!env.SLACK_BOT_TOKEN) return [];
	try {
		const url = new URL("https://slack.com/api/conversations.replies");
		url.searchParams.set("channel", args.channel);
		url.searchParams.set("ts", args.thread_ts);
		url.searchParams.set("limit", String(args.limit ?? 100));
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
		});
		const body = (await res.json()) as {
			ok: boolean;
			error?: string;
			messages?: {
				user?: string;
				bot_id?: string;
				text?: string;
				ts: string;
			}[];
		};
		if (!body.ok) {
			console.error(`conversations.replies failed: ${body.error}`);
			return [];
		}
		return (body.messages ?? []).map((m) => ({
			user: m.user ?? m.bot_id ?? "?",
			text: m.text ?? "",
			ts: m.ts,
		}));
	} catch (e) {
		console.error(`conversations.replies error: ${(e as Error).message}`);
		return [];
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

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("appendUserReply", () => {
		const base: SlackReply[] = [
			{ user: "u1", text: "親メッセージ", ts: "100" },
			{ user: "u2", text: "既存返信", ts: "101" },
		];

		it("履歴に無い text を user メッセージとして末尾に足す", () => {
			expect(appendUserReply(base, "新しい問い", "102")).toEqual([
				...base,
				{ user: "user", text: "新しい問い", ts: "102" },
			]);
		});

		it("既に同じ本文があれば二重化しない", () => {
			expect(appendUserReply(base, "既存返信", "102")).toBe(base);
		});

		it("text が空ならそのまま返す", () => {
			expect(appendUserReply(base, "", "102")).toBe(base);
		});

		it("元配列を破壊しない", () => {
			const copy = [...base];
			appendUserReply(base, "x", "102");
			expect(base).toEqual(copy);
		});
	});
}
