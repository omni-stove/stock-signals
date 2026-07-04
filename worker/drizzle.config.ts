// drizzle-kit 設定。スキーマの真の情報源は src/lib/schema.ts のみ。
//
// 運用:
//   pnpm db:generate            … schema.ts を編集したら差分 SQL を drizzle/ に生成
//   pnpm db:migrate:remote      … 生成済み migration をリモート D1 に適用 (push 時は CI が自動適用)
// これにより従来の手書き schema.sql 二重管理を廃し、PK 変更等も drizzle-kit が
// 差分 migration として生成する (全 DROP を伴う初期化スクリプトを流す事故を防ぐ)。
//
// migration の適用は wrangler d1 migrations apply が行う (out=drizzle/ を読む)。
// よって drizzle-kit 側に D1 への接続情報 (driver: d1-http のトークン類) は不要。
import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	schema: "./src/lib/schema.ts",
	out: "./drizzle",
});
