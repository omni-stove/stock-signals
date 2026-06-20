// D1 を Drizzle でラップする唯一のエントリ。各 lib は drizzle(env.DB) を直接呼ばず
// この db(env) を通すことで、スキーマ (schema.ts) の bind を一箇所に集約する。
//
// 段階移行中: Drizzle 化していない lib は引き続き env.DB.prepare(...) を生で使ってよい。
// drizzle のハンドルは生 D1 と同じ env.DB を共有するので、同一テーブルに混在して書いても問題ない。

import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function db(d1: D1Database) {
	return drizzle(d1, { schema });
}
