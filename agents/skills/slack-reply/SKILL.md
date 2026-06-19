---
name: slack-reply
description: For a single ticker given as argument, answer a user's in-thread Slack reply to a prior analysis (signal-judge buy/sell call or crash-scenario pre-mortem). Read that ticker's standing GitHub Issue body (the living context maintained by context-builder), the current price/daily/premarket/earnings/margin numbers from the Worker, and the full Slack thread so far, then reply in the same thread. It does NOT modify the Issue — output goes back to the Slack thread only. One-shot; fired by the Worker when a user replies under an analysis post.
---

# slack-reply

A user replied in-thread to one of your earlier analyses for `<ticker>` — either a signal-judge
buy/sell call or a crash-scenario pre-mortem. Answer their reply **in that same thread**, grounded
in the living context and the current market picture. This is a focused follow-up: address what
they actually asked, using the same evidence the original call used. Don't re-run the whole
analysis unless they ask for it; don't change your earlier direction just to please them — if the
data still says what it said, hold the line and explain why. Be concise (this is a chat reply, not
a report). Match the user's language (they'll usually write 日本語).

## Invocation

```
/slack-reply <ticker> -- <thread-json> @<numeric-context.json>
```

After `--`: `<thread-json>` is a path-or-inline JSON with the conversation so far and where to post
back — `{ channel, thread_ts, kind, replies: [{ user, text, ts }, ...] }`. `kind` is the original
analysis type (`signal-judge` / `crash-scenario`) so you know what the user is replying to. The last
entry in `replies` is the new user message you must answer; the earlier ones are the original
analysis post and any back-and-forth. `@<path>` is the **numeric context** JSON from
`scripts/judge-context.sh` (earnings/premarket/daily/prices/margin, already fetched & normalized —
**read it**).

## Inputs

1. **The Slack thread** — read every message. The first is your original analysis (the call /
   the pre-mortem); the rest is the conversation. The user's latest message is the question.
2. **Living context (the Issue body) — your primary fundamental input, read it in full:**
   ```
   gh issue list --label ir-report --label "ticker:<ticker>" --state open --json number,body --limit 1
   ```
   Same Issue signal-judge/crash-scenario read. The **直近の重大トピック** list is freshest. No Issue →
   say `context: unavailable` and answer on price + backdrop alone.
3. **Numeric context** (`@<path>`) — current price/MA/range position, days_to_earnings, 信用残,
   premarket backdrop (SOX etc.). The same numbers the original call used.
4. **Metadata** — `<ticker>` in `config/watchlist.yaml` for `name`/`sector`/`fair_per`.

## What to do

- Answer the user's actual question. If they push back on the call, weigh their point against the
  data honestly — concede where they're right, hold where the data holds, and say which.
- Stay consistent with the original `kind`: a signal-judge thread is about the buy/sell direction
  and 水準; a crash-scenario thread is about the crash paths, triggers, and defenses. Don't
  silently switch frames.
- Keep it to a few sentences unless they asked for depth. No preamble, no "great question".

## Post the reply to the thread (only output)

Post back into the **same thread** via the Worker's `/slack/post` with `thread_ts` set. The Worker
does not re-record thread replies, so the user can keep the conversation going (their next reply
re-fires this skill).

```
curl -s -X POST "$WORKER_URL/slack/post" \
  -H "Authorization: Bearer $SYNC_TOKEN" -H 'Content-Type: application/json' -d '{
  "channel": "<channel from thread-json>",
  "thread_ts": "<thread_ts from thread-json>",
  "text": "<your reply>"
}'
```

Use `channel` and `thread_ts` exactly as given in `<thread-json>`. If `/slack/post` returns 503
(`SLACK_BOT_TOKEN` unset) the feature is off — print the reply to stdout instead.

## stdout — one line, no narration

```
<ticker> reply: <one-line gist of what you answered>, slack <ok|skipped>
```
