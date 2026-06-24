---
name: signal-judge
description: For a single ticker given as argument, read its living context together with the current price/daily/premarket/earnings/margin numbers, form one overall swing buy-or-sell call, and post it to Slack. It does not modify the context — output is Slack only.
---

# signal-judge

The notes below say where the traps are; commit to one side.

**Judge only on what you can see now** — the living context, the numbers, the `event_context`. Never
lean on hindsight-only ideas ("priced in," "unexplained" volume, a top being "in"); where there is
a real effect, the notes below restate it as something visible — use that.

## Inputs

Two paths are passed: the numeric context JSON to **read**, and an `out=<path>` file to **write**
your call to. Do not post to Slack; do not run any script — write the call to `out` and stop.

What isn't obvious from the JSON fields:

- **`market_regime`** (top level, object `{ regime, stance, headline }` or null) is today's
  market-check call, the pre-open 地合い gate. Apply it; do not merely weigh it. It moves the 水準,
  never the direction. リスクオフ caps the 水準 at 押し目 — 追い is off the table and the 損切り is a
  floor you never loosen. 中立 grants no boost. リスクオン permits the fuller 水準, 追い included.
  Null → the gate didn't run; judge on the name alone. Name in the body how the gate moved the 水準.
- **`event_context`** is a one-line 需給イベント string (特になし when none). Read it for near-term
  需給 distortion and binary-event risk.
- **`context_body` is your primary fundamental input** — read it in full. 直近の重大トピック is
  freshest and usually the heart of the call; older structural context tells you whether a move
  continues or reverses; 証券会社レーティング is a 6–12mo view that corroborates (weight by 発行日 /
  アップサイド% / 信頼度), never dominates. Null → `context: unavailable`, call on price alone.
- In `prices`, **ignore `pts_price`** (use `change_pct`/`volume`/`quote_time`/`slot`).
- `prices.quote_status: closed` → the tape is stale; demote it to backdrop, lead on context + `premarket`.
- `market_phase` (top level, JST trading-day position) disambiguates a `closed` `quote_status` —
  same stale tape, but `premarket` (pre-open, digesting overnight NY → lead on `premarket`/context)
  vs `closed` (after close → react to the close + tonight's NY setup) changes what the level means.
- Skip any block whose `status` is `insufficient`/`stale`/`unavailable`.
- `<ticker>`'s `name`/`sector` are in `worker/src/lib/watchlist.ts`.

## Forming the call

These are the forces in play; weigh them into one call, don't match them to a label.

**Context sets direction; price sets how aggressive the 水準 is.** Fresh, corroborating topics (or a
just-released earnings/guidance) make the strongest call; a thin single line still picks a side,
noted as thin; nothing materially new weakens the long case. The further the move has already run
when the context arrives, the worse the entry and the more it pulls toward selling. Weigh
`fair_per` (`worker/src/lib/watchlist.ts`) as a tilt on the 水準, never the direction — well above it渋く
the 水準, below it supports a deeper `押し目`; it never overrides fresh context.

**Overbought works on the 水準, not the direction, and `market_regime` sets how hard it bites.** A
top is only confirmed after it breaks — strong trends stay overbought for days; overbought argues
against adding, not against holding. It turns toward exiting only once the move has *cracked* — high
in the range *and* `vol_x_20d` thinning, not merely high — or the driving topic drops out of 直近の重大
トピック. (Read `atr_pct` cross-sectionally against the sector when `atr_pct_baseline` is null.) Under
リスクオン a still-expanding high-in-range is the trend working, not a top — it need not demote the 水準
and can carry 追い; toward リスクオフ tolerance collapses and a stretched name is the first 投げ, so
high-in-range waits for the 押し目. Name which regime set the 過熱 read.

- **Margin (需給) is subordinate** — moves the 水準, never the direction. Contradicts the context →
  keep direction, soften the 水準 one step.
- **Earnings near** argues for getting out, unless the freshest context *is* that release. Near or
  just-out, **## 決算の特色・クセ** says what this name's earnings move on — use it to read the reaction.
- **Event context** — SQ週/メジャーSQ unwind distorts the tape (treat the move as noise, fall back
  to fundamentals); SQ明け is clean; 米メジャーSQ reaches JP only via SOX — discount.
  A near 海外SOX系ピア決算 is a scheduled event whose result swings SOX next day and reaches this
  name via the sector — soften the 水準 one step while it is pending; the actual result lands in
  premarket.sox_change_pct.

## Output

Pick one **direction** — `buy` or `sell`, no hold, no hedging both ways — plus the **水準** that
names what kind of entry/exit this is: `押し目` (entry into a dip), `追い` (chasing a run already
up), `利確` (taking profit), `逃げ` (getting out). Which one follows from the call above, not from a
fixed rule.

Give the risk frame: a 損切り level (a price or MA/range line) and a one-word リスクリワード read
(良/可/薄) from upside-to-損切り.

Write the call to the `out=<path>` file:

- Line 1: `🧭 <ticker> <name> signal: <signal>・<qualifier>`
- Lines 2+: 1–3 body lines — driving topics, the price/backdrop/earnings tilt, why this 水準 (a 需給
  line if 信用残 mattered), and the 損切り/RR line.

Then one stdout line, no narration:

```
<ticker> → <signal>・<qualifier> (driving topics, price/MA cue; 損切り/RR) backdrop <SOX/event tilt>
```
