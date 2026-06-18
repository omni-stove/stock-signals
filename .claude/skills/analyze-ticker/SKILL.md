---
name: analyze-ticker
description: For a single ticker given as argument, watch data/queue/<ticker>/ and emit a buy/sell/hold signal to signals/<ticker>.log for each incoming article.
---

# analyze-ticker

Stays focused on a single ticker. Reads queued articles one at a time and writes a signal.

**This system is built for SWING trading (holding several days to a few weeks).**
Not day-trading, not buy-and-hold investing. Every judgment should be framed in
that time horizon. See `## Time horizon` below for what this means concretely.

## Invocation

```sh
# one cmux tab per ticker
/analyze-ticker 6857
/analyze-ticker 6920
/analyze-ticker 285A
/analyze-ticker 6981
```

The argument `<ticker>` is the symbol this instance owns.

## Output style

Per-article signals are written to `./signals/<ticker>.log` as JSONL. The terminal stays mostly quiet:

- Do not print full signal payloads to stdout.
- A one-line summary per processed article is allowed (the user finds it useful at a glance), e.g.
  ```
  [14:35] 6857 buy/medium swing  HBM tester demand
  ```
- No "starting", "done", "watcher launched" boilerplate.
- Acknowledgements ("OK", "understood") are not needed.

The user tails `signals/<ticker>.log` for full content.

## Startup sequence

1. Launch watcher in background:
   ```
   Bash(run_in_background=true): node scripts/queue-watch.ts <ticker>
   ```
   stdout line protocol (same as route-news-watch):
   - `<absolute-path>` — article JSON to process
   - `READY` — initial scan finished
   - `ERROR <msg>` — recoverable error

2. `Monitor` the watcher's stdout. For each path line, run the processing loop.

3. If the watcher dies twice in a row, emit one error line and exit.

## Input

- Cache `./config/watchlist.yaml` entry for this ticker on startup.
- Process each `./data/queue/<ticker>/<id>.json` notified by the watcher.

## Processing

For each article, emit:

```json
{
  "ts": "2026-05-21T14:35:12+09:00",
  "ticker": "6857",
  "article_id": "...",
  "signal": "buy" | "sell" | "hold",
  "confidence": "low" | "medium" | "high",
  "horizon": "swing",
  "rationale": "<2-3 short Japanese lines: why this signal>",
  "evidence_quotes": ["<up to 2 quotes from the source>"],
  "risks": "<one line: what would invalidate the call>",
  "days_to_earnings": <integer or null>
}
```

Append this object as one JSONL line to `./signals/<ticker>.log`.

`horizon` is effectively always `"swing"` in this system. Only deviate to
`"long"` when the article describes a multi-quarter structural change
(e.g. a new fab build-out) AND no near-term catalyst — and even then, the
trade is still managed on a swing timeframe; `"long"` is a tag, not an
instruction to hold indefinitely.

## Price context

Before judging each article, read the last ~20 lines of `./data/prices/<ticker>.jsonl`
(populated by `scripts/fetch-prices.ts` on a 5-minute cron). Each line has:
`price`, `change` (yen vs prev close), `change_pct`, `volume`, `quote_time`,
`pts_price`, `pts_time`.

Use it to gauge whether the news is already priced in:

- Bullish news + recent sharp run-up (e.g. `change_pct` already >+3% on rising volume)
  → likely `hold`, not `buy`. Note "already discounted" in rationale.
- Bearish news + recent steep drop → similar caution. Oversold bounces are possible
  but require corroborating articles to call `buy`.
- Flat tape (small `change_pct`, light `volume`) is the easiest case — take the
  article more at face value.
- Volume spike without matching news in the queue is itself a signal to flag
  (write a `hold` with note "unusual volume, no news yet").

**Outside trading hours (before 9:00 or after 15:30 JST), `price` is stale (= the
prev session's close).** The live signal is `pts_price`. Compute the PTS premium
yourself: `(pts_price - price) / price * 100`. Treat the same way as `change_pct`:
a PTS premium >+3% on a fresh bullish article means the market is already buying
it overnight → lean `hold` rather than chasing. `pts_price: null` means no PTS
quote (illiquid name, weekend, or pre-session) — fall back to `price`/`change_pct`
and note the absence.

If `./data/prices/<ticker>.jsonl` is missing or empty, proceed without it and
note `"price_context": "unavailable"` in `rationale` so the absence is auditable.

## Daily context (multi-day trend)

Read `./data/daily/<ticker>.jsonl` (populated by `scripts/fetch-daily.ts`,
one row per trading day with `date`, `open`, `high`, `low`, `close`, `volume`).
Use the last ~20 rows to judge the swing-relevant backdrop:

- **5MA / 25MA position.** Compute the 5-day and 25-day moving averages of
  `close`. Price above both = uptrend, between them = chop, below both =
  downtrend. Frame the article against this regime.
- **Range position.** Where is the current `price` inside the last 20 days'
  high/low? Near 20-day high → buying late is risky; near 20-day low + a
  bullish article → cleaner risk/reward.
- **Volume trend.** Compare the latest `volume` from prices.jsonl to the
  20-day average. >2× = unusual.

If `./data/daily/<ticker>.jsonl` is missing or has fewer than 5 rows, note
`"daily_context": "insufficient"` in `rationale` and proceed without it.

## Time horizon

Swing-trading frame, concretely:

- **Entry**: act on the article within the same day or next session. If the
  signal would only matter in 3+ weeks, downgrade `confidence`.
- **Hold**: assume the position lives 2 trading days to ~3 weeks. News that
  only matures over 6+ months is structural — note it but don't promote to
  `buy` on that basis alone.
- **Don't** chase intraday tape moves (<1 day) — that's out of scope.
- **Don't** anchor on multi-year theses for the entry timing.

## Earnings risk

The watchlist entry includes `next_earnings_date` (YYYY-MM-DD, may be `null`
if unknown). Compute `days_to_earnings` from today's date and include it in
the signal object.

Use it as a brake on swing horizon, not on direction:

- **≤ 5 days to earnings**: cap `confidence` at `low` regardless of news,
  unless the article IS the earnings release. Mention "earnings within N
  days" in `risks`.
- **6–14 days**: cap `confidence` at `medium`. Note the proximity in `risks`.
- **> 14 days or null**: no earnings constraint, judge normally.

When `next_earnings_date` is `null`, set `days_to_earnings: null` and add
"earnings date unknown" to `risks` so a missing date isn't silently ignored.

If `days_to_earnings` is **negative** (the configured date is in the past —
typically because nobody updated it after the last release), treat it as
"unknown": set the field to `null`, add "earnings date stale, needs update"
to `risks`, and apply no earnings constraint.

## Judgment guidelines

- **Time series matters.** Read the last ~50 lines of `./signals/<ticker>.log` and note trend continuation or reversal.
- **Never highlight high confidence from one article.** `high` requires multiple corroborating articles or fresh earnings/guidance.
- **Separate macro from idiosyncratic.** Tag "industry tailwind" vs "own-company performance" distinctly in the rationale.
- **Stale news = hold.** A rehash of already-priced material is `hold` with low confidence.

## After processing

- Move the article to `./data/archive/analyzed/<ticker>/<id>.json`.
- The queue should drain toward empty — that is the steady state.

## Anti-patterns

- Do not write directive text like "buy now" — phrase as "buy-leaning signal, because …".
- Do not collapse `rationale` to one short clause; the audit trail dies.
- Do not invent price targets — out of scope.
- Do not write multi-paragraph chat output. One short summary line per article is the maximum.
- Do not emit `"horizon": "intraday"`. This system is not for day trading.
