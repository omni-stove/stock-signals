---
name: signal-judge
description: For a single ticker, form one overall swing buy-or-sell call from its living context and the current price/daily/premarket/earnings/margin numbers. Output is an out-file only — it does not modify the context and does not post to Slack.
---

# signal-judge

Judge the market side only — buy-場 or sell-場 at this level — and output a **direction** plus a
**price line**, never a 動詞. The reader maps `sell`→利確/損切り, `buy`→新規/増し玉 against their own
position; do not choose that verb for them.

Judge on what you can see now — context, numbers, `event_context` — never on hindsight ("priced in,"
"unexplained" volume, a top being "in"). "after it falls further" / "once it settles" is not a verdict;
tomorrow's open, next week, the quarter ahead never decide. Always name the exact line; a `buy`
without one is an error. The line sits **at or above the current price (約定可能) by default** —
below it only when a named support/MA sits just under.

**Context sets direction. Every secondary force (market_regime, 過熱, margin, earnings,
event_context) moves only the 水準** — the buy line, the add depth, the 損切り tightness, the size —
and never flips the call. 過熱・地合い・不確実性 size you down or tighten the 損切り; they never push
the line down to wait.

## Inputs

Two paths are passed: the numeric context JSON to **read**, and an `out=<path>` file to **write**
your call to. Do not post to Slack; do not run any script — write the call to `out` and stop.

What isn't obvious from the JSON fields:

- **`market_regime`** (top level, object `{ regime, stance, headline }` or null) is today's
  market-check 地合い gate. Apply it, don't merely weigh it: リスクオフ bars 追い and floors the 損切り
  (size down, tighten); 中立 grants no boost; リスクオン permits the fuller 水準. When present, name in
  the body how the gate moved the 水準. Null → judge on the name alone, say nothing about the gate.
- **`event_context`** is a one-line 需給イベント string (特になし when none). Read it for near-term
  需給 distortion and binary-event risk.
- **`context_body` is your primary fundamental input.** 直近の重大トピック is
  freshest and usually the heart of the call; older structural context tells you whether a move
  continues or reverses; 証券会社レーティング is a 6–12mo view that corroborates (weight by 発行日 /
  アップサイド% / 信頼度), never dominates. Null → `context: unavailable`, call on price alone.
- In `prices`, **ignore `pts_price`** (use `change_pct`/`volume`/`quote_time`/`slot`). `slot` is
  `premarket` / `regular` / `closing` — the session the snapshot belongs to.
- `prices.quote_status: closed` → stale tape, demoted to backdrop; `market_phase` (top level, JST
  trading-day position) says what to lead on instead — `premarket` (pre-open, digesting overnight NY
  → lead on `premarket`/context) vs `closed` (after close → react to the close + tonight's NY setup).
- `market_phase: afternoon_session` with a live tape → pre-close call on carrying overnight into
  tomorrow's open: lead on the live tape, decide on what is known now. Nothing fresh near the close is
  itself the answer; don't defer the overnight to after-close material.
- **`premarket`**: lead on `sox_change_pct` (this sector tracks SOX). `nasdaq_change_pct` /
  `dow_change_pct` / `nikkei_futures_price` are backdrop — read them only to confirm or qualify the
  SOX read, never as the driver.
- Skip any block whose `status` is `insufficient`/`stale`/`unavailable`.
- `<ticker>`'s `name`/`sector`/`fair_per` are in `worker/src/lib/watchlist.ts`.

## Forming the call

Fresh corroborating topics (or a just-released earnings/guidance) set the strongest direction; a
thin single line still picks a side, noted as thin; nothing materially new weakens the case.

Each secondary force shifts the 水準 one step in the stated direction:

- **How far the move has run** → tighter (higher buy line, shallower add). `fair_per`: above it
  tightens, below it supports a deeper dip-buy.
- **Overbought** argues against adding, not holding.
  `daily.momentum_state`: `extended` = trend still working, `cracking` = turn toward exiting (so is
  the driving topic dropping out of 直近の重大トピック). The gate sets how hard it bites — リスクオン
  reads `extended` as the trend working, リスクオフ as the first 投げ; name which regime set the read.
  Read `atr_pct` cross-sectionally against the sector when `atr_pct_baseline` is null.
- **`daily.volume_quality`** on an 出来薄 up move: `accumulation` holds the 水準, `thin` tightens it,
  `mixed`/`na` lean neither way. Works the 過熱 read only.
- **Margin (需給)** contradicting the context → soften the 水準 one step.
- **Earnings near** is binary-event risk → tighter (smaller size, tighter 損切り); cannot set
  direction. **Just out** (`earnings_result.status: fresh`): `verdict`
  tilts one step — `beat` toward holding/adding, `miss` toward exiting; `inline` and non-`fresh` add
  nothing. Near or just-out, read the price reaction through **## 決算の特色・クセ** (the name may
  move on a metric other than EPS).
- **Event context** — SQ週/メジャーSQ unwind distorts the tape (treat the move as noise, fall back to
  fundamentals); SQ明け is clean; 米メジャーSQ reaches JP only via SOX. A near 海外SOX系ピア決算
  swings SOX next day and reaches this name via the sector — soften one step while pending; the
  result lands in `premarket.sox_change_pct`.

## Output

One direction (`buy`/`sell`). `now` when the line is at or below the current
price; `wait@<line>` only when the line sits at a named support/MA below it. Add the risk frame: a
損切り level (price or MA/range line) and a one-word リスクリワード (良/可/薄) from upside-to-損切り.

Write to the `out=<path>` file, split mechanically — **line 1 = headline, lines 2+ = body**. Emit
nothing before line 1 (no blank line, no reasoning), keep the headline to one line, write only:

- Line 1: `🧭 <ticker> <name> signal: <buy|sell> (now|wait@<line>; 損切り=<line> / RR<良|可|薄>)`
- Lines 2+: 1–3 body lines — driving topics, the price/backdrop/earnings tilt, why this line (a 需給
  line if 信用残 mattered, how the gate moved the 水準), and the 損切り/RR read.

Then stop. Do not write anything to stdout.
