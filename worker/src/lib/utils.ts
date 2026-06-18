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
