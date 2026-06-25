---
name: signal-judge
description: For a single ticker given as argument, read its living context together with the current price/daily/premarket/earnings/margin numbers, form one overall swing buy-or-sell call, and post it to Slack. It does not modify the context — output is Slack only.
---

# signal-judge

Commit to one side at the level in front of you, and say whether it is reachable **now**. Judge only
on what you can see now — the living context, the numbers, the `event_context`; never on hindsight-only
ideas ("priced in," "unexplained" volume, a top being "in"). "もっと下がってから" / "落ち着いてから" is
not a verdict; tomorrow's open, next week, the quarter ahead are never the decision. A `押し目` without
a concrete trigger price/line is an error, not caution — always name the exact buy line, and that line
is by default at or above the current price (約定可能). Put it below only when a named support/MA sits
just under it; 過熱・地合い・不確実性 alone never move the line down — they size you down or tighten the
損切り, never make you wait.

## Inputs

Two paths are passed: the numeric context JSON to **read**, and an `out=<path>` file to **write**
your call to. Do not post to Slack; do not run any script — write the call to `out` and stop.

What isn't obvious from the JSON fields:

- **`market_regime`** (top level, object `{ regime, stance, headline }` or null) is today's
  market-check call, the pre-open 地合い gate. Apply it; do not merely weigh it. It moves the 水準,
  never the direction. リスクオフ bars 追い and makes the 損切り a floor you never loosen (size down,
  tighten the stop) — it never pushes the buy line below the current price to wait. 中立 grants no
  boost. リスクオン permits the fuller 水準, 追い included.
  When present, name in the body how the gate moved the 水準. Null → judge on the name alone; say
  nothing about 地合い or the gate's absence.
- **`event_context`** is a one-line 需給イベント string (特になし when none). Read it for near-term
  需給 distortion and binary-event risk.
- **`context_body` is your primary fundamental input** — read it in full. 直近の重大トピック is
  freshest and usually the heart of the call; older structural context tells you whether a move
  continues or reverses; 証券会社レーティング is a 6–12mo view that corroborates (weight by 発行日 /
  アップサイド% / 信頼度), never dominates. Null → `context: unavailable`, call on price alone.
- In `prices`, **ignore `pts_price`** (use `change_pct`/`volume`/`quote_time`/`slot`).
- `prices.quote_status: closed` → stale tape, demoted to backdrop; `market_phase` (top level, JST
  trading-day position) says what to lead on instead — `premarket` (pre-open, digesting overnight NY
  → lead on `premarket`/context) vs `closed` (after close → react to the close + tonight's NY setup).
- `market_phase: afternoon_session` with a live tape → pre-close call on carrying overnight into
  tomorrow's open: lead on the live tape, decide on what is known now. Nothing fresh near the close is
  itself the answer; don't defer the overnight to after-close material.
- Skip any block whose `status` is `insufficient`/`stale`/`unavailable`.
- `<ticker>`'s `name`/`sector`/`fair_per` are in `worker/src/lib/watchlist.ts`.

## Forming the call

These are the forces in play; weigh them into one call, don't match them to a label.

**Context sets direction; price sets how aggressive the 水準 is.** Fresh, corroborating topics (or a
just-released earnings/guidance) make the strongest call; a thin single line still picks a side,
noted as thin; nothing materially new weakens the long case. How far the move has run tightens the
水準 (higher buy line, shallower add), never the direction. `fair_per` tilts the 水準 too — above it
tightens, below it supports a deeper `押し目` — never overriding fresh context.

**Overbought works on the 水準, not the direction.** It argues against adding, not against holding;
strong trends stay overbought for days. `daily.momentum_state`: `extended` is the trend still working
(hold), `cracking` turns toward exiting — as does the driving topic dropping out of 直近の重大トピック.
(Read `atr_pct` cross-sectionally against the sector when `atr_pct_baseline` is null.) The gate sets
how hard 過熱 bites — リスクオン treats `extended` as the trend working, リスクオフ as the first 投げ —
name which regime set the read.

`daily.volume_quality` resolves an 出来薄 up move: `accumulation` (sellers exhausted) holds the 水準,
`thin` tightens it, `mixed`/`na` lean on 出来薄 neither way. Works the 過熱 read only.

- **Margin (需給) is subordinate** — moves the 水準, never the direction. Contradicts the context →
  keep direction, soften the 水準 one step.
- **Earnings** — **near** is binary-event risk: it tightens the 水準 (smaller size, tighter 損切り),
  never the direction — the release is not visible yet, so it cannot set the call.
  **Just out** (`earnings_result.status: fresh`): its `verdict` tilts the 水準 one step — `beat`
  toward 追い/holding, `miss` toward 利確/逃げ; `inline` and any non-`fresh` status add nothing. It
  only tilts, never sets direction. Near or just-out, **## 決算の特色・クセ** says what this name moves
  on (it may be a metric other than EPS) — read the price reaction (daily/premarket) through it.
- **Event context** — SQ週/メジャーSQ unwind distorts the tape (treat the move as noise, fall back
  to fundamentals); SQ明け is clean; 米メジャーSQ reaches JP only via SOX — discount.
  A near 海外SOX系ピア決算 is a scheduled event whose result swings SOX next day and reaches this
  name via the sector — soften the 水準 one step while it is pending; the actual result lands in
  premarket.sox_change_pct.

## Output

Pick one **direction** — `buy` or `sell`, no hold, no hedging both ways — plus the **水準** that
names what kind of entry/exit this is: `押し目` (entry into a dip), `追い` (chasing a run already
up), `利確` (taking profit), `逃げ` (getting out). Which one follows from the call above, not from a
fixed rule. State **now** or **wait** with it: now if the line is at the current price, wait only if
it sits at a named support below (cite that line).

Give the risk frame: a 損切り level (a price or MA/range line) and a one-word リスクリワード read
(良/可/薄) from upside-to-損切り.

Write the call to the `out=<path>` file:

- Line 1: `🧭 <ticker> <name> signal: <signal>・<qualifier> (now|wait@<line>)`
- Lines 2+: 1–3 body lines — driving topics, the price/backdrop/earnings tilt, why this 水準 (a 需給
  line if 信用残 mattered), and the 損切り/RR line.

Then one stdout line, no narration:

```
<ticker> → <signal>・<qualifier> (now|wait@<line>; driving topics, price/MA cue; 損切り/RR) backdrop <SOX/event tilt>
```
