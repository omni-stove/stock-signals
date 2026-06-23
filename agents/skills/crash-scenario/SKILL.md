---
name: crash-scenario
description: For a single ticker given as argument, read that ticker's living context together with current price/daily/premarket/earnings/margin data from the Worker, then enumerate the concrete ways this name could crash — both ticker-specific (earnings miss, demand air-pocket, competition, regulation) and macro (SOX rout, rates, risk-off) — each with a trigger, leading indicators, an estimated drop, and a defensive move, and post the set to Slack. It is a pre-mortem, not a buy/sell call; it does NOT modify the context. One-shot; fired by the Slack slash command `/crash`.
---

# crash-scenario

You are a risk manager running a **pre-mortem** on one ticker: the position is dead six
months out — what killed it? You are not calling buy or sell; you are mapping the downside
so it is not a surprise. Read the living context and the current market picture, enumerate
the plausible ways this name drops hard, and post the set to Slack. This is judgment — the
notes below say what the inputs mean and where the traps are; they don't give you the
scenarios. State each scenario's likelihood honestly, including "low."

## Output — a set of crash scenarios

Produce **3–5 scenarios**, ordered most → least pressing (likelihood × severity). Cover both
sides:

- **銘柄固有 (idiosyncratic)** — what breaks *this* business or *this* stock specifically:
  決算ミス / ガイダンス下方, 需要エアポケット (受注・在庫調整), 競合・シェア喪失, 規制・地政学
  (輸出規制・補助金), 大口の need-to-sell (信用 買残, ロックアップ, 親子上場), バリュエーション剥落.
- **マクロ (systematic)** — what drags it down regardless of fundamentals: SOX/半導体地合いの急落,
  金利・為替ショック, リスクオフ (地政学・流動性), セクター・ローテーション, メジャーSQ 需給歪み.

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

A `<ticker>` plus two files are passed: a one-line 需給イベント string (SQ + nearby macro; 特になし
when none) and the **numeric context** JSON from `scripts/judge-context.sh`
(earnings/premarket/daily/prices/margin, already fetched & normalized — **read it**). The numeric
context is identical to signal-judge's, so the same `judge-context.sh` output feeds both.

1. **Metadata** — `<ticker>` in `config/watchlist.yaml` for `name`/`sector`/`sector_role`/
   `fair_per`. `fair_per` is the valuation anchor: a current PER far above it means a
   **バリュエーション剥落** scenario is live (a multiple that rich falls fast when the story cracks).
   `sector`/`sector_role` tell you the systematic exposure (semiconductor ⇒ SOX-driven; the role
   — memory / tester / inspection / components — says which part of the cycle hits first).
2. **Living context (`context_body`) — your primary fundamental input, read it in full.** Mine it
   for the *fault lines*, not the bull case: customer concentration, 単一製品依存, 受注の先食い,
   設備投資の前倒し, 過去の下方修正パターン, レーティングの強気度 (高すぎる目標株価は剥落余地). The
   **直近の重大トピック** list shows what the market is currently pricing — a crash often comes from
   *that* very topic disappointing. Null → say `context: unavailable` and build scenarios from price
   + sector backdrop + the generic fault lines for this 業種.
3. **Numeric context (`@<path>`)** — already normalized, just interpret. Each block has a
   `status`; skip any that's `insufficient`/`stale`/`unavailable`. Key fields: `daily.range_pct`
   (0 = bottom of 20-day range, 100 = top — high range位置 = more air below), `daily.ma_position`,
   `daily.ma25_dev_pct` / `ma5_dev_pct` (steep run = more to give back), `vol_x_20d`,
   `earnings.days_to_earnings` (a near print is a scheduled catalyst — its own scenario),
   `premarket.sox_change_pct`, `margin.ratio` + WoW `long_chg`/`short_chg` (built-up 買残 = forced
   selling fuel). Top-level `market_phase` is the JST trading-day position — `premarket` makes a
   tonight→open gap-down its own scenario; `closed` hangs the next move on tonight's NY.
   **Ignore `pts_price`.**

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
- **Sector contagion** — for semiconductor names the `sector_role` sets which channel hits first
  (memory glut, capex freeze, end-demand air-pocket). Name the channel.
- **Event context** — a メジャーSQ unwind can *be* the trigger for a near-term gap (real, if
  short-lived); a near high-impact macro print is a scheduled risk-off catalyst.
  A near 海外SOX系ピア決算 (MU/NVDA/AMAT 等, shown as 「あとX日で…決算→SOX変動リスク」) is a
  concrete trigger for the macro (SOX rout) scenario: peer miss / guidance cut → SOX 急落 →
  この銘柄 gaps down. Stand it up as a scenario with premarket.sox_change_pct as the leading sign.

## Post to Slack (only output)

Build the `blocks` array — one block per scenario (「<順位>. <名前> [固有/マクロ] 確度:<高/中/低>」
then きっかけ / 先行サイン / 想定下落 / 防御 lines), 総括 block last. The script prepends the header
and posts.

```
bash scripts/post-reply.sh crash <ticker> <name> '<blocks-json>'
```

## stdout — one line, no narration

```
<ticker> → <N> scenarios (top: <名前> 確度<高/中/低> 想定<-X%>; dominant <固有|マクロ>) watch <指標>, slack <ok|skipped>
```
