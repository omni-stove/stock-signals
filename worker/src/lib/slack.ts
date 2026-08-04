// Cloudflare Worker: 新規IRの Slack 通知。Webhook 未設定なら no-op。

import type { Env } from "./env";

// Bot トークンで chat.postMessage する。返信対話の起点になる解析結果投稿 (ticker-brief /
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
		const body = (await res.json()) as {
			ok: boolean;
			error?: string;
			response_metadata?: { messages?: string[] };
		};
		if (!body.ok) {
			// invalid_arguments 等は response_metadata.messages に不正フィールドの詳細が入る。
			const detail = body.response_metadata?.messages?.join(" | ") ?? "";
			console.error(
				`views.open failed: ${body.error}${detail ? ` (${detail})` : ""}`,
			);
			return false;
		}
		return true;
	} catch (e) {
		console.error(`views.open error: ${(e as Error).message}`);
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
// 送り先は IR専用の SLACK_IR_WEBHOOK_URL を優先し、無ければ SLACK_WEBHOOK_URL にフォールバック。
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

// ニュース1件の通知用の正規化形。銘柄ニュースは ticker を持ち、市場テーマニュースは topic を持つ。
export type NewsNotifyItem = {
	title: string;
	url: string;
	date: string;
	// 銘柄ニュースなら銘柄コード、市場テーマニュースなら topic キー (semi/ai/rate 等)。見出しのタグに使う。
	tag: string;
};

// 新規取得したニュースを Slack に通知する。専用 webhook (SLACK_NEWS_WEBHOOK_URL) 未設定なら何もしない。
// IR(notifySlack) と別チャンネルに出す。1リクエストで全件まとめて送る (場中の連投を避ける)。
// kind は見出しに出すラベル (例 "🗞️ 新規ニュース" / "🌐 市場テーマニュース")。
export async function notifyNewsSlack(
	env: Env,
	kind: string,
	items: NewsNotifyItem[],
): Promise<void> {
	const webhook = env.SLACK_NEWS_WEBHOOK_URL;
	if (!webhook || items.length === 0) return;

	const blocks: unknown[] = [
		{
			type: "header",
			text: {
				type: "plain_text",
				text: `${kind} ${items.length}件`,
				emoji: true,
			},
		},
	];
	for (const it of items) {
		blocks.push({
			type: "section",
			text: {
				type: "mrkdwn",
				text: `\`${it.tag}\` \`${it.date}\`\n<${it.url}|${it.title}>`,
			},
		});
	}

	// フォールバック text (通知プレビュー用)。
	const fallback = items
		.map((it) => `[${it.tag}] ${it.date} ${it.title}`)
		.join("\n");

	try {
		const res = await fetch(webhook, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: fallback, blocks }),
		});
		if (!res.ok) {
			console.error(
				`slack news notify failed: HTTP ${res.status} ${await res.text()}`,
			);
		}
	} catch (e) {
		// 通知失敗は収集を止めない (best-effort)。
		console.error(`slack news notify error: ${(e as Error).message}`);
	}
}

// 重要イベントリマインダーの1件 (event-reminder.ts の buildEventReminders が作る)。
export type ReminderNotifyItem = {
	daysUntil: number; // 0=本日, 1=明日, ...
	date: string; // YYYY-MM-DD
	label: string;
};

// daysUntil → 行頭の時期表現。
function reminderWhen(it: ReminderNotifyItem): string {
	if (it.daysUntil === 0) return "本日";
	if (it.daysUntil === 1) return `明日 (${it.date})`;
	return `${it.daysUntil}日後 (${it.date})`;
}

// 重要イベント (決算/FOMC/日銀/SQ/リバランス) の事前リマインダーを送る。
// 送り先は専用の SLACK_REMINDER_WEBHOOK_URL を優先し、無ければ SLACK_WEBHOOK_URL。
// webhook 未設定/0件なら no-op。1リクエストで全件まとめて送る。best-effort。
export async function notifyEventReminder(
	env: Env,
	today: string,
	items: ReminderNotifyItem[],
): Promise<void> {
	const webhook = env.SLACK_REMINDER_WEBHOOK_URL || env.SLACK_WEBHOOK_URL;
	if (!webhook || items.length === 0) return;
	const lines = items.map((it) => `• *${reminderWhen(it)}*: ${it.label}`);
	const text = `⏰ イベントリマインダー (${today})\n${lines.join("\n")}`;
	try {
		const res = await fetch(webhook, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text }),
		});
		if (!res.ok) {
			console.error(
				`slack reminder notify failed: HTTP ${res.status} ${await res.text()}`,
			);
		}
	} catch (e) {
		// 通知失敗は cron を止めない (best-effort)。
		console.error(`slack reminder notify error: ${(e as Error).message}`);
	}
}

// 収集ソースの「HTTP 200 なのに一覧パース0件」を運用者に警告する。ソースサイトの DOM 変更で
// 収集がエラーも出さずに止まる事故の検知用。sources は "news:285A" / "market-news" 等のラベル。
// 送り先は SLACK_WEBHOOK_URL (レポートと同じ運用チャンネル)。未設定/0件なら no-op。best-effort。
export async function notifyParseFailure(
	env: Env,
	sources: string[],
): Promise<void> {
	const webhook = env.SLACK_WEBHOOK_URL;
	if (!webhook || sources.length === 0) return;
	const text = `⚠️ 収集一覧のパース0件 (DOM変更の可能性): ${sources.join(", ")}`;
	try {
		const res = await fetch(webhook, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text }),
		});
		if (!res.ok) {
			console.error(
				`slack parse-failure notify failed: HTTP ${res.status} ${await res.text()}`,
			);
		}
	} catch (e) {
		// 通知失敗は収集を止めない (best-effort)。
		console.error(`slack parse-failure notify error: ${(e as Error).message}`);
	}
}

if (import.meta.vitest) {
	const { describe, it, expect, vi } = import.meta.vitest;

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

	describe("categoryHeading", () => {
		it("既知カテゴリは専用見出しを返す", () => {
			expect(categoryHeading("holdings")).toBe("📢 適時開示 (持株会社)");
			expect(categoryHeading("corporate")).toBe("🏢 企業情報");
			expect(categoryHeading("business")).toBe("🔧 製品・事業");
			expect(categoryHeading("personal")).toBe("🛒 個人向け");
		});
		it("未知カテゴリ・空文字は default の汎用見出し", () => {
			expect(categoryHeading("unknown")).toBe("📄 IR");
			expect(categoryHeading("")).toBe("📄 IR");
		});
	});

	describe("notifyParseFailure", () => {
		it("webhook 未設定なら fetch を呼ばない (no-op)", async () => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			await notifyParseFailure({} as Env, ["news:285A"]);
			expect(fetchMock).not.toHaveBeenCalled();
			vi.unstubAllGlobals();
		});

		it("対象 0 件なら fetch を呼ばない (no-op)", async () => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			await notifyParseFailure(
				{ SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" } as Env,
				[],
			);
			expect(fetchMock).not.toHaveBeenCalled();
			vi.unstubAllGlobals();
		});

		it("ソースラベルを連結した警告テキストを1リクエストで送る", async () => {
			const fetchMock = vi.fn().mockResolvedValue({ ok: true });
			vi.stubGlobal("fetch", fetchMock);
			await notifyParseFailure(
				{ SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" } as Env,
				["news:285A", "market-news"],
			);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
			expect(body.text).toContain("パース0件");
			expect(body.text).toContain("news:285A, market-news");
			vi.unstubAllGlobals();
		});
	});

	describe("notifyEventReminder", () => {
		const items = [
			{
				daysUntil: 0,
				date: "2026-07-06",
				label: "日本SQ (7月限オプションのみ)",
			},
			{
				daysUntil: 3,
				date: "2026-07-09",
				label: "決算発表: キオクシアホールディングス (285A)",
			},
		];

		it("webhook 未設定なら fetch を呼ばない (no-op)", async () => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			await notifyEventReminder({} as Env, "2026-07-06", items);
			expect(fetchMock).not.toHaveBeenCalled();
			vi.unstubAllGlobals();
		});

		it("0件なら fetch を呼ばない (no-op)", async () => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			await notifyEventReminder(
				{ SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" } as Env,
				"2026-07-06",
				[],
			);
			expect(fetchMock).not.toHaveBeenCalled();
			vi.unstubAllGlobals();
		});

		it("本日/N日後の時期表現つきで1リクエストにまとめて送る", async () => {
			const fetchMock = vi.fn().mockResolvedValue({ ok: true });
			vi.stubGlobal("fetch", fetchMock);
			await notifyEventReminder(
				{ SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" } as Env,
				"2026-07-06",
				items,
			);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
			expect(body.text).toContain("⏰ イベントリマインダー (2026-07-06)");
			expect(body.text).toContain("*本日*: 日本SQ (7月限オプションのみ)");
			expect(body.text).toContain(
				"*3日後 (2026-07-09)*: 決算発表: キオクシアホールディングス (285A)",
			);
			vi.unstubAllGlobals();
		});

		it("専用 webhook があればそちらを優先する", async () => {
			const fetchMock = vi.fn().mockResolvedValue({ ok: true });
			vi.stubGlobal("fetch", fetchMock);
			await notifyEventReminder(
				{
					SLACK_WEBHOOK_URL: "https://hooks.slack.com/report",
					SLACK_REMINDER_WEBHOOK_URL: "https://hooks.slack.com/reminder",
				} as Env,
				"2026-07-06",
				items,
			);
			expect(fetchMock.mock.calls[0][0]).toBe(
				"https://hooks.slack.com/reminder",
			);
			vi.unstubAllGlobals();
		});
	});

	describe("notifyNewsSlack", () => {
		const item = {
			tag: "285A",
			title: "業績上方修正",
			url: "https://kabutan.jp/news/?b=n1",
			date: "2026-06-26",
		};

		it("webhook 未設定なら fetch を呼ばない (no-op)", async () => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			await notifyNewsSlack({} as Env, "🗞️ 新規ニュース", [item]);
			expect(fetchMock).not.toHaveBeenCalled();
			vi.unstubAllGlobals();
		});

		it("新着 0 件なら fetch を呼ばない (no-op)", async () => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			await notifyNewsSlack(
				{ SLACK_NEWS_WEBHOOK_URL: "https://hooks.slack.com/x" } as Env,
				"🗞️ 新規ニュース",
				[],
			);
			expect(fetchMock).not.toHaveBeenCalled();
			vi.unstubAllGlobals();
		});

		it("webhook 設定 + 新着ありで header + 件数分の section を1リクエストで送る", async () => {
			const fetchMock = vi.fn().mockResolvedValue({ ok: true });
			vi.stubGlobal("fetch", fetchMock);
			await notifyNewsSlack(
				{ SLACK_NEWS_WEBHOOK_URL: "https://hooks.slack.com/x" } as Env,
				"🗞️ 新規ニュース",
				[item, { ...item, url: "https://kabutan.jp/news/?b=n2" }],
			);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
			expect(body.blocks[0].type).toBe("header");
			expect(body.blocks[0].text.text).toBe("🗞️ 新規ニュース 2件");
			expect(
				body.blocks.filter((b: { type: string }) => b.type === "section"),
			).toHaveLength(2);
			expect(body.text).toContain("[285A] 2026-06-26 業績上方修正");
			vi.unstubAllGlobals();
		});
	});
}
