---
name: premarket-brief
description: Once each morning before the open, read the day's market backdrop (US indices, Nikkei futures) plus recent daily/prices/fundamentals for all watchlist tickers from the Worker, and post a single pre-open brief to Slack with a per-ticker lean for today's session. One-shot; designed for GitHub Actions cron.
---

# premarket-brief

Runs **once per morning, before the 09:00 JST open** (GitHub Actions cron at
JST 08:30). It looks at every watchlist ticker together and posts **one
cross-sectional brief** describing today's expected session.

**This is the closest the system gets to "how will it move today".** Be honest
about its limits (see `## Honesty`). The output is a *lean* — a probabilistic
tilt for the session — not a price prediction.

All data comes from the **Worker API** (`$WORKER_URL`); this skill reads no
local data files. It runs once, posts one Slack message, prints one summary
line, and exits.

## Invocation

```
/premarket-brief
```

No argument. It always covers all tickers in `config/watchlist.yaml` (read from
the repo, same as ir-report).

## Inputs (all via the Worker API)

### 1. Today's market backdrop

```
curl -s "$WORKER_URL/latest?kind=premarket&n=1"
```

Response: `{ ok, kind, rows: [{ date, fetched_at, sox_change_pct,
nasdaq_change_pct, dow_change_pct, nikkei_futures_price, nikkei_contract,
us_indexes }] }`. `us_indexes` is the per-index detail (price / change /
change_pct / reference time).

- The brief workflow triggers `/run?kind=premarket` just before this skill, so a
  fresh row for today should exist. If `rows` is empty or `date` is not today,
  note it (`"premarket_data": "stale"` / `"unavailable"`) and proceed with what
  exists — the indices are last night's close, so a one-day-stale row is still
  informative but say so.

### 2. Per-ticker recent context

For each watchlist code (`config/watchlist.yaml`):

```
curl -s "$WORKER_URL/latest?kind=daily&code=<code>&n=20"
curl -s "$WORKER_URL/latest?kind=prices&code=<code>&n=20"
curl -s "$WORKER_URL/latest?kind=fundamentals&code=<code>&n=1"
```

- daily: each row carries `ma5` / `ma25` (computed server-side). Read price vs
  those, position in the 20-day range, volume trend.
- prices: last close + any `pts_price` (live outside hours) vs the close.
- fundamentals: latest `per` / `forecast_eps`.

## How to weight the inputs

The **session backdrop dominates the open**, roughly in this order. State which
factors drove each lean.

1. **SOX `sox_change_pct`** — primary driver for the semiconductor names
   (285A Kioxia, 6857 Advantest, 6920 Lasertec). A strong SOX night (e.g.
   > +3%) is a broad tailwind; a sharp drop is a headwind. 6981 (Murata) is an
   electronic-components (MLCC) name — apply SOX more loosely and weight its own
   trend/news.
2. **Nikkei futures** — overall market gap direction (`nikkei_futures_price`).
3. **Daily trend / range position** — is today's expected gap extending an
   established move or fighting it (price vs ma5/ma25, 20-day range).
4. **PTS premium / fresh idiosyncratic context** — a large PTS premium over the
   close, or an obvious recent run, can mean good backdrop is already priced in.

## Output

Post **one Slack message** to `$SLACK_WEBHOOK_URL` (same mechanism as
ir-report). If `$SLACK_WEBHOOK_URL` is unset, skip the POST and only print the
stdout summary.

```
curl -s -X POST "$SLACK_WEBHOOK_URL" -H 'Content-Type: application/json' -d '{
  "text": "🌅 premarket <date> SOX<sox%> | <one-line tone>",
  "blocks": [ ... per-ticker lean lines ... ]
}'
```

The message body should contain, per watchlist ticker:
- `ticker` and a `lean` (`up` / `down` / `neutral`) + `confidence`
  (`low` / `medium` / `high`)
- 1-2 short Japanese lines of `drivers` (which inputs drove the lean)
- one `watch` line: what to watch at the open / what would invalidate the lean

Cover **every watchlist ticker every time**, even neutral ones.

`lean` is the **session direction tilt**, not a buy/sell order — keep it
distinct from analyze-ticker's `signal`.

## Output style (stdout)

The terminal stays quiet. Print **one** summary line, e.g.:

```
[08:30] premarket SOX+5.5% risk-on  6857↑med 6920↑med 285A↑low slack ok
```

## Honesty

- The open's *direction* is barely better than a coin flip even with this data.
  What you can produce is a **tilt + the reasoning**, so the user reads the tape
  at 09:00 already knowing what to expect and what would surprise them.
- **Do not invent price targets or predict the close.** The lean is for the open
  and the first part of the session only.
- A strong SOX night does **not** guarantee a green open — note when a name has
  already run hard into the news (priced in via a PTS premium / multi-day run).
- When inputs disagree (e.g. SOX up but the ticker is extended above ma25 on a
  long run), say so and lean `neutral` rather than forcing a direction.

## Relation to other skills

- This brief is the **morning, cross-sectional** view. `analyze-ticker` remains
  the **intraday, per-article** view and keeps writing to `signals/<ticker>.log`.
- Pre-open order imbalance (kehai) is intentionally **not** used: the open is not
  reliably predictable, so the brief leans on last night's confirmed backdrop
  (US indices + Nikkei futures) plus each ticker's trend.
