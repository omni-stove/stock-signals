// Cloudflare Worker: Slack リクエスト署名検証。
//
// Slack はスラッシュコマンド / interactivity の各 POST に署名を付ける:
//   X-Slack-Request-Timestamp: <unix秒>
//   X-Slack-Signature:         v0=<hmac-sha256(signing_secret, "v0:<ts>:<rawBody>")>
// 受信側は同じ計算をして突き合わせ、5分より古い timestamp はリプレイとして拒否する。
// /slack/* は Bearer 認証 (SYNC_TOKEN) を通せない (Slack が付けられない) ので、
// なりすまし防止はこの署名検証だけが担う。検証は raw body に対して行うため、
// 呼び出し側は req.text() で取った生文字列をそのまま渡すこと (再パース後の文字列は不可)。

import type { Env } from "./env";

const FIVE_MIN = 5 * 60;

function hex(buf: ArrayBuffer): string {
	return [...new Uint8Array(buf)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// 長さの揃った hex 文字列同士を定数時間で比較する (タイミング攻撃対策)。
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

// Slack 署名を検証する。検証成功なら true。SLACK_SIGNING_SECRET 未設定時は
// 呼び出し側が 503 を返す想定なので、ここでは false を返す (検証不能 = 不許可)。
export async function verifySlackSignature(
	env: Env,
	rawBody: string,
	timestamp: string | null,
	signature: string | null,
	nowSec: number,
): Promise<boolean> {
	if (!env.SLACK_SIGNING_SECRET || !timestamp || !signature) return false;
	// 5分より古い/未来すぎる timestamp はリプレイとして拒否。
	const ts = Number(timestamp);
	if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > FIVE_MIN) return false;

	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(env.SLACK_SIGNING_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(`v0:${timestamp}:${rawBody}`),
	);
	return timingSafeEqual(`v0=${hex(mac)}`, signature);
}
