// Cloudflare Worker: GitHub App 認証 + repository_dispatch 発火。
//
// 新規IR/ニュースを取得したとき、GitHub Actions (signal-report) を repository_dispatch で
// 起動する。cron で当てずっぽうに起動して0件を引く構造を避け、「新規があるときだけ」LLMを動かす。
//
// Cloudflare Workers の Web Crypto (crypto.subtle) で RS256 JWT を署名し、installation
// access token に交換して叩く。外部ライブラリ不要。index.ts から dispatchSignalUpdate を呼ぶ。

import type { Env } from "./env";

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

// 任意の event_type を単一銘柄で repository_dispatch する汎用版。
// dispatchSignalUpdate (signal-update 固定 + デバウンス) と JWT/installation token の
// 取得経路を共有しつつ、Slack スラッシュコマンド経由の crash-scenario など
// デバウンス不要な単発発火に使う。App 認証情報が揃っていなければ false (no-op)。
// 成否を返すので、呼び出し側 (Slack ルート) は失敗時にユーザーへ通知できる。
export async function dispatchEvent(
	env: Env,
	eventType: string,
	ticker: string,
	nowMs: number,
): Promise<boolean> {
	return dispatchEventPayload(env, eventType, { ticker }, nowMs);
}

// dispatchEvent の汎用版。client_payload を丸ごと渡せる。Slack スレッド返信 (slack-reply) は
// ticker だけでなく channel / thread_ts / 返信本文も Action に渡す必要があるため、これを使う。
// App 認証情報が揃っていなければ false (no-op)。成否を返すので呼び出し側で通知できる。
export async function dispatchEventPayload(
	env: Env,
	eventType: string,
	clientPayload: Record<string, unknown>,
	nowMs: number,
): Promise<boolean> {
	if (!env.GH_APP_ID || !env.GH_APP_PRIVATE_KEY || !env.GH_APP_INSTALL_ID)
		return false;
	const repo = env.GITHUB_REPO || "omni-stove/stock-signals";
	try {
		const nowSec = Math.floor(nowMs / 1000);
		const jwt = await makeAppJwt(env.GH_APP_ID, env.GH_APP_PRIVATE_KEY, nowSec);
		const token = await getInstallationToken(jwt, env.GH_APP_INSTALL_ID);
		const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
			method: "POST",
			headers: {
				...GH_HEADERS,
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			// event_type は workflow の on.repository_dispatch.types と一致させる。
			body: JSON.stringify({
				event_type: eventType,
				client_payload: clientPayload,
			}),
		});
		if (!res.ok) {
			console.error(
				`dispatchEvent failed (${eventType}): HTTP ${res.status} ${await res.text()}`,
			);
			return false;
		}
		return true;
	} catch (e) {
		console.error(`dispatchEvent error: ${(e as Error).message}`);
		return false;
	}
}

// 場中 dispatch のデバウンス窓 (ミリ秒)。同一銘柄をこの窓以内に二度撃たない。
// 5分毎 cron の3スロット相当。短時間に複数の新着ニュースが出ても1サイクルに束ねる。
const INTRADAY_DEBOUNCE_MS = 15 * 60 * 1000;

// 新規IR or ニュースを取得したとき signal-report ワークフローを repository_dispatch で起動する。
// 判定は IR+ニュース両方の最新状態を読むので、どちらの新着が引き金でも同じイベント
// (signal-update) で発火する。銘柄ごとに別ジョブにして concurrency(cancel-in-progress) を
// 銘柄単位で効かせるため、1銘柄=1 dispatch で撃つ (client_payload.ticker は単一銘柄)。
// App 認証情報が揃っていなければ no-op (best-effort、発火失敗で収集は止めない)。
export async function dispatchSignalUpdate(
	env: Env,
	tickers: string[],
	// 場中 (prices cron) からの呼び出しでは true。intraday_dispatch を参照して
	// デバウンス窓以内の銘柄を間引き、実際に撃った銘柄だけ last_dispatch_at を更新する。
	// intake (寄り前/引け後) からは false (常に全銘柄撃つ重要判定)。
	debounce = false,
): Promise<void> {
	if (tickers.length === 0) return;
	if (!env.GH_APP_ID || !env.GH_APP_PRIVATE_KEY || !env.GH_APP_INSTALL_ID)
		return;
	const repo = env.GITHUB_REPO || "omni-stove/stock-signals";
	// Workers 内は Date.now() が使える (collectOne 等でも new Date() を使用済み)。
	const nowMs = Date.now();
	let targets = tickers;
	if (debounce) {
		const placeholders = tickers.map(() => "?").join(",");
		const { results } = await env.DB.prepare(
			`SELECT ticker, last_dispatch_at FROM intraday_dispatch WHERE ticker IN (${placeholders})`,
		)
			.bind(...tickers)
			.all<{ ticker: string; last_dispatch_at: string }>();
		const lastByTicker = new Map(
			results.map((r) => [r.ticker, Date.parse(r.last_dispatch_at)]),
		);
		targets = tickers.filter((t) => {
			const last = lastByTicker.get(t);
			return last === undefined || nowMs - last >= INTRADAY_DEBOUNCE_MS;
		});
		const skipped = tickers.filter((t) => !targets.includes(t));
		if (skipped.length > 0) {
			console.log(`intraday dispatch debounced: ${skipped.join(",")}`);
		}
		if (targets.length === 0) return;
	}
	try {
		const nowSec = Math.floor(nowMs / 1000);
		const jwt = await makeAppJwt(env.GH_APP_ID, env.GH_APP_PRIVATE_KEY, nowSec);
		const token = await getInstallationToken(jwt, env.GH_APP_INSTALL_ID);
		// 銘柄ごとに dispatch (concurrency group を銘柄単位にするため)。
		const nowIso = new Date(nowMs).toISOString();
		for (const ticker of targets) {
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
				continue;
			}
			// 場中のみ: 撃てた銘柄だけデバウンス時刻を更新する (失敗分は窓を進めず次スロットで再挑戦)。
			if (debounce) {
				await env.DB.prepare(
					`INSERT OR REPLACE INTO intraday_dispatch (ticker, last_dispatch_at) VALUES (?, ?)`,
				)
					.bind(ticker, nowIso)
					.run();
			}
		}
	} catch (e) {
		console.error(`dispatch error: ${(e as Error).message}`);
	}
}
