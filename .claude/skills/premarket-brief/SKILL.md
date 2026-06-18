---
name: premarket-brief
description: Once each morning before the open, read the day's market backdrop (US indices, Nikkei futures, pre-open order imbalance) plus recent news/daily/fundamentals for all watchlist tickers, and write a single pre-open brief to signals/premarket.log with a per-ticker lean for today's session.
---

# premarket-brief

Runs **once per morning, before the 09:00 JST open**. Unlike `analyze-ticker`
(news-driven, one signal per article, runs all day), this is a **one-shot
cross-sectional brief**: it looks at every watchlist ticker together and writes
one record describing today's expected session.

**This is the closest the system gets to "how will it move today".** Be honest
about its limits (see `## Honesty` below). The output is a *lean* — a
probabilistic tilt for the session — not a price prediction.

## Invocation

```sh
# one cmux tab, run after the 8:55 kehai cron has populated today's premarket file
/premarket-brief
```

No argument. It always covers all tickers in `config/watchlist.yaml`.

This is **not** a watcher. It runs, writes one record, prints one summary line,
and exits. Re-running the same morning should overwrite/replace the day's record
rather than appending a duplicate (see `## Output`).

## Inputs (read all, in this order)

1. **Today's market backdrop** — `data/premarket/<today>.jsonl` (JST date).
   - The `premarket` record (no `kind`): `us_indexes` (SOX / Nasdaq / Dow with
     `change_pct`), `nikkei_futures.price`, and the summary `sox_change_pct`.
   - The `kehai` record (`kind: "kehai"`): `watchlist_kehai[]` — per-ticker
     pre-open `kehai_price`, `change_pct`, `buy_shares`, `sell_shares`, and
     `imbalance` (buy − sell). An **empty** `watchlist_kehai` means no watchlist
     ticker moved ≥±3% pre-open — itself the signal "no big pre-open imbalance".
   - If the file or either record is missing, note it and proceed with what
     exists (`"premarket_data": "partial"` / `"unavailable"`).

2. **Per-ticker recent context** for each watchlist code:
   - `data/daily/<code>.jsonl` — last ~20 rows. Compute 5MA/25MA position and
     20-day range position (same method as analyze-ticker).
   - `data/prices/<code>.jsonl` — last close + any PTS premium.
   - `data/fundamentals/<code>.jsonl` — latest `per` / `forecast_eps`.
   - `data/queue/<code>/` and `signals/<code>.log` (last ~10) — what news is
     fresh and what analyze-ticker has been saying. Don't re-analyze every
     article; just absorb the recent tone.

## How to weight the inputs

For these tickers the **session backdrop dominates the open**, roughly in this
order. State which factors drove each lean.

1. **SOX `change_pct`** — primary driver for the semiconductor names
   (285A Kioxia, 6857 Advantest, 6920 Lasertec). A strong SOX night (e.g.
   `sox_change_pct` > +3%) is a broad tailwind; a sharp drop is a headwind.
   6981 (Murata) is an electronic-components (MLCC) name — moved by smartphone/AI
   component demand, so apply SOX more loosely and weight its own news/imbalance.
2. **Pre-open `imbalance`** — the most direct per-ticker tell. A ticker quoted
   up on `change_pct` but with `imbalance` negative (more sell than buy shares
   waiting) is a **"gap up into supply" / 寄り天 risk** — the open may fade.
   Up + positive imbalance = cleaner strength. Flag both explicitly.
3. **Nikkei futures** — overall market gap direction.
4. **Daily trend / range position** — is today's expected gap extending an
   established move or fighting it.
5. **Fresh idiosyncratic news** — overrides the backdrop when a ticker has its
   own catalyst (earnings, guidance, an IR release in the queue).

## Output

Write **one JSONL record** to `./signals/premarket.log`:

```json
{
  "ts": "2026-05-27T08:57:00+09:00",
  "kind": "premarket-brief",
  "date": "2026-05-27",
  "backdrop": {
    "sox_change_pct": 5.53,
    "nasdaq_change_pct": 1.19,
    "dow_change_pct": -0.23,
    "nikkei_futures": 65560,
    "tone": "<one Japanese line: overall risk-on/off and what it means for these names>"
  },
  "tickers": [
    {
      "ticker": "6857",
      "lean": "up" | "down" | "neutral",
      "confidence": "low" | "medium" | "high",
      "drivers": "<2-3 short Japanese lines: which inputs drove this lean>",
      "kehai": "<pre-open quote if listed, else 'ランキング圏外'>",
      "watch": "<one line: what to watch at the open / what invalidates the lean>"
    }
    // ... one entry per watchlist ticker
  ],
  "notes": "<optional: data gaps, stale earnings dates, anything caveated>"
}
```

- `lean` is the **session direction tilt**, not a buy/sell order. Keep it
  separate from analyze-ticker's `signal`.
- Cover **every watchlist ticker every time**, even neutral/ranking-out ones —
  the absence of a pre-open quote is information.
- If re-run the same morning, replace the existing record for that `date`
  rather than appending a second one (read the file, drop any line whose
  `date` matches today and `kind` is `premarket-brief`, then write).

## Output style

The terminal stays quiet. Print **one** summary line, e.g.:

```
[08:57] premarket SOX+5.5% risk-on  6857↑med 6920↑med 285A↑low
```

The user tails `signals/premarket.log` for the full record.

## Honesty

- The open's *direction* is barely better than a coin flip even with this data.
  What you can produce is a **tilt + the reasoning**, so the user reads the tape
  at 09:00 already knowing what to expect and what would surprise them.
- **Do not invent price targets or predict the close.** The lean is for the
  open and the first part of the session only.
- A strong SOX night does **not** guarantee a green open — note when a name has
  already run hard into the news (priced in) or has a hostile pre-open imbalance.
- When the inputs disagree (e.g. SOX up but the ticker's imbalance is heavily
  sell-side), say so and lean `neutral` rather than forcing a direction.

## Relation to other skills

- This brief is the **morning, cross-sectional** view. `analyze-ticker` remains
  the **intraday, per-article** view and keeps writing to `signals/<ticker>.log`.
- The brief does not move articles out of the queue and does not write to
  `signals/<ticker>.log` — it only writes its own `signals/premarket.log`.
```
