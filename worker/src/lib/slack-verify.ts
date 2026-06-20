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

// in-source tests (本番ビルドでは tree-shake される。vitest.config.ts 参照)
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("timingSafeEqual", () => {
		it("一致する文字列は true", () => {
			expect(timingSafeEqual("v0=abc", "v0=abc")).toBe(true);
		});
		it("1 文字違いは false", () => {
			expect(timingSafeEqual("v0=abc", "v0=abd")).toBe(false);
		});
		it("長さ違いは false", () => {
			expect(timingSafeEqual("v0=abc", "v0=abcd")).toBe(false);
		});
	});

	describe("verifySlackSignature", () => {
		const secret = "8f742231b10e8888abcd99yyyzzz85a5"; // Slack 公式ドキュメントの例
		const env = { SLACK_SIGNING_SECRET: secret } as Env;
		const rawBody = "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3B";
		const timestamp = "1531420618";
		const now = 1531420618;

		// 正しい署名を上記入力から動的に算出する (テストの自己整合性確保)。
		async function correctSignature(): Promise<string> {
			const key = await crypto.subtle.importKey(
				"raw",
				new TextEncoder().encode(secret),
				{ name: "HMAC", hash: "SHA-256" },
				false,
				["sign"],
			);
			const mac = await crypto.subtle.sign(
				"HMAC",
				key,
				new TextEncoder().encode(`v0:${timestamp}:${rawBody}`),
			);
			return `v0=${hex(mac)}`;
		}

		it("正しい署名・新しい timestamp なら true", async () => {
			const sig = await correctSignature();
			expect(
				await verifySlackSignature(env, rawBody, timestamp, sig, now),
			).toBe(true);
		});

		it("署名が改竄されていれば false", async () => {
			const sig = await correctSignature();
			const tampered = `${sig.slice(0, -1)}${sig.endsWith("0") ? "1" : "0"}`;
			expect(
				await verifySlackSignature(env, rawBody, timestamp, tampered, now),
			).toBe(false);
		});

		it("5 分より古い timestamp はリプレイとして拒否", async () => {
			const sig = await correctSignature();
			expect(
				await verifySlackSignature(env, rawBody, timestamp, sig, now + 301),
			).toBe(false);
		});

		it("SLACK_SIGNING_SECRET 未設定なら false", async () => {
			const sig = await correctSignature();
			const noSecret = { SLACK_SIGNING_SECRET: "" } as Env;
			expect(
				await verifySlackSignature(noSecret, rawBody, timestamp, sig, now),
			).toBe(false);
		});

		it("timestamp / signature が null なら false", async () => {
			expect(await verifySlackSignature(env, rawBody, null, "v0=x", now)).toBe(
				false,
			);
			expect(
				await verifySlackSignature(env, rawBody, timestamp, null, now),
			).toBe(false);
		});
	});
}
