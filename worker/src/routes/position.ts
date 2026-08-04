// Cloudflare Worker: ポジション事実レポート (position-report ワークフロー) 用バンドル (要 SYNC_TOKEN 認証)。
//   GET /position-users            … 建玉を持つユーザーの userId 配列。fan-out が matrix に展開する。
//   GET /position-context?userId=  … そのユーザーの全建玉 × 最新材料ブリーフ × 当日 close × 含み損益 (決定論)。
//                                    LLM がこれを読んで建玉に関係する材料・リスクを事実として並べる。
//
// 取得は D1 直読み (サブリクエストなし)。正規化は lib/position-report.ts に集約。judge-context と
// 同じ流儀で、数値は Worker 側 (決定論) で済ませ、skill には curl を叩かせず材料の紐付けだけを
// させる。userId は positions に実在するものだけが context を返す (空配列なら 404)。

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../lib/env";
import {
	buildPositionContext,
	listPositionUsers,
} from "../lib/position-report";

export const position = new Hono<{ Bindings: Env }>();

position.get("/position-users", async (c) => {
	const users = await listPositionUsers(c.env);
	return c.json({ ok: true, users });
});

position.get("/position-context", async (c) => {
	const userId = c.req.query("userId");
	if (!userId) {
		throw new HTTPException(400, {
			res: Response.json(
				{ ok: false, error: "userId required" },
				{ status: 400 },
			),
		});
	}
	const positions = await buildPositionContext(c.env, userId);
	// 実在しない userId / 建玉ゼロは 404。ワークフローはこれを見て当該ユーザーをスキップする
	// (LLM を空 context で走らせない)。matrix は /position-users が返した実在 userId 由来なので
	// 通常は到達しないが、dispatch とジョブ開始の間に建玉が消えた場合の防御。
	if (positions.length === 0) {
		throw new HTTPException(404, {
			res: Response.json(
				{ ok: false, error: `no positions for ${userId}` },
				{ status: 404 },
			),
		});
	}
	return c.json({ ok: true, userId, positions });
});
