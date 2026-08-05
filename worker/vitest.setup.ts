// Node には HTMLRewriter が無いので、同一エンジン (lol-html) の WASM ビルドを注入する。
// 本番 Worker ではランタイム組み込みの HTMLRewriter (ネイティブ実装) がそのまま使われる。
import { HTMLRewriter } from "htmlrewriter";

(globalThis as unknown as { HTMLRewriter?: unknown }).HTMLRewriter ??=
	HTMLRewriter;
