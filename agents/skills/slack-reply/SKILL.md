---
name: slack-reply
description: For a single ticker given as argument, answer a user's in-thread Slack reply to a prior analysis (signal-judge buy/sell call or crash-scenario pre-mortem). Read that ticker's living context, the current price/daily/premarket/earnings/margin numbers from the Worker, and the full Slack thread so far, then reply in the same thread. It does NOT modify the context — output goes back to the Slack thread only. One-shot; fired by the Worker when a user replies under an analysis post.
---

# slack-reply

A user replied in-thread to one of your earlier analyses for `<ticker>` — either a signal-judge
buy/sell call or a crash-scenario pre-mortem. Answer their reply **in that same thread**, grounded
in the living context and the current market picture. This is a focused follow-up: address what
they actually asked, using the same evidence the original call used. Don't re-run the whole
analysis unless they ask for it; don't change your earlier direction just to please them — if the
data still says what it said, hold the line and explain why. Be concise (this is a chat reply, not
a report). Match the user's language (they'll usually write 日本語).

## Inputs

A `<ticker>` plus two files are passed. `<thread-json>` is a path-or-inline JSON with the
conversation so far and where to post back — `{ channel, thread_ts, kind, replies: [{ user, text, ts
}, ...] }`. `kind` is the original analysis type (`signal-judge` / `crash-scenario`) so you know what
the user is replying to. The last entry in `replies` is the new user message you must answer; the
earlier ones are the original analysis post and any back-and-forth. The other file is the **numeric
context** JSON from `scripts/judge-context.sh` (earnings/premarket/daily/prices/margin, already
fetched & normalized — **read it**).

In detail:

1. **The Slack thread** — read every message. The first is your original analysis (the call /
   the pre-mortem); the rest is the conversation. The user's latest message is the question.
2. **Living context (`context_body`) — your primary fundamental input, read it in full.** Same
   context signal-judge/crash-scenario read. The **直近の重大トピック** list is freshest. Null → say
   `context: unavailable` and answer on price + backdrop alone.
3. **Numeric context** (`@<path>`) — the same self-describing JSON the original call used, but
   **re-fetched fresh at reply time**: the tape / premarket / margin are current, only
   `context_body` is read-only from D1. Pair top-level `market_phase` with `prices.quote_status`:
   both 寄り前 (premarket) and 引け後 (after close) read as `quote_status: closed`, so use
   `market_phase` to tell *why* the tape is stale — about to open vs already closed.
4. **Metadata** — `<ticker>` in `config/watchlist.yaml` for `name`/`sector`/`fair_per`.

## What to do

- Answer the user's actual question. If they push back on the call, weigh their point against the
  data honestly — concede where they're right, hold where the data holds, and say which.
- Stay consistent with the original `kind`: a signal-judge thread is about the buy/sell direction
  and 水準; a crash-scenario thread is about the crash paths, triggers, and defenses. Don't
  silently switch frames.
- Keep it to a few sentences unless they asked for depth. No preamble, no "great question".

## Post the reply to the thread (only output)

Pass the `<thread-json>` path and your reply; the script pulls channel/thread_ts from it and posts
back into the same thread.

```
bash scripts/post-reply.sh reply <thread-json> "<your reply>"
```

## stdout — one line, no narration

```
<ticker> reply: <one-line gist of what you answered>, slack <ok|skipped>
```
