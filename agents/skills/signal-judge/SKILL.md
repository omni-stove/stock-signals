---
name: signal-judge
description: For a single ticker given as argument, read that ticker's standing GitHub Issue body (the living context maintained by context-builder) together with current price/daily/premarket/earnings data from the Worker, form one overall swing buy/sell/hold + confidence call, and post it to Slack. It does NOT modify the Issue — output goes to Slack only. One-shot; fired by context-builder after the context changes.
---

# signal-judge

Reads the ticker's **living context** (the standing Issue body) plus the current market picture and
emits **one overall swing judgment** to Slack. It is the decision stage; `context-builder` is the
context stage.

**This skill never writes to the Issue.** It only reads the Issue and posts to Slack. That is the
hard boundary that keeps the two stages from forming an edit loop: context-builder owns the Issue
body, signal-judge owns the Slack call.

**The system is built for SWING trading (holding several days to a few weeks).** Not day-trading,
not buy-and-hold. Frame every judgment on that horizon.

## Invocation

```
/signal-judge 285A
/signal-judge 285A -- 需給イベント(2026-06-19): 米メジャーSQ週(6月, SQ=2026-06-19/SOX・米指数経由のマクロ要因・SQ清算由来の振れは持続性低い)
```

The first argument `<ticker>` is the symbol this run owns. Everything after a `--` separator is the
**event context** — a one-line 需給イベント string the workflow computed at launch (SQ + nearby
macro events). It is an *input*, not a fetch target: do **not** read `config/events.yaml` or run any
calendar script yourself. If no `--` / no event context is passed (e.g. a bare manual run), treat it
as 需給イベント: 特になし and judge normally.

Fired by `context-builder`'s `repository_dispatch` (`signal-judge`, one dispatch per ticker) right
after the context Issue was updated, or manually.

## Steps

### 1. Read the ticker's metadata

Read the `<ticker>` entry from `config/watchlist.yaml` and cache `name` / `fair_per` / `sector`.

Get the **next earnings date from the Worker** (D1 is the source of truth):

```
curl -s -H "Authorization: Bearer $SYNC_TOKEN" "$WORKER_URL/latest?kind=earnings&code=<ticker>"
```

→ `{ rows: [{ ticker, next_date, detail, fetched_at }] }`. Compute `days_to_earnings` from
`next_date` relative to today. If `next_date` is null/missing, treat earnings risk as unknown.

### 2. Read the context Issue

```
gh issue list --label ir-report --label "ticker:<ticker>" --state open --json number,body --limit 1
```

The body is the **living context** maintained by context-builder: business shape, product /
roadmap, capital & management decisions, the rolling 直近の重大トピック list, 証券会社レーティング,
and 決算・ガイダンス. **This is your primary fundamental input** — read it in full. The
直近の重大トピック section is the freshest material and usually the core of the call.

The **## 証券会社レーティング** section is a **6–12-month** view, not a swing trigger. Weight by
**発行日** (discount the older it is), **アップサイド% to 目標株価** vs current price (near/over target
leans `hold`), and **信頼度**. It only corroborates — never originates a call or reaches `high` alone.

If no Issue exists or the body is empty, note `context: unavailable` and judge on price/backdrop
alone (low confidence).

All Worker calls (except `/health`) require auth: pass the token in the `Authorization: Bearer`
header (never in the URL — it leaks into logs). When `$SYNC_TOKEN` is empty (dev), the header is
harmless.

### 3. Pull price/daily context and the market backdrop

```
curl -s -H "Authorization: Bearer $SYNC_TOKEN" "$WORKER_URL/latest?kind=prices&code=<ticker>&n=20"
curl -s -H "Authorization: Bearer $SYNC_TOKEN" "$WORKER_URL/latest?kind=daily&code=<ticker>&n=20"
curl -s -H "Authorization: Bearer $SYNC_TOKEN" "$WORKER_URL/latest?kind=premarket&n=1"
```

Both prices/daily are time series (newest first). Read the trajectory:
- **prices**: is the `change_pct` / `volume` run rising, fading, or choppy? `pts_price` (live outside
  hours) vs the close. A bullish context with PTS premium already > +3% leans `hold` ("already
  discounted"). Volume spike with no fresh context → `hold`, note "unusual volume". Outside hours
  (before 09:00 / after 15:30 JST) the live read is `pts_price`, not stale `price`.
- **daily**: each row carries `ma5` / `ma25`. Price above both = uptrend, between = chop, below =
  downtrend. Position in the 20-day range (near high → buying late is risky; near low + bullish
  context = clean risk/reward). Volume vs the ~20-day average (>2× = unusual).

When data is thin (<5 daily rows, or missing prices), say so (`unavailable` / `insufficient`) and
proceed on context alone.

**Determine the fire window** from the current time (JST) — it changes what price data means and how
much the backdrop matters:
- **pre-open (~08:30, before 09:00)**: prices is last session's close + `pts_price`; no today's tape.
  The backdrop (`premarket`: `sox_change_pct`, `nikkei_futures_price`) matters most — see step 5.
- **intraday (09:00–15:00)**: prices reflects today's session. Backdrop is secondary.
- **after-close (~18:30)**: today's `daily` row exists. Context + confirmed daily dominate; backdrop
  least relevant.

The `premarket` row carries last night's US backdrop: `sox_change_pct` is the primary read for the
semiconductor names (285A/6857/6920); 6981 (Murata, MLCC) responds to SOX only loosely. The row has
no calendar date — only `fetched_at` (UTC ISO8601, the latest fetch). If the row is missing or its
`fetched_at` is older than ~20h (i.e. it predates last night's NY close), treat the backdrop as
`unavailable` and skip the step-5 weighting.

### 4. Form one overall judgment

Read the context Issue body (step 2) against the price/earnings picture and form **one overall**
buy/sell/hold + confidence on a swing basis. Rules:
- The **直近の重大トピック** list and 経営判断・資本政策 / 商品ラインナップ sections are the
  fundamental driver. Weight the most recent topics most; older structural context informs
  continuation vs reversal but never originates a fresh `buy`/`sell` on its own.
- If the context shows nothing materially new since it last drove a call (a restatement of
  already-known facts), lean `hold` — don't whipsaw.
- Material likely already priced in (good context after a multi-day run / PTS premium > +3%) leans
  `hold`, not `buy`.
- `high` needs corroboration — multiple aligned topics, or an earnings/guidance release — never a
  single line.
- Cap confidence at `low` for earnings ≤5 days out, `medium` for 6-14 days, unless the freshest
  context *is* the earnings release. No cap once `days_to_earnings` is negative or unknown.
- Separate macro from idiosyncratic drivers and tag them distinctly.
- **Apply the event context** (the `--` argument). Two SQ layers, handled differently:
  - **日本SQ週** — a *direct* supply/demand event on the name itself. During SQ week (esp.
    メジャーSQ = 3/6/9/12月), futures/option unwind distorts the open (SQ値 vs 実勢, 「幻のSQ」) and
    intraday tape. Treat such moves as **noise, not signal**: cap confidence one notch (a メジャーSQ
    week `buy` tops out at `medium`), and don't originate a fresh call off a price move that is
    plausibly SQ-driven. Note it in the rationale.
  - **米メジャーSQ週** — *not* a direct event on a Japanese name. It reaches them only via SOX / US
    indices, i.e. as a **macro/sentiment factor**. Do not cap or move the idiosyncratic call for it;
    instead fold it into the pre-open backdrop reading (step 5): a SOX swing during 米メジャーSQ週 is
    partly clearing-driven and **less persistent**, so lean on it less than the same SOX move on an
    ordinary day. Never let 米SQ alone change a call.
  - Non-SQ events in the string (FOMC/日銀/CPI, shown with `[high]`/`[medium]` and days-until) follow
    the existing near-event caps above — a `[high]` event ≤3 days out pulls confidence down a notch.

### 5. Pre-open backdrop weighting (only when the fire window is pre-open)

The context drives the *direction*; the session backdrop tempers it. With `premarket` available:
- Semiconductor names (285A/6857/6920): weight `sox_change_pct`; 6981 weight it loosely and lean on
  the name's own trend/futures instead.
- Hostile backdrop (SOX ≲ −2%, or futures sharply down) against a `buy`: pull toward `hold`, or keep
  `buy` but **cap confidence at `low`**. Never `buy/high` into a red tape.
- Supportive backdrop (SOX ≳ +2%) aligned with a `buy` may keep `medium`, but the context alone
  still never reaches `high` without corroboration.
- The backdrop only **tempers** a context-driven `buy`; it never turns a `hold`/`sell` into `buy`.
- **米メジャーSQ週** (from the event context): a big SOX move that week is partly SQ-clearing
  noise, so discount its weight here — don't let a SQ-week SOX print drive the temper as hard as an
  ordinary-day print of the same size. Say so in the rationale.
- Applies **only pre-open**. Intraday/after-close the tape is already in `prices`/`daily` — do not
  double-count.

### 6. Post to Slack (only output)

POST the gist of the overall judgment as a single message. **Do not touch the Issue.**

```
curl -s -X POST "$SLACK_WEBHOOK_URL" -H 'Content-Type: application/json' -d '{
  "text": "🧭 <ticker> <name> signal: <signal>/<confidence>",
  "blocks": [ ... signal, confidence, 1–3 lines of rationale citing the context topics that drove
              it, the price/backdrop/earnings tempering, and a link to the context Issue ... ]
}'
```

If `$SLACK_WEBHOOK_URL` is unset, skip the POST and only print the stdout summary.

## Output style (stdout)

A single-line summary, no narration:
```
285A → buy/medium (holdings capex ramp + BiCS8) backdrop SOX+1.2%, slack ok
```
When an SQ week tempered the call, say which layer and how:
```
285A → buy/medium (BiCS8) 日本メジャーSQ週=寄り値ノイズで確信度据置, slack ok
285A → buy/medium (BiCS8) backdrop SOX+2.1% but 米メジャーSQ週=清算由来で割引, slack ok
```
On missing context: `285A context-unavailable → hold/low, slack ok`.
