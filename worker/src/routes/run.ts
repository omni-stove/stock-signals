// Cloudflare Worker: 手動起動 (dev検証/オンデマンド) ルート。
//   /run?kind=ir|news|disclosure|ratings|prices|daily|fundamentals|earnings|margin|premarket&code=285A[&limit=N]
//   kind 省略時は ir (後方互換)。time系列は limit を無視し watchlist 全件取得。
//   premarket は地合い (米国指数+日経先物) を1回取得して D1 premarket_backdrop に書く。
//   通常は寄り前 intake cron が自動取得するが、手動/dev 検証用に残す。
//   手動 /run では既定で発火しない (検証で叩いても Actions を起動させないため)。
//   &dispatch=1 を付けたときだけ、新規があれば signal-report を起動する。

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { collectDisclosures } from "../lib/disclosure";
import { collectEarnings } from "../lib/earnings";
import type { Env } from "../lib/env";
import { dispatchSignalUpdate } from "../lib/github-dispatch";
import { collectAll } from "../lib/ir-collect";
import { DEFAULT_LIMIT } from "../lib/ir-sources";
import { collectMargin } from "../lib/margin";
import { collectNews } from "../lib/news";
import { collectBackdrop } from "../lib/premarket";
import { collectRatings } from "../lib/ratings";
import { collectTimeseries } from "../lib/timeseries";

export const run = new Hono<{ Bindings: Env }>();

run.get("/", async (c) => {
	const env = c.env;
	const code = c.req.query("code") ?? null;
	const kind = c.req.query("kind") || "ir";
	const dispatch = c.req.query("dispatch") === "1";

	if (kind === "premarket") {
		const result = await collectBackdrop(env);
		return c.json({ ok: true, kind, result });
	}

	// 以下、IR系 (articles に貯める収集) は collectXxx が
	// { results, freshTickers } を返すので共通形で扱う。
	if (kind === "ir") {
		const limit = parseInt(c.req.query("limit") || String(DEFAULT_LIMIT), 10);
		const { results, freshTickers } = await collectAll(env, code, limit);
		if (dispatch) await dispatchSignalUpdate(env, freshTickers);
		return c.json({ ok: true, kind, result: results, fresh: freshTickers });
	}
	if (kind === "news") {
		// per_ticker ニュース収集。
		const { results, freshTickers } = await collectNews(env, code);
		if (dispatch) await dispatchSignalUpdate(env, freshTickers);
		return c.json({ ok: true, kind, result: results, fresh: freshTickers });
	}
	if (kind === "disclosure") {
		// 全 watchlist 銘柄の TDnet 適時開示 (kabutan nmode=3) を収集。/pull の ir カーソルに合流する。
		const { results, freshTickers } = await collectDisclosures(env, code);
		if (dispatch) await dispatchSignalUpdate(env, freshTickers);
		return c.json({ ok: true, kind, result: results, fresh: freshTickers });
	}
	if (kind === "ratings") {
		// 証券会社レーティング (kabutan 日報) を収集 → articles に rating:% で保存。/pull の ir カーソルに合流する。
		const { results, freshTickers } = await collectRatings(env, code);
		if (dispatch) await dispatchSignalUpdate(env, freshTickers);
		return c.json({ ok: true, kind, result: results, fresh: freshTickers });
	}
	if (kind === "earnings") {
		// 次回決算予定日の推定 → D1 earnings に保存。
		const result = await collectEarnings(env, code);
		return c.json({ ok: true, kind, result });
	}
	if (kind === "margin") {
		// 信用残 (週次) の収集 → D1 margin に保存。通常は引け後 intake cron で自動取得。
		const { results, freshTickers } = await collectMargin(env, code);
		if (dispatch) await dispatchSignalUpdate(env, freshTickers);
		return c.json({ ok: true, kind, result: results, fresh: freshTickers });
	}
	if (kind === "prices" || kind === "daily" || kind === "fundamentals") {
		const result = await collectTimeseries(env, kind, code);
		return c.json({ ok: true, kind, result });
	}
	throw new HTTPException(400, {
		res: Response.json(
			{ ok: false, error: `unknown kind: ${kind}` },
			{ status: 400 },
		),
	});
});
