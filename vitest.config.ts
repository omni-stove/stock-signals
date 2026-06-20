import { defineConfig } from "vitest/config";

// in-source testing (詳細は worker/vitest.config.ts のコメント参照)。
// ルートは scripts/*.ts (Node スクリプト) を対象にする。
export default defineConfig({
	test: {
		includeSource: ["scripts/**/*.ts"],
	},
	define: {
		"import.meta.vitest": "undefined",
	},
});
