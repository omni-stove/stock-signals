---
name: slack-reply
description: For one ticker, answer a user's in-thread Slack reply to a prior signal-judge or crash-scenario analysis. It does NOT modify the context. One-shot; fired by the Worker when a user replies under an analysis post.
---

# slack-reply

A user replied in-thread to your earlier analysis for `<ticker>` (a signal-judge call or a
crash-scenario pre-mortem). Match the user's language (usually 日本語).

## Inputs

A `<ticker>`, two files to **read**, and an `out=<path>` file to **write** your reply to. Do not
post to Slack; do not run any script — write the reply to `out` and stop.

`<thread-json>` is `{ channel, thread_ts, kind, replies: [...], positions }`. `replies` is
`[{ user, text, ts }, ...]`; `kind` (`signal-judge` / `crash-scenario`) is what the user is replying
to; the last `replies` entry is the question to answer, the earlier ones the original analysis and
any back-and-forth.

`positions` is the user's own holdings for `<ticker>`: `{ status, ref_price, positions: [{ account,
side, avg_price, qty, pnl_pct }, ...] }`. `status: none` → no holdings. `pnl_pct` is from
`ref_price`; null when no price was available.

`profile` is the user's own trading preferences, set via `/profile`: `{ status, risk_tolerance,
hold_style, max_position_pct, note }`. `status: none` → not set. `risk_tolerance` is `low`/`mid`/`high`,
`hold_style` is `swing`/`day`/`mid_long` (玉の持ち方の基本), `max_position_pct` a per-name size cap (%),
`note` free-text 特記事項 (e.g. 「玉は分割で建てる」「決算跨ぎは持たない」). Any field may be null.

The other file is the **numeric context** JSON from `/judge-context` (the same the original call
used, re-fetched fresh — tape/premarket/margin are current, `context_body` is read-only from D1):

- **`context_body`** is your primary fundamental input; 直近の重大トピック is freshest. Null → say
  `context: unavailable` and answer on price + backdrop alone.
- **`ticker_note`**: qualifies the other inputs.
- Pair **`market_phase`** with `prices.quote_status` to tell why a `closed` tape is stale — about to
  open (premarket) vs already closed.
- `<ticker>`'s `name`/`sector`/`fair_per` are in `worker/src/lib/watchlist.ts`.

## What to do

- Answer the user's actual question; don't re-run the whole analysis unless asked. If they push
  back on the call, weigh their point against the data honestly — concede where they're right, hold
  where the data holds, and say which. Don't shift your earlier direction to please them.
- When holdings are present, weigh the answer against the user's own entry, size, and unrealized
  P&L, not just the generic call. Don't assume holdings beyond what's registered.
- When `profile` is set, frame the answer to the user's risk tolerance, hold style, size cap, and
  特記事項. Don't override the data — surface where their preference and the call diverge.
- Stay consistent with the original `kind`: a signal-judge thread is about the buy/sell direction
  and 水準; a crash-scenario thread is about the crash paths, triggers, and defenses. Don't
  silently switch frames.
- Keep it to a few sentences unless they asked for depth; no preamble.

## Output — write the reply to the `out` file

Write your reply text to the `out=<path>` file (the reply body only — no headline, no JSON).

Then one stdout line, no narration:

```
<ticker> reply: <one-line gist of what you answered>
```
