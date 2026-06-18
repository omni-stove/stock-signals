// Cloudflare Worker: stock-signals 収集 (PoC: fetch-ir)
//
// ローカルの scripts/fetch-ir.ts と同じ解析ロジックで kioxia の公式IRを取得し、
// 記事本文を R2 (ARTICLES) に、メタ+重複排除キーを D1 (DB) に保存する。
//
// エントリポイント:
//   - scheduled(): Cron Trigger 発火時。ir定義の全銘柄を取得。
//   - fetch():     /run?code=285A&limit=3 で手動起動 (dev検証/オンデマンド用)。
//                  /health で疎通確認。
//
// 解析対象 (kioxia): https://www.kioxia.com/ja-jp/news.html
//   <a class="cmp-button"> の href が記事URL、.cmp-button__text がタイトル。
//   日付は URL の YYYYMMDD、カテゴリは URL パスから判別。
//   事業会社(kioxia.com)と持株会社(kioxia-holdings.com=上場主体)の両方が並ぶ。

import * as cheerio from "cheerio";
import { collectDisclosures } from "./disclosure";
import { collectEarnings } from "./earnings";
import { collectNews } from "./news";
import { collectBackdrop } from "./premarket";
import { collectRatings } from "./ratings";
import { collectTimeseries } from "./timeseries";

export interface Env {
	DB: D1Database;
	ARTICLES: R2Bucket;
	USER_AGENT: string;
	MIN_INTERVAL_MS: string;
	// Slack Incoming Webhook URL (Secret)。未設定なら通知をスキップ (取得自体は動く)。
	//   設定: npx wrangler secret put SLACK_WEBHOOK_URL
	//   dev:  worker/.dev.vars に SLACK_WEBHOOK_URL="https://hooks.slack.com/..." と書く
	SLACK_WEBHOOK_URL?: string;
	// 全エンドポイント (/health を除く) の簡易認証トークン (Secret)。未設定なら認証なし (dev用)。
	//   設定: npx wrangler secret put SYNC_TOKEN
	//   送り方は Authorization: Bearer <token> ヘッダ、または ?token=<token> クエリのどちらでも可。
	//   ヘッダ推奨 (URL がログ/履歴に残らない)。/run /dispatch-test /test-slack /latest /pull /pull-news が対象。
	SYNC_TOKEN?: string;
	// 新規IR/ニュース取得時に GitHub Actions (signal-report) を repository_dispatch で起動するための
	// GitHub App (omnistove-internal-auth) 認証情報。App秘密鍵で JWT を署名し
	// installation token に交換して叩く。3つ揃っていなければ発火しない (取得自体は動く)。
	//   GH_APP_ID          … App ID (数値)
	//   GH_APP_PRIVATE_KEY … App の private key (.pem の中身、PKCS#8 PEM)。Secret。
	//   GH_APP_INSTALL_ID  … omni-stove org への installation id (数値)
	//     設定: npx wrangler secret put GH_APP_PRIVATE_KEY  (ID系は vars でも secret でも可)
	GH_APP_ID?: string;
	GH_APP_PRIVATE_KEY?: string;
	GH_APP_INSTALL_ID?: string;
	// 発火先リポジトリ (owner/repo)。未設定なら下記デフォルトを使う。
	GITHUB_REPO?: string;
}

// ── GitHub App 認証 (repository_dispatch 発火用) ─────────────────────────────
// Cloudflare Workers の Web Crypto (crypto.subtle) で RS256 JWT を署名し、
// installation access token に交換する。外部ライブラリ不要。

function b64url(data: ArrayBuffer | string): string {
	const bytes =
		typeof data === "string"
			? new TextEncoder().encode(data)
			: new Uint8Array(data);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// PKCS#8 PEM (-----BEGIN PRIVATE KEY-----) を CryptoKey に取り込む。
async function importPrivateKey(pem: string): Promise<CryptoKey> {
	const body = pem
		.replace(/-----BEGIN [^-]+-----/, "")
		.replace(/-----END [^-]+-----/, "")
		.replace(/\s+/g, "");
	const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
	return crypto.subtle.importKey(
		"pkcs8",
		der.buffer,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
}

// App JWT を生成 (iat を少し過去に、exp は最大10分以内)。
async function makeAppJwt(
	appId: string,
	pem: string,
	nowSec: number,
): Promise<string> {
	const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = b64url(
		JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }),
	);
	const key = await importPrivateKey(pem);
	const sig = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(`${header}.${payload}`),
	);
	return `${header}.${payload}.${b64url(sig)}`;
}

const GH_HEADERS = {
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
	"User-Agent": "stock-signals-collector",
};

// App JWT → installation access token に交換する。
async function getInstallationToken(
	jwt: string,
	installId: string,
): Promise<string> {
	const res = await fetch(
		`https://api.github.com/app/installations/${installId}/access_tokens`,
		{
			method: "POST",
			headers: { ...GH_HEADERS, Authorization: `Bearer ${jwt}` },
		},
	);
	if (!res.ok)
		throw new Error(
			`installation token: HTTP ${res.status} ${await res.text()}`,
		);
	return ((await res.json()) as { token: string }).token;
}

// 新規IR or ニュースを取得したとき、GitHub Actions の signal-report ワークフローを
// repository_dispatch で起動する。cron で当てずっぽうに起動して0件を引く構造を避け、
// 「新規があるときだけ」LLMを動かす。判定は IR+ニュース両方の最新状態を読むので、
// どちらの新着が引き金でも同じイベント (signal-update) で発火する。
//
// 銘柄ごとに別ジョブにして concurrency(cancel-in-progress)を銘柄単位で効かせるため、
// 1銘柄=1 dispatch で撃つ (client_payload.ticker は単一銘柄)。
// App 認証情報が揃っていなければ no-op (best-effort、発火失敗で収集は止めない)。
async function dispatchSignalUpdate(
	env: Env,
	tickers: string[],
): Promise<void> {
	if (tickers.length === 0) return;
	if (!env.GH_APP_ID || !env.GH_APP_PRIVATE_KEY || !env.GH_APP_INSTALL_ID)
		return;
	const repo = env.GITHUB_REPO || "omni-stove/stock-signals";
	try {
		// Workers 内は Date.now() が使える (collectOne 等でも new Date() を使用済み)。
		const nowSec = Math.floor(Date.now() / 1000);
		const jwt = await makeAppJwt(env.GH_APP_ID, env.GH_APP_PRIVATE_KEY, nowSec);
		const token = await getInstallationToken(jwt, env.GH_APP_INSTALL_ID);
		// 銘柄ごとに dispatch (concurrency group を銘柄単位にするため)。
		for (const ticker of tickers) {
			const res = await fetch(
				`https://api.github.com/repos/${repo}/dispatches`,
				{
					method: "POST",
					headers: {
						...GH_HEADERS,
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					// event_type は workflow の on.repository_dispatch.types と一致させる。
					body: JSON.stringify({
						event_type: "signal-update",
						client_payload: { ticker },
					}),
				},
			);
			if (!res.ok) {
				console.error(
					`dispatch failed (${ticker}): HTTP ${res.status} ${await res.text()}`,
				);
			}
		}
	} catch (e) {
		console.error(`dispatch error: ${(e as Error).message}`);
	}
}

// ir定義 (ローカルの config/sources.yaml の ir 相当。PoC ではコードに直書き)。
const IR_SOURCES = [
	{
		code: "285A",
		site: "kioxia",
		list_url: "https://www.kioxia.com/ja-jp/news.html",
	},
];

const DEFAULT_LIMIT = 20;

type ListItem = { url: string; title: string; date: string; category: string };

function dateFromUrl(url: string): string {
	const m = url.match(/\/(\d{4})(\d{2})(\d{2})-\d+\.html/);
	return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

function categoryFromUrl(url: string): string {
	if (url.includes("kioxia-holdings.com")) return "holdings";
	if (url.includes("/about/news/")) return "corporate";
	if (url.includes("/business/news/")) return "business";
	if (url.includes("/personal/news/")) return "personal";
	return "other";
}

// kioxia ニュース一覧パーサ (scripts/fetch-ir.ts の parseKioxiaList と同じ)。
function parseKioxiaList(html: string, baseUrl: string): ListItem[] {
	const $ = cheerio.load(html);
	const out: ListItem[] = [];
	const seenUrl = new Set<string>();
	$("a.cmp-button").each((_, a) => {
		const href = $(a).attr("href");
		if (!href) return;
		const url = new URL(href, baseUrl).toString();
		const date = dateFromUrl(url);
		if (!date) return;
		if (seenUrl.has(url)) return;
		seenUrl.add(url);
		const title =
			$(a).find(".cmp-button__text").text().trim() || $(a).text().trim();
		if (!title) return;
		out.push({ url, title, date, category: categoryFromUrl(url) });
	});
	return out;
}

function parseKioxiaArticle(html: string): { title: string; body: string } {
	const $ = cheerio.load(html);
	const title = $("h1").first().text().trim() || $("title").text().trim();
	const body =
		$("main").text().trim() ||
		$("article").text().trim() ||
		$(".cmp-text").text().trim() ||
		$("body").text().trim();
	return {
		title,
		body: body
			.replace(/[ \t]+/g, " ")
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
	};
}

// 全ソース UTF-8 (調査済) なので TextDecoder で十分。iconv 不要。
async function fetchText(url: string, env: Env): Promise<string> {
	const res = await fetch(url, {
		headers: { "User-Agent": env.USER_AGENT },
		// Cloudflare のリクエストには Worker 既定のタイムアウトが効く
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	const buf = await res.arrayBuffer();
	return new TextDecoder("utf-8").decode(buf);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// 既に D1 に存在する URL か (= seen.txt 相当の重複排除)。
async function isSeen(env: Env, url: string): Promise<boolean> {
	const row = await env.DB.prepare(
		"SELECT 1 FROM articles WHERE url = ? LIMIT 1",
	)
		.bind(url)
		.first();
	return row !== null;
}

async function saveArticle(
	env: Env,
	meta: {
		url: string;
		ticker: string;
		source: string;
		title: string;
		published_at: string;
		ir_category: string;
		body: string;
	},
): Promise<void> {
	const fetched_at = new Date().toISOString();
	// R2 キー: ticker/日付-ハッシュ.json (一覧しやすい構造)。
	const r2_key = `${meta.ticker}/${meta.published_at}-${hash(meta.url)}.json`;
	const payload = JSON.stringify({ ...meta, fetched_at }, null, 2);
	await env.ARTICLES.put(r2_key, payload, {
		httpMetadata: { contentType: "application/json" },
	});
	await env.DB.prepare(
		`INSERT OR IGNORE INTO articles
      (url, ticker, source, title, published_at, ir_category, r2_key, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			meta.url,
			meta.ticker,
			meta.source,
			meta.title,
			meta.published_at,
			meta.ir_category,
			r2_key,
			fetched_at,
		)
		.run();
}

// 共通認証ゲート。SYNC_TOKEN 未設定なら常に許可 (dev / wrangler dev)。設定済みなら
// Authorization: Bearer <token> ヘッダ、または ?token=<token> クエリのどちらかが一致すれば許可。
// 長さの異なる文字列は != で即 false になるが、トークンは固定長の Secret 前提なので
// タイミング差は実害なし (簡易比較)。/health は呼び出し側で除外済み。
function isAuthorized(request: Request, url: URL, env: Env): boolean {
	if (!env.SYNC_TOKEN) return true;
	const auth = request.headers.get("authorization") || "";
	const m = auth.match(/^Bearer\s+(.+)$/i);
	const presented = (m ? m[1] : null) ?? url.searchParams.get("token");
	return presented === env.SYNC_TOKEN;
}

// URL → 短いハッシュ (R2キー用)。crypto.subtle は async なので簡易版を同期で。
function hash(s: string): string {
	let h = 0;
	for (let i = 0; i < s.length; i++) {
		h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

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

type NotifyItem = {
	ticker: string;
	title: string;
	url: string;
	date: string;
	category: string;
};

// 新規取得したIRを Slack に通知する。Webhook未設定なら何もしない。
// 1リクエストで全件まとめて送る (1記事1メッセージにすると場中に連投になるため)。
async function notifySlack(env: Env, items: NotifyItem[]): Promise<void> {
	if (!env.SLACK_WEBHOOK_URL || items.length === 0) return;

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
		const res = await fetch(env.SLACK_WEBHOOK_URL, {
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

// 1ソースを取得。新しい順に最大 limit 件、未取得のものだけ本文取得→保存。
async function collectOne(
	env: Env,
	src: (typeof IR_SOURCES)[number],
	limit: number,
): Promise<{ found: number; written: number; skipped: number }> {
	const listHtml = await fetchText(src.list_url, env);
	let items = parseKioxiaList(listHtml, src.list_url);
	items.sort((a, b) => b.date.localeCompare(a.date));
	const total = items.length;
	items = items.slice(0, limit);

	const interval = parseInt(env.MIN_INTERVAL_MS, 10) || 5000;
	let skipped = 0;
	const fresh: NotifyItem[] = []; // 今回新規に保存した記事 (Slack通知対象)
	for (const it of items) {
		if (await isSeen(env, it.url)) {
			skipped++;
			continue;
		}
		await sleep(interval);
		try {
			const artHtml = await fetchText(it.url, env);
			const parsed = parseKioxiaArticle(artHtml);
			const title = parsed.title || it.title;
			await saveArticle(env, {
				url: it.url,
				ticker: src.code,
				source: `ir:${src.site}:${src.code}`,
				title,
				published_at: it.date,
				ir_category: it.category,
				body: parsed.body,
			});
			fresh.push({
				ticker: src.code,
				title,
				url: it.url,
				date: it.date,
				category: it.category,
			});
		} catch (e) {
			console.error(`article error ${it.url}: ${(e as Error).message}`);
		}
	}
	// 新規があればまとめてSlack通知 (Webhook未設定なら no-op)。
	await notifySlack(env, fresh);
	return { found: total, written: fresh.length, skipped };
}

async function collectAll(
	env: Env,
	codeFilter: string | null,
	limit: number,
): Promise<{ results: Record<string, unknown>; freshTickers: string[] }> {
	const sources = IR_SOURCES.filter(
		(s) => !codeFilter || s.code === codeFilter,
	);
	const results: Record<string, unknown> = {};
	const freshTickers: string[] = []; // 今回 written > 0 だった銘柄 (= signal-report を起動すべき対象)
	for (const src of sources) {
		try {
			const r = await collectOne(env, src, limit);
			results[src.code] = r;
			if (r.written > 0) freshTickers.push(src.code);
		} catch (e) {
			results[src.code] = { error: (e as Error).message };
		}
	}
	return { results, freshTickers };
}

// 発火した cron 式 → 取得種別。wrangler.toml の [triggers] crons と対応させること。
// Cloudflare の cron trigger 上限は5個。新規 cron は足せないので、複数ソースの収集は
// 既存 cron に相乗りさせ、scheduled() 内で順に実行する:
//   - intake (8:30/20:00):  IR + ニュースを収集し、新規があれば signal-report 起動。
//                           寄り前(8:30)のみ地合い(米国指数+日経先物)も先に取得する。
//                           引け後は 20:00 (決算・適時開示が19時台以降に出ても当夜のうちに拾うため)。
//   - prices (場中5分毎):   prices + ニュース速報を収集し、新規ニュースで signal-report 起動。
//                           さらに JST 12:30 相当スロットでは IR intake も相乗りさせる (昼の専用 cron を
//                           立てず4個に収めるため。下の scheduled() の isNoonIntakeSlot 参照)。
//   - eod    (16:00 引け後): daily + fundamentals + 決算予定日推定 をまとめて実行
const CRON_KIND: Record<string, "intake" | "prices" | "eod"> = {
	"30 23 * * *": "intake",
	"0 11 * * *": "intake",
	"*/5 0-6 * * *": "prices",
	"0 7 * * *": "eod", // JST 16:00 引け後: daily + fundamentals + earnings
};

// JST 12:30 (= UTC 03:30) のスロットか。場中 prices ループ (*/5 0-6) はどのスロットでも
// event.cron が同じ文字列なので、発火予定時刻 (scheduledTime) の UTC 時:分で昼スロットを判定する。
// 5分毎発火なので 03:30 ちょうどに鳴るが、遅延を見込んで 03:30〜03:34 の幅で拾う (1日1回に収まる)。
function isNoonIntakeSlot(scheduledTime: number): boolean {
	const d = new Date(scheduledTime);
	return (
		d.getUTCHours() === 3 && d.getUTCMinutes() >= 30 && d.getUTCMinutes() < 35
	);
}

export default {
	// Cron Trigger 発火時。event.cron でどの cron が鳴ったか判別して種別を振り分ける。
	async scheduled(
		event: ScheduledController,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<void> {
		const kind = CRON_KIND[event.cron] ?? "intake"; // 未知の cron は intake にフォールバック
		if (kind === "intake") {
			// intake cron (8:30/12:30/18:30) では IR とニュースを両方収集する。
			// 寄り前(8:30)のときだけ先に当日の地合いを D1 に取る。直後に発火する signal-judge が
			// pre-open weighting で当日 premarket 行を読めるようにするため (失敗しても収集は続行)。
			if (event.cron === "30 23 * * *") {
				await collectBackdrop(env).catch((e) =>
					console.error("backdrop failed:", e),
				);
			}
			// IR(kioxia公式) + 適時開示(全銘柄TDnet) + ニュース(全銘柄) のいずれかに新規があった
			// 銘柄をまとめて signal-report を起動する。適時開示は /pull の ir カーソルに合流する。
			const ir = await collectAll(env, null, DEFAULT_LIMIT);
			const disc = await collectDisclosures(env, null);
			const news = await collectNews(env, null);
			// 証券会社レーティング (個社別 目標株価) も intake で収集する。日報は当日夕方〜夜に
			// 出揃うため、引け後 (20:00) intake で拾うと取りこぼしが少ない。新規があれば
			// 目標株価変更も判定材料なので signal-report 起動対象に含める。
			const rat = await collectRatings(env, null);
			const fresh = [
				...new Set([
					...ir.freshTickers,
					...disc.freshTickers,
					...news.freshTickers,
					...rat.freshTickers,
				]),
			];
			console.log(
				"scheduled ir+disclosure+news+ratings done:",
				JSON.stringify({
					ir: ir.results,
					disclosure: disc.results,
					news: news.results,
					ratings: rat.results,
				}),
				"fresh:",
				fresh.join(","),
			);
			await dispatchSignalUpdate(env, fresh);
			return;
		}
		if (kind === "prices") {
			// 場中 5分毎。価格スナップショットに加え、銘柄ニュース速報も拾う (新着で即判定するため)。
			const p = await collectTimeseries(env, "prices", null);
			const news = await collectNews(env, null);
			// JST 12:30 相当スロットでは IR + 適時開示 intake も相乗りさせる (昼の専用 cron を持たないため)。
			// IR・適時開示・ニュースどの新着でも signal-report を起動するので fresh を統合して dispatch する。
			let ir: { freshTickers: string[] } | null = null;
			let disc: { freshTickers: string[] } | null = null;
			if (isNoonIntakeSlot(event.scheduledTime)) {
				ir = await collectAll(env, null, DEFAULT_LIMIT);
				disc = await collectDisclosures(env, null);
			}
			const fresh = [
				...new Set([
					...news.freshTickers,
					...(ir?.freshTickers ?? []),
					...(disc?.freshTickers ?? []),
				]),
			];
			console.log(
				"scheduled prices+news done:",
				JSON.stringify({
					prices: p,
					news: news.results,
					...(ir ? { irNoonIntake: ir } : {}),
					...(disc ? { disclosureNoonIntake: disc } : {}),
				}),
				"fresh:",
				fresh.join(","),
			);
			await dispatchSignalUpdate(env, fresh);
			return;
		}
		if (kind === "eod") {
			// 引け後の1日1回。daily + fundamentals + 次回決算予定日の推定をまとめて実行。
			const d = await collectTimeseries(env, "daily", null);
			const f = await collectTimeseries(env, "fundamentals", null);
			const e = await collectEarnings(env, null);
			console.log(
				"scheduled eod done:",
				JSON.stringify({ daily: d, fundamentals: f, earnings: e }),
			);
			return;
		}
		const res = await collectTimeseries(env, kind, null);
		console.log(`scheduled ${kind} done:`, JSON.stringify(res));
	},

	// 手動起動 (dev検証/オンデマンド)。
	async fetch(
		request: Request,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// /health は疎通確認用に無認証で残す (外形監視/curl で叩けるように)。
		if (url.pathname === "/health") {
			return new Response("ok", { status: 200 });
		}

		// それ以外の全エンドポイントは SYNC_TOKEN を要求する (未設定なら認証なし = dev)。
		// トークンは Authorization: Bearer <token> ヘッダ、または ?token=<token> クエリで受ける。
		// 公開URL (*.workers.dev) では外部から /run?dispatch=1 等で勝手にクロール/Actions起動
		// できないよう、ここで一括して弾く。
		if (!isAuthorized(request, url, env)) {
			return Response.json(
				{ ok: false, error: "unauthorized" },
				{ status: 401 },
			);
		}

		// /dispatch-test?code=285A
		//   App認証→repository_dispatch の疎通確認用。IR取得はせず、指定銘柄で強制発火する。
		//   新規の有無に関係なく signal-report (workflow_dispatch相当) を起動できるので、
		//   発火経路 (JWT署名→installation token→dispatch) のE2E確認に使う。
		if (url.pathname === "/dispatch-test") {
			const code = url.searchParams.get("code") || "285A";
			const configured = !!(
				env.GH_APP_ID &&
				env.GH_APP_PRIVATE_KEY &&
				env.GH_APP_INSTALL_ID
			);
			await dispatchSignalUpdate(env, [code]);
			return Response.json({ ok: true, dispatched: configured, ticker: code });
		}

		// /run?kind=ir|prices|daily|fundamentals|premarket&code=285A[&limit=N]
		//   kind 省略時は ir (後方互換)。time系列は limit を無視し watchlist 全件取得。
		//   premarket は地合い (米国指数+日経先物) を1回取得して D1 premarket_backdrop に書く。
		//   通常は寄り前 intake cron が自動取得するが、手動/dev 検証用に残す。
		if (url.pathname === "/run") {
			const code = url.searchParams.get("code");
			const kind = url.searchParams.get("kind") || "ir";
			if (kind === "premarket") {
				const res = await collectBackdrop(env);
				return Response.json({ ok: true, kind, result: res });
			}
			if (kind === "ir") {
				const limit = parseInt(
					url.searchParams.get("limit") || String(DEFAULT_LIMIT),
					10,
				);
				const { results, freshTickers } = await collectAll(env, code, limit);
				// 手動 /run では既定で発火しない (検証で叩いても Actions を起動させないため)。
				// &dispatch=1 を付けたときだけ、新規があれば signal-report を起動する。
				if (url.searchParams.get("dispatch") === "1")
					await dispatchSignalUpdate(env, freshTickers);
				return Response.json({
					ok: true,
					kind,
					result: results,
					fresh: freshTickers,
				});
			}
			if (kind === "news") {
				// per_ticker ニュース収集。手動では既定で発火しない (&dispatch=1 で起動)。
				const { results, freshTickers } = await collectNews(env, code);
				if (url.searchParams.get("dispatch") === "1")
					await dispatchSignalUpdate(env, freshTickers);
				return Response.json({
					ok: true,
					kind,
					result: results,
					fresh: freshTickers,
				});
			}
			if (kind === "disclosure") {
				// 全 watchlist 銘柄の TDnet 適時開示 (kabutan nmode=3) を収集。
				// 手動では既定で発火しない (&dispatch=1 で起動)。/pull の ir カーソルに合流する。
				const { results, freshTickers } = await collectDisclosures(env, code);
				if (url.searchParams.get("dispatch") === "1")
					await dispatchSignalUpdate(env, freshTickers);
				return Response.json({
					ok: true,
					kind,
					result: results,
					fresh: freshTickers,
				});
			}
			if (kind === "ratings") {
				// 証券会社レーティング (kabutan 日報) を収集 → articles に rating:% で保存。
				// 手動では既定で発火しない (&dispatch=1 で起動)。/pull の ir カーソルに合流する。
				const { results, freshTickers } = await collectRatings(env, code);
				if (url.searchParams.get("dispatch") === "1")
					await dispatchSignalUpdate(env, freshTickers);
				return Response.json({
					ok: true,
					kind,
					result: results,
					fresh: freshTickers,
				});
			}
			if (kind === "earnings") {
				// 次回決算予定日の推定 → D1 earnings に保存。
				const res = await collectEarnings(env, code);
				return Response.json({ ok: true, kind, result: res });
			}
			if (kind === "prices" || kind === "daily" || kind === "fundamentals") {
				const res = await collectTimeseries(env, kind, code);
				return Response.json({ ok: true, kind, result: res });
			}
			return Response.json(
				{ ok: false, error: `unknown kind: ${kind}` },
				{ status: 400 },
			);
		}

		// /latest?kind=ir|prices|daily|fundamentals|premarket|earnings&code=285A&n=10
		//   D1 から最新行を返す (動作確認/ローカル連携用)。kind 省略時は ir。
		if (url.pathname === "/latest") {
			const code = url.searchParams.get("code") || "285A";
			const n = parseInt(url.searchParams.get("n") || "10", 10);
			const kind = url.searchParams.get("kind") || "ir";

			// premarket は銘柄別ではなく時刻別 (ticker 列が無い) なので専用に扱う。
			//   最新 n 件を fetched_at (UTC) DESC で返し、us_indexes_json はパースして展開する。
			//   寄り前ブリーフは通常 n=1 (最新の地合い1件) で読む。暦日は持たない。
			if (kind === "premarket") {
				const { results } = await env.DB.prepare(
					`SELECT fetched_at, sox_change_pct, nasdaq_change_pct, dow_change_pct,
                  nikkei_futures_price, nikkei_contract, us_indexes_json
             FROM premarket_backdrop ORDER BY fetched_at DESC LIMIT ?`,
				)
					.bind(n)
					.all();
				const rows = (results as Record<string, unknown>[]).map((r) => {
					const { us_indexes_json, ...rest } = r;
					let us_indexes: unknown = [];
					try {
						us_indexes = JSON.parse((us_indexes_json as string) || "[]");
					} catch {
						us_indexes = [];
					}
					return { ...rest, us_indexes };
				});
				return Response.json({ ok: true, kind, rows });
			}

			// earnings は銘柄ごと1行 (ticker PK)。code 指定なら1件、なければ全銘柄を返す。
			//   signal-report は当該銘柄の next_date を読み、決算が近ければ confidence をキャップする。
			if (kind === "earnings") {
				const stmt = url.searchParams.get("code")
					? env.DB.prepare(
							"SELECT ticker, next_date, detail, fetched_at FROM earnings WHERE ticker = ?",
						).bind(url.searchParams.get("code"))
					: env.DB.prepare(
							"SELECT ticker, next_date, detail, fetched_at FROM earnings ORDER BY ticker",
						);
				const { results } = await stmt.all();
				return Response.json({ ok: true, kind, rows: results });
			}

			// 種別 → (テーブル, 並び順カラム, 取得カラム)。SQL 識別子はホワイトリストのみ。
			const LATEST: Record<
				string,
				{ table: string; order: string; cols: string }
			> = {
				ir: {
					table: "articles",
					order: "published_at",
					cols: "url, title, published_at, ir_category, r2_key, fetched_at",
				},
				prices: {
					table: "prices",
					order: "fetched_at",
					cols: "ticker, slot, price, change, change_pct, volume, quote_time, pts_price, fetched_at",
				},
				daily: {
					table: "daily",
					order: "date",
					cols: "ticker, date, open, high, low, close, change, change_pct, volume",
				},
				fundamentals: {
					table: "fundamentals",
					order: "date",
					cols: "ticker, date, per, pbr, forecast_eps, forecast_period, actual_eps, actual_period, fetched_at",
				},
			};
			const q = LATEST[kind];
			if (!q)
				return Response.json(
					{ ok: false, error: `unknown kind: ${kind}` },
					{ status: 400 },
				);

			// daily は移動平均(5MA/25MA)を各行に同梱して「線」として返す。25MA に必要な分まで
			// 余分に取得してから計算し、要求された最新 n 件に切り詰める。
			const fetchN = kind === "daily" ? Math.max(n, 25) : n;
			const { results } = await env.DB.prepare(
				`SELECT ${q.cols} FROM ${q.table} WHERE ticker = ? ORDER BY ${q.order} DESC LIMIT ?`,
			)
				.bind(code, fetchN)
				.all();

			if (kind === "daily") {
				// results は date DESC(新しい順)。各日について「その日を含む過去 w 日」の終値平均を出す。
				const asc = (results as Record<string, unknown>[]).slice().reverse(); // 古い順
				const closes = asc.map((r) => Number(r.close));
				const ma = (i: number, w: number): number | null => {
					if (i + 1 < w) return null; // 期間に満たない古い日は null
					const sum = closes.slice(i + 1 - w, i + 1).reduce((a, b) => a + b, 0);
					return Math.round((sum / w) * 100) / 100;
				};
				const withMa = asc.map((r, i) => ({
					...r,
					ma5: ma(i, 5),
					ma25: ma(i, 25),
				}));
				const rows = withMa.reverse().slice(0, n); // 新しい順に戻し、要求件数へ
				return Response.json({ ok: true, kind, rows });
			}

			return Response.json({ ok: true, kind, rows: results });
		}

		// /pull?code=285A&since=<ISO8601>&limit=N[&token=...]      … IR だけ (source LIKE 'ir:%')
		// /pull-news?code=285A&since=<ISO8601>&limit=N[&token=...]  … ニュースだけ (source LIKE 'kabutan:%')
		//   「since より後に取得した未処理分だけ」を本文(R2)込みで、古い順 (fetched_at ASC) に返す。
		//   GitHub Actions (signal-report) が Issue の 2カーソル (ir / news) をそれぞれ since に渡し、
		//   新規 IR・新規ニュースを別々に引いて統合判定する。/latest はメタのみ・published_at 順
		//   なのに対し、こちらは「判断に必要な本文」を同梱し「取りこぼさないカーソル順」で返す。
		//   since 省略時は直近 limit 件 (= 初回 / カーソル未確立時のフォールバック)。
		//   IR とニュースは同じ articles テーブルに同居するので source プレフィクスで振り分ける。
		if (url.pathname === "/pull" || url.pathname === "/pull-news") {
			const code = url.searchParams.get("code") || "285A";
			const since = url.searchParams.get("since");
			const limit = parseInt(url.searchParams.get("limit") || "20", 10);
			// /pull-news はニュース (kabutan:%) のみ。/pull は「IR一次情報」として
			// 公式IR (ir:%) と TDnet 適時開示 (tdnet:%) の両方を1本のカーソルで返す
			// (いずれも銘柄の材料で、context-builder は同じ ir カーソルで読むため)。
			// rating:% は証券会社レーティング (個社別 目標株価)。
			const sourceClause =
				url.pathname === "/pull-news"
					? "source LIKE ?"
					: "(source LIKE ? OR source LIKE ? OR source LIKE ?)";
			const sourceBinds =
				url.pathname === "/pull-news"
					? ["kabutan:%"]
					: ["ir:%", "tdnet:%", "rating:%"];

			// スイング判断に古い記事は不要。published_at が30日より古いものは保管はするが返さない
			// (取得時に一覧の下まで遡れず back-dated 記事が新しい fetched_at で入ることがあるため、
			//  カーソル順とは別に published_at の鮮度で足切りする)。published_at は YYYY-MM-DD 文字列。
			const cutoff = new Date(Date.now() - 30 * 86400_000)
				.toISOString()
				.slice(0, 10);

			// since があれば fetched_at > since で絞る。無ければ直近 limit 件を ASC で返す。
			const stmt = since
				? env.DB.prepare(
						`SELECT url, title, published_at, ir_category, r2_key, fetched_at FROM articles WHERE ticker = ? AND ${sourceClause} AND published_at >= ? AND fetched_at > ? ORDER BY fetched_at ASC LIMIT ?`,
					).bind(code, ...sourceBinds, cutoff, since, limit)
				: env.DB.prepare(
						`SELECT url, title, published_at, ir_category, r2_key, fetched_at FROM articles WHERE ticker = ? AND ${sourceClause} AND published_at >= ? ORDER BY fetched_at ASC LIMIT ?`,
					).bind(code, ...sourceBinds, cutoff, limit);
			const { results } = await stmt.all();

			// 各メタに R2 本文を同梱する。本文は判断に必須。R2 欠損は body=null で返す。
			const rows = await Promise.all(
				(results as Record<string, unknown>[]).map(async (r) => {
					let body: string | null = null;
					try {
						const obj = await env.ARTICLES.get(r.r2_key as string);
						if (obj) {
							const json = JSON.parse(await obj.text()) as { body?: string };
							body = json.body ?? null;
						}
					} catch {
						/* R2 欠損/壊れは body=null のまま (取得自体は止めない) */
					}
					return {
						url: r.url,
						title: r.title,
						published_at: r.published_at,
						ir_category: r.ir_category,
						fetched_at: r.fetched_at,
						body,
					};
				}),
			);
			return Response.json({
				ok: true,
				code,
				since: since ?? null,
				count: rows.length,
				rows,
			});
		}

		// /test-slack : Webhook疎通確認。ダミー1件を実際にSlackへ送る。
		if (url.pathname === "/test-slack") {
			if (!env.SLACK_WEBHOOK_URL) {
				return Response.json(
					{ ok: false, error: "SLACK_WEBHOOK_URL 未設定" },
					{ status: 400 },
				);
			}
			await notifySlack(env, [
				{
					ticker: "285A",
					title: "【テスト】Slack通知の疎通確認",
					url: "https://www.kioxia-holdings.com/ja-jp/news.html",
					date: "2026-06-17",
					category: "holdings",
				},
			]);
			return Response.json({ ok: true, sent: true });
		}

		return new Response(
			"stock-signals collector. routes: /run?kind=ir|news|disclosure|ratings|prices|daily|fundamentals|earnings|premarket /latest?kind= /pull?code= /pull-news?code= /health /test-slack",
			{ status: 404 },
		);
	},
};
