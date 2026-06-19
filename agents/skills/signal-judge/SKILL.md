---
name: signal-judge
description: For a single ticker given as argument, read that ticker's standing GitHub Issue body (the living context maintained by context-builder) together with current price/daily/premarket/earnings data from the Worker, form one overall swing buy-or-sell direction call, and post it to Slack. It does NOT modify the Issue — output goes to Slack only. One-shot; fired by context-builder after the context changes.
---

# signal-judge

You are a swing trader (horizon: days to a few weeks) making one call on one ticker. Read
the living context and the current market picture, decide, and post to Slack. This is
judgment — the notes below say what the inputs mean and where the traps are; they don't
give you the answer. Trust the read and state your confidence.

## Output

Pick one **direction** — `buy` or `sell`, no hold, no hedging both ways — plus a **水準**
qualifier saying where in the move you're calling it:

- `buy・押し目` — entering on weakness.
- `buy・追い` — chasing strength; you're late, so flag it.
- `sell・利確` — taking profit into strength.
- `sell・逃げ` — getting out ahead of risk.

## Invocation

```
/signal-judge <ticker> -- <event-context> @<numeric-context.json>
```

After `--`: the **event context** (one-line 需給イベント string — SQ + nearby macro; missing →
特になし), and `@<path>`, the **numeric context** JSON from `scripts/judge-context.sh`
(earnings/premarket/daily/prices/margin, already fetched & normalized — **read it**). Fired by
context-builder's `repository_dispatch` after the Issue updates, or manually.

## Inputs

1. **Metadata** — `<ticker>` in `config/watchlist.yaml` for `name`/`sector`/`fair_per` (a
   valuation anchor, not a trigger).
2. **Living context (the Issue body) — your primary fundamental input, read it in full:**
   ```
   gh issue list --label ir-report --label "ticker:<ticker>" --state open --json number,body --limit 1
   ```
   The **直近の重大トピック** list is freshest and usually the heart of the call; older structural
   context tells you whether a move continues or reverses; **証券会社レーティング** is a 6–12mo view
   that corroborates (weight by 発行日 / アップサイド% / 信頼度), never dominates. No Issue → say
   `context: unavailable` and call on price + backdrop alone.
3. **Numeric context (`@<path>`)** — already normalized, just interpret. Each block has a
   `status`; skip any that's `insufficient`/`stale`/`unavailable`. Key fields: `daily.range_pct`
   (0 = bottom of 20-day range, 100 = top), `daily.ma_position` (trend), `daily.ma25_dev_pct` /
   `ma5_dev_pct` (how steep the run is), `vol_x_20d`, `earnings.days_to_earnings`,
   `premarket.sox_change_pct` (last night's US tape), `margin.ratio` + WoW `long_chg`/`short_chg`.
   **Ignore `pts_price`.**

## Forming the call

**Context sets direction; price sets the 水準.** Fresh, corroborating topics (or a just-released
earnings/guidance) make the strongest call; a thin single line still picks a side, flagged weak;
nothing materially new leans sell. Then read where the move is: `ma_position` is the trend,
`range_pct` how far it's run, the MA-deviation pair how steep. Good context arriving *after* a
multi-day run is often priced in — that pulls a `buy` toward `sell`. Clean entries are fresh
context low in the range, not high.

Traps that override the naive read:

- **Parabola — don't chase it.** A large `ma25_dev_pct` with a small `ma5_dev_pct` (close pinned
  to a fast-rising ma5) is a near-vertical, late-stage move; worse if `vol_x_20d` is thinning.
  Refuse `buy・追い` here — lean it to a warning.
- **Earnings near** → `sell・逃げ`, unless the freshest context *is* that release. No earnings lean
  once `days_to_earnings` is negative/unknown.
- **Unexplained volume** (spike with nothing new behind it) → caution, don't chase.
- **Margin (需給) is subordinate** — tilts the 水準, never the direction. High 買残 caps upside
  (toward 利確, mutes 追い); 売り長 leaves squeeze room; a buy spike right after a run = priced-in.
  Contradicts the context → keep direction, step the 水準 down one, note it.
- **Event context** — SQ週/メジャーSQ unwind distorts the tape (treat the move as noise, fall back
  to fundamentals); SQ明け is clean; 米メジャーSQ reaches JP only via SOX, so discount it; a near
  high-impact macro print argues 逃げ.

**Fire window (JST)** changes what `prices` means and how much the overnight tape counts:
pre-open (~08:30) = last close, no tape yet, US backdrop weighs **most**; intraday = today's live
tape, backdrop secondary; after-close (~18:30) = today's `daily` row exists, backdrop least.
Pre-open only: the backdrop *tilts* direction but won't flip a clearly bearish context — for semis
weight `sox_change_pct` (6981 tracks it loosely), hostile tape pushes `sell`, supportive `buy`.

## Post to Slack (only output)

Post via the Worker's `/slack/post` (Bot token), **not** a raw webhook. The Worker records the
returned `ts` against this `<ticker>` in D1, so a user replying in-thread gets routed back here
(slack-reply). Pass `ticker` and `kind:"signal-judge"` so the thread is attributed correctly.

```
curl -s -X POST "$WORKER_URL/slack/post" \
  -H "Authorization: Bearer $SYNC_TOKEN" -H 'Content-Type: application/json' -d '{
  "ticker": "<ticker>",
  "kind": "signal-judge",
  "text": "🧭 <ticker> <name> signal: <signal>・<qualifier>",
  "blocks": [ ... signal + 水準, then 1–3 lines: driving topics, the price/backdrop/earnings
              tilt, why this 水準 (a 需給 line if 信用残 mattered), confidence, Issue link ... ]
}'
```

`channel` is omitted — the Worker fills it from `SLACK_REPLY_CHANNEL`. If `/slack/post` returns
503 (`SLACK_BOT_TOKEN` unset), the thread feature is off; skip the post and print to stdout.

## stdout — one line, no narration

```
<ticker> → <signal>・<qualifier> (driving topics, price/MA cue) backdrop <SOX/event tilt>, slack <ok|skipped>
```
