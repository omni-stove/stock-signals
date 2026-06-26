---
name: crash-scenario
description: For one ticker, enumerate the concrete ways it could crash — ticker-specific and macro — as a pre-mortem. It does NOT modify the context or make a buy/sell call. One-shot; fired by the Slack slash command `/crash`.
---

# crash-scenario

A **pre-mortem** on one ticker: the position is dead six months out — what killed it? Not a buy/sell
call; map the downside so it is not a surprise. The notes below say where the traps are; state each
scenario's likelihood honestly, including "low."

## The scenarios to produce

Produce **3–5 scenarios**, ordered most → least pressing (likelihood × severity). Cover both
sides:

- **銘柄固有 (idiosyncratic)** — what breaks *this* business or *this* stock specifically:
  決算ミス / ガイダンス下方, 需要エアポケット, 競合・シェア喪失, 規制・地政学, 大口の need-to-sell,
  バリュエーション剥落.
- **マクロ (systematic)** — what drags it down regardless of fundamentals: SOX/半導体地合いの急落,
  金利・為替ショック, リスクオフ, セクター・ローテーション, メジャーSQ 需給歪み.

Each scenario is one block:

- **きっかけ (trigger)** — the specific event that starts it; concrete, not a conditional.
- **先行サイン (leading signs)** — what you'd see *before/as* it breaks, tied to inputs you can
  actually watch (`vol_x_20d`, MA割れ, 買残, SOX, `days_to_earnings`).
- **想定下落 (severity)** — a rough magnitude band, not false precision; anchor it to range位置 /
  MA乖離 / past similar moves where you can.
- **効きにくさ / 防御 (defense)** — how to size or hedge against it. One line.

End with a **総括**: which 1–2 scenarios actually dominate the risk right now, and the single
indicator most worth watching this week.

## Inputs

A `<ticker>`, the **numeric context** JSON to **read** (Worker `/judge-context`:
earnings/premarket/daily/prices/margin + `context_body` + `event_context`, already fetched &
normalized — identical to signal-judge's input), and an `out=<path>` file to **write** the scenario
blocks to. Do not post to Slack; do not run any script — write the blocks to `out` and stop.

**Primary — where the fault lines come from:**

- **Living context (`context_body`), read it in full.** Mine it for the *fault lines*, not the bull
  case: customer concentration, 単一製品依存, 受注の先食い, 設備投資の前倒し, 過去の下方修正パターン,
  レーティングの強気度. The **直近の重大トピック** list shows what the market is currently pricing — a
  crash often comes from *that* very topic disappointing. Null → say `context: unavailable` and build
  scenarios from price + sector backdrop + the generic fault lines for this 業種.

**Secondary — what raises 確度 or sets the channel, never invents 銘柄固有 risk:**

- **`market_regime`** (`{ regime, stance, headline }`): a リスクオフ regime raises the 確度 of the
  macro / リスクオフ scenarios and shortens their trigger horizon.
- **`event_context`**: one-line 需給イベント string (SQ + 指数リバランス + nearby macro/peer; 特になし
  when none).
- **`ticker_note`**: qualifies the other inputs, not a scenario of its own.
- **Metadata** (`<ticker>` in `worker/src/lib/watchlist.ts`: `name`/`sector`/`sector_role`/
  `fair_per`): treat `fair_per` only as a rough directional hint of richness; never anchor a 想定下落
  magnitude to a PER-vs-`fair_per` gap. `sector`/`sector_role` set the systematic exposure
  (semiconductor ⇒ SOX-driven; the role says which part of the cycle hits first).
- **Numeric context (`@<path>`)** — skip any block whose `status` is `insufficient`/`stale`/
  `unavailable`; ignore `pts_price`. Key fields: `daily.range_pct` (0 = bottom, 100 = top),
  `daily.ma_position`, `daily.ma25_dev_pct` / `ma5_dev_pct`, `vol_x_20d`,
  `earnings.days_to_earnings` (a near print is a scheduled catalyst — its own scenario),
  `premarket.sox_change_pct`, `margin.ratio` + WoW `long_chg`/`short_chg`. Top-level `market_phase`
  (JST trading-day position): `premarket` makes a tonight→open gap-down its own scenario; `closed`
  hangs the next move on tonight's NY. **In-session** (`morning_session`/`lunch_break`/
  `afternoon_session`) `daily` carries the **prior** confirmed bar (`daily.latest_date` ≠ today), so
  `vol_x_20d` / `range_pct` / MA乖離 describe yesterday — for today's 出来高 read
  `daily.vol_x_20d_intraday` (null near the open).

## Building the scenarios

**Read the inputs for fragility, not direction.** The same picture that makes a bullish call
also tells you how the unwind looks: a parabolic run (large `ma25_dev_pct`, thinning `vol_x_20d`)
is the *setup* for a sharp mean-reversion; high `range_pct` means there's air below; a near
`days_to_earnings` is a scheduled binary; built-up 買残 is the fuel that turns a dip into a
cascade. Tie every scenario to something concrete in the inputs or the living context.

Calibration traps:

- **Don't inflate every scenario to high likelihood.** A pre-mortem lists tail risks too —
  mark them "low" honestly; a list where everything is "高" is useless. Reserve "高" for a risk
  with a fresh trigger or a near-term catalyst.
- **Severity scales with how far it's run, not how scary the story is.** A deep-drop scenario
  needs a high `range_pct`, a rich multiple vs `fair_per`, or a structural break — not just a bad
  headline.
- **Idiosyncratic vs macro must be separable.** A hedge against one doesn't cover the other, so
  don't collapse them — the 総括 should say which type dominates.
- **Sector contagion** — for semiconductor names the `sector_role` sets which channel hits first.
  Name the channel.
- **Event context** — a メジャーSQ unwind can *be* the trigger for a near-term gap (real, if
  short-lived); a near high-impact macro print is a scheduled risk-off catalyst.
  A near 海外SOX系ピア決算 is a concrete trigger for the macro SOX-rout scenario; stand it up as a
  scenario with `premarket.sox_change_pct` as the leading sign.

## Output — write the blocks to the `out` file

Write a JSON array of Slack section blocks to the `out=<path>` file — one block per scenario
(「<順位>. <名前> [固有/マクロ] 確度:<高/中/低>」then きっかけ / 先行サイン / 想定下落 / 防御
lines), the 総括 block last. Each element: `{"type":"section","text":{"type":"mrkdwn","text":"…"}}`.
Do not include the header block.

Then one stdout line, no narration:

```
<ticker> → <N> scenarios (top: <名前> 確度<高/中/低> 想定<-X%>; dominant <固有|マクロ>) watch <指標>
```
