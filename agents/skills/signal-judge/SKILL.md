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

How to read the fields (what to lead on, what to ignore):

- **`context_body`** carries three layers: 直近の重大トピック (freshest), older structural context,
  証券会社レーティング (6–12mo, weight by 発行日 / アップサイド% / 信頼度). Null → emit
  `context: unavailable` and call on price alone.
- **`market_regime`** (`{ regime, stance, headline }`): apply it, don't merely weigh it.
- **`event_context`**: one-line 需給イベント string (特になし when none).
- **`ticker_note`**: qualifies the other inputs, never sets direction.
- **`prices`**: ignore `pts_price`; use `change_pct`/`volume`/`quote_time`/`slot` (`slot` =
  `premarket`/`regular`/`closing`). `quote_status: closed` → stale tape, demoted to backdrop.
- **`market_phase`** (JST trading-day position) says what to lead on: `premarket` → lead on
  `premarket`/context (digesting overnight NY); `afternoon_session` with a live tape → lead on the
  live tape, a pre-close call on carrying overnight into tomorrow; `closed` → react to the close +
  tonight's NY setup.
- **`premarket`**: lead on `sox_change_pct` (this sector tracks SOX); `nasdaq_change_pct` /
  `dow_change_pct` / `nikkei_futures_price` are backdrop confirming the SOX read, never the driver.
- Skip any block whose `status` is `insufficient`/`stale`/`unavailable`.
- `<ticker>`'s `name`/`sector`/`fair_per` are in `worker/src/lib/watchlist.ts`.

## Forming the call

### Primary — sets the direction

- **`context_body`** is the heart of the call. Fresh corroborating topics in 直近の重大トピック (or a
  just-released earnings/guidance) set the strongest direction; a thin single line still picks a side,
  noted as thin; nothing materially new weakens the case. 証券会社レーティング only corroborates.

### Secondary — moves the 水準 only

Name in the body how each force that fired moved the 水準.

**地合い (`market_regime` gate):**

- リスクオフ bars 追い and floors the 損切り (size down, tighten); 中立 grants no boost; リスクオン
  permits the fuller 水準.

**過熱 (how stretched the move is):**

- **How far the move has run** → tighter (higher buy line, shallower add). `fair_per`: above it
  tightens, below it supports a deeper dip-buy.
- **Overbought** argues against adding, not holding.
  `daily.momentum_state`: `extended` = trend still working, `cracking` = turn toward exiting (so is
  the driving topic dropping out of 直近の重大トピック). The gate sets how hard it bites — リスクオン
  reads `extended` as the trend working, リスクオフ as the first 投げ; name which regime set the read.
  Read `atr_pct` cross-sectionally against the sector when `atr_pct_baseline` is null.
- **`daily.volume_quality`** on an 出来薄 up move: `accumulation` holds the 水準, `thin` tightens it,
  `mixed`/`na` lean neither way. Works the 過熱 read only.

**需給 (positioning / flow):**

- **Margin** contradicting the context → soften the 水準 one step.
- **Event context** — SQ週/メジャーSQ unwind distorts the tape (treat the move as noise, fall back to
  fundamentals); SQ明け is clean; 米メジャーSQ reaches JP only via SOX. A near 海外SOX系ピア決算
  swings SOX next day and reaches this name via the sector — soften one step while pending; the
  result lands in `premarket.sox_change_pct`.

**イベントリスク (binary events):**

- **Earnings near** is binary-event risk → tighter (smaller size, tighter 損切り); cannot set
  direction. **Just out** (`earnings_result.status: fresh`): `verdict`
  tilts one step — `beat` toward holding/adding, `miss` toward exiting; `inline` and non-`fresh` add
  nothing. Near or just-out, read the price reaction through **## 決算の特色・クセ** (the name may
  move on a metric other than EPS).

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
