// Cloudflare Worker: 新規IRの Slack 通知。index.ts から切り出し。
// 収集側 (ir-collect.ts) が新規記事を集めて notifySlack に渡す。Webhook 未設定なら no-op。

import type { Env } from "./env";

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
