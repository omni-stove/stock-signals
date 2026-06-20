import { defineConfig } from "vitest/config";

// in-source testing: 各モジュール末尾の `if (import.meta.vitest) { ... }` ブロックを
// テストとして拾う。module-private な関数 (parser 等) を export せずに検証できる。
// 本番 (wrangler deploy / esbuild) では import.meta.vitest が undefined になるよう
// define で潰し、テストブロックは dead-code として tree-shake される。
export default defineConfig({
	test: {
		includeSource: ["src/**/*.ts"],
	},
	define: {
		"import.meta.vitest": "undefined",
	},
});
