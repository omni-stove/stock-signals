---
name: signal-judge
description: For a single ticker given as argument, read that ticker's standing GitHub Issue body (the living context maintained by context-builder) together with current price/daily/premarket/earnings data from the Worker, form one overall swing buy-or-sell direction call, and post it to Slack. It does NOT modify the Issue — output goes to Slack only. One-shot; fired by context-builder after the context changes.
---

# signal-judge

**Decision stage.** Read the ticker's living context (the standing Issue body, owned by
context-builder) + the current market picture → emit one **swing** judgment to Slack.

- **Direction carries a 水準 qualifier** (step 4b): `buy・押し目` vs `buy・追い`, `sell・利確` vs
  `sell・逃げ`. The direction (2-value) never changes; the qualifier tells *where in the move* it is.
- **Swing horizon**: days to a few weeks. Not day-trading, not buy-and-hold.

## Invocation

```
/signal-judge <ticker> -- <event-context> @<numeric-context.json>
```

`<ticker>` is this run's symbol. After `--` come two inputs the workflow computed at launch — use them as-is:
- the **event context** — a one-line 需給イベント string (SQ + nearby macro events). No `--` →
  treat as 需給イベント: 特になし.
- `@<path>` — the **numeric context** JSON (`scripts/judge-context.sh` output): earnings, premarket,
  daily, prices, **already fetched and normalized** (`days_to_earnings`, range position, MA position,
  volume ratio, freshness flags). **Read this file** for these.

Fired by context-builder's `repository_dispatch` (one per ticker) after the Issue updates, or manually.

## Steps

**1. Metadata + numeric context.** Read `<ticker>` from `config/watchlist.yaml`; cache
`name`/`fair_per`/`sector`. Read the `@<path>` JSON — its fields drive steps 3–5:
- `earnings.days_to_earnings` (null → risk unknown).
- `daily` (`status` ok/insufficient): `range_pct` (0=安値圏 / 100=高値圏), `ma_position`
  (above=uptrend / between=chop / below=downtrend), `vol_x_20d` (>2 = unusual), `close`, range hi/lo.
  `insufficient` (<5 rows) → proceed on context alone.
- `premarket` (`status` ok/stale/unavailable): `sox_change_pct` etc. `stale`/`unavailable` (row >20h
  old, predates last NY close) → backdrop unavailable, skip step 5.
- `prices` (`status` ok/unavailable): `series` `change_pct`/`volume` rising, fading, or choppy? A
  volume spike with no fresh context = caution ("unusual volume", lean against chasing). **Ignore
  `pts_price`** — thin after-hours, fades at the open.

**2. Context Issue.**
```
gh issue list --label ir-report --label "ticker:<ticker>" --state open --json number,body --limit 1
```
The body is the living context (business shape, product/roadmap, capital & management, the rolling
**直近の重大トピック** list, **証券会社レーティング**, **決算・ガイダンス**). **Primary fundamental
input — read it in full.** 直近の重大トピック is freshest and usually the core of the call.
証券会社レーティング is a **6–12mo** view (corroborates, doesn't dominate): weight by **発行日**
(discount older), **アップサイド% to 目標株価** (near/over → `sell`), **信頼度**.
No Issue / empty → `context: unavailable`, call on price/backdrop alone (weaker, still a side).

**3. Read the price picture** (from the step-1 JSON).
- `daily.ma_position` = trend; `daily.range_pct` = where in the 20-day range (near 100 → buying late
  is risky; near 0 + bullish context = clean R/R); `vol_x_20d` >2 = unusual.

**Fire window** (current JST) — changes what the price data means:

| window | `prices` means | backdrop weight |
|---|---|---|
| pre-open (~08:30, <09:00) | last session's close, no today's tape | **most** (step 5) |
| intraday (09:00–15:00) | today's session | secondary |
| after-close (~18:30) | today's `daily` row exists | least |

`premarket` = last night's US backdrop. `sox_change_pct` is the primary read for semis (285A/6857/6920);
6981 (Murata, MLCC) responds loosely. `status` stale/unavailable → skip step 5.

**4. Form one judgment.** Weigh bull vs bear, pick the stronger side *now*.
- **直近の重大トピック** + 経営判断・資本政策 / 商品ラインナップ are the driver. Recent topics weigh most;
  older structural context informs continuation vs reversal.
- **Nothing materially new** (restated known facts) = sell-side hint; easy money's made.
- **Priced in**: good context after a multi-day *regular*-session run weakens `buy` → `sell`. Judge from
  `daily.range_pct` (near 100 after a run → `sell`; near 0 + live context → `buy`).
- Freshest, best-corroborated topics (multiple aligned, or an earnings/guidance release) = strongest
  call. A single thin line still picks a side — flag it as a weak read.
- **Earnings ≤5d out** → `sell` (de-risk into the print), unless the freshest context *is* the release.
  No lean once `days_to_earnings` is negative/unknown.
- Separate macro from idiosyncratic drivers; tag them distinctly.
- **Event context** (`--` arg) — SQ 週/明け can co-occur (JP SQ = 2nd Fri, US = 3rd):

  | phase | meaning | how to use |
  |---|---|---|
  | 日本SQ週 | direct supply/demand; メジャーSQ (3/6/9/12月) unwind distorts open (SQ値 vs 実勢,「幻のSQ」) & tape | such moves = **noise, not signal** → fall back to fundamentals; note it |
  | 日本SQ明け | unwind done, tape **cleaner** | read the move at face value; a sharp 歪み剥落の戻り (reversal of last week's SQ move) = real signal |
  | 米メジャーSQ週 | *not* direct; reaches JP names only via SOX/US indices | fold into backdrop (step 5) but **discount** — partly clearing-driven, less persistent |
  | 米メジャーSQ明け | distortion gone | backdrop at full weight |
  | FOMC/日銀/CPI `[high]`/`[medium]` + days-until | known binary macro | `[high]` ≤3d out → `sell` |

**4b. 水準 qualifier.** After the direction, tag *where in the move* it is — from `daily.range_pct` ×
`ma_position` × context freshness. No new data needed.

| dir | qualifier | when |
|---|---|---|
| buy | **押し目** (default) | `range_pct` low/mid, or pullback toward ma25, with intact/live context — clean entry |
| buy | **追い** | `range_pct` near 100 / fresh breakout — context new enough to chase, but flag the late entry |
| sell | **利確** (default) | `range_pct` near 100 after a multi-day run, 材料出尽くし / priced in — sell strength |
| sell | **逃げ** | `ma_position` below, or risk-off: earnings ≤5d, hostile backdrop, `[high]` macro ≤3d |

Pick the closer fit; when `daily.status` is insufficient, fall back to `ma_position` (above→押し目/利確,
below→逃げ) and say the qualifier is a weak read.

**5. Pre-open backdrop weighting (pre-open only).** Context drives *direction*; backdrop **tilts** it
(won't flip a clearly bearish context). With `premarket.status == ok`:
- Semis (285A/6857/6920): weight `premarket.sox_change_pct`. 6981: loosely, lean on own trend/futures.
- Hostile (SOX ≲ −2%, or futures sharply down) → `sell`; don't `buy` a red tape unless idiosyncratic
  context overrides. Supportive (SOX ≳ +2%) → `buy`.
- 米メジャーSQ週 → discount SOX weight (say so); 米メジャーSQ明け → drop the discount.

**6. Post to Slack (only output).**
```
curl -s -X POST "$SLACK_WEBHOOK_URL" -H 'Content-Type: application/json' -d '{
  "text": "🧭 <ticker> <name> signal: <signal>・<qualifier>",
  "blocks": [ ... signal (buy|sell) + 水準 qualifier (押し目|追い|利確|逃げ), 1–3 lines of rationale
              citing the driving context topics, the price/backdrop/earnings tilt + why this 水準,
              link to the context Issue ... ]
}'
```

## Output (stdout) — one line, no narration

```
<ticker> → <signal>・<qualifier> (driving topics, price/MA cue) backdrop <SOX/event tilt>, slack <ok|skipped>
```
