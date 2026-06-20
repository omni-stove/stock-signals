// Cloudflare Worker: 収集モジュール共通のユーティリティ。
// 各 collect モジュール (news / disclosure / ratings / earnings / premarket /
// timeseries / index) でコピペされていた hash / sleep / fetchHtml をここに集約する。

// 指定ミリ秒だけ待つ (kabutan への連続アクセス間隔調整に使う)。
export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// URL → 短い 8桁16進ハッシュ (R2キー用)。FNV 風の 31 倍ローリング。
export function hash(s: string): string {
	let h = 0;
	for (let i = 0; i < s.length; i++) {
		h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

// URL を GET し UTF-8 文字列で返す。全ソース UTF-8 (調査済) なので TextDecoder で十分。
// env からは User-Agent だけ使うので、USER_AGENT を持つ任意の Env を受ける。
export async function fetchHtml(
	url: string,
	env: { USER_AGENT: string },
): Promise<string> {
	const res = await fetch(url, { headers: { "User-Agent": env.USER_AGENT } });
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	const buf = await res.arrayBuffer();
	return new TextDecoder("utf-8").decode(buf);
}

// in-source tests (本番ビルドでは tree-shake される。vitest.config.ts 参照)
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("hash", () => {
		it("常に 8 桁の 16 進文字列を返す", () => {
			for (const s of ["", "a", "https://kabutan.jp/stock/?code=6857"]) {
				expect(hash(s)).toMatch(/^[0-9a-f]{8}$/);
			}
		});

		it("同じ入力には同じ値 (決定的)", () => {
			expect(hash("6857")).toBe(hash("6857"));
		});

		it("異なる入力には異なる値を返す (代表ケース)", () => {
			expect(hash("6857")).not.toBe(hash("6858"));
		});
	});
}
