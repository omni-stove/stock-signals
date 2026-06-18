// Cloudflare Worker: 簡易認証ミドルウェア。index.ts の isAuthorized を Hono 化。
// SYNC_TOKEN 未設定なら常に許可 (dev / wrangler dev)。設定済みなら
// Authorization: Bearer <token> ヘッダ、または ?token=<token> クエリのどちらかが一致すれば許可。
// 長さの異なる文字列は != で即 false になるが、トークンは固定長の Secret 前提なので
// タイミング差は実害なし (簡易比較)。/health は app.use の適用前に分岐させて除外する。

import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../lib/env";

export const auth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
	const env = c.env;
	if (env.SYNC_TOKEN) {
		const authHeader = c.req.header("authorization") || "";
		const m = authHeader.match(/^Bearer\s+(.+)$/i);
		const presented = (m ? m[1] : null) ?? c.req.query("token") ?? null;
		if (presented !== env.SYNC_TOKEN) {
			// 公開URL (*.workers.dev) では外部から /run?dispatch=1 等で勝手にクロール/Actions起動
			// できないよう、ここで一括して弾く。
			throw new HTTPException(401, {
				res: Response.json(
					{ ok: false, error: "unauthorized" },
					{ status: 401 },
				),
			});
		}
	}
	await next();
});
