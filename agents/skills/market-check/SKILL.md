---
name: market-check
description: From the market backdrop, form one overall 地合い call (risk-on / neutral / risk-off) with a 売買可否 implication for today. It is market-wide, NOT per-ticker, and does NOT modify any context. One-shot; fired by the Worker pre-open, or run manually.
---

# market-check

Read **the room, not a name**: one honest call on today's backdrop. The 前段ゲート for whether
today's tape favors acting at all. The notes below say where the inputs mislead; commit to one read.

## Inputs

Two paths are passed: the numeric context JSON to **read** (Worker `/market-context`, already
fetched & normalized), and an `out=<path>` file to **write** your call to. Do not post to Slack; do
not run any script — write the call to `out` and stop.

What isn't obvious from the JSON fields:

- **`premarket`** is last night's NY tell — the strongest single input pre-open. `sox_change_pct` is
  the most important field for this semis-heavy watchlist: SOX leads the JP semis at the open. Read
  `nasdaq_change_pct` / `dow_change_pct` for breadth and `nikkei_futures_price` for the home tape's
  own gap. `status: stale` → the feed predates last night's NY close; demote it and lean on
  `sectors` + event. `unavailable` → say so and call on `sectors` + event alone.
- **`event_context`** is the one-line 需給イベント string (SQ週 / SQ明け / FOMC / 日銀 近接). SQ週 /
  メジャーSQ → intraday moves as noise, tilt 様子見; near FOMC / 日銀 → lighten 持ち越し. SQ明け is
  clean. 米メジャーSQ reaches JP only via SOX — discount it.
- **`sectors`** is how the watchlist itself actually moved. Per sector: `tone` (SOX-derived
  backdrop), `avg_change_pct` (直近営業日のセクター平均前日比), `avg_ret_5d_pct` (5日のトレンド), and
  per-name `rel_strength_pct` (relative strength vs sector avg) and `vol_ratio` (出来高の盛り上がり).
  `status: unavailable` → skip it.
- **`market_phase`** (JST trading-day position) frames what the numbers mean: `premarket` (pre-open —
  lead on `premarket`/event, the gap isn't in yet), `morning_session` / `afternoon_session` (場中 —
  `sectors` is live, read the breadth directly), `closed` (引け後 — react to today's close plus
  tonight's NY setup). `lunch_break` = morning is in, afternoon pending.

## Forming the call

These are the forces; weigh them into one read, don't match them to a label.

**`premarket` sets the tilt; `sectors` confirms or contradicts it.** SOX, NASDAQ, and 日経先物 all
leaning down together is a clean リスクオフ. SOX weak while Dow / NASDAQ hold is sector-specific
逆風, not broad — リスクオフ寄りの中立, semis に限った守り. When `sectors` already shows the watchlist
heavy (`avg_ret_5d_pct` deep negative, vol swelling) the move is underway, which deepens リスクオフ
even on a flat premarket.

**Breadth matters more than any single index.** One index down is noise; SOX, NASDAQ, 日経先物, and
セクター平均 all leaning the same way is signal. A split tape is 中立 — the most honest call on most
days; don't manufacture a regime that isn't there.

**Events cap the aggressiveness, not the direction.** A near FOMC / 日銀 or SQ週 doesn't make the day
risk-off by itself — it argues for 様子見 / 持ち越しを軽く regardless of which way the tilt points. A
strong リスクオン tape into a binary event is still 拾うなら軽く, not 全力.

- **独り負け銘柄** (deeply negative `rel_strength_pct`) is a per-name flag worth surfacing even when
  the overall 地合い is benign — the one place a market read touches a specific name. Don't turn it
  into a buy/sell call; name it as a thing to watch. Weight it by the tilt: under a SOX-led リスクオフ
  it marks the弱い手 where the next 投げ comes first; on a risk-on / split tape the same value is an
  idiosyncratic laggard, not a fault line.

## Output — one 地合いスコア

Pick one **regime** — `リスクオン` / `中立` / `リスクオフ` — plus a one-line **売買可否の含意** for
today that follows from the regime + events: `拾い場` (lean in), `様子見` (sit), `守り` (protect /
reduce). Which one follows from the read above, not a fixed rule.

Write the call to the `out=<path>` file:

- Line 1: `🌐 地合い: <regime>・<含意>` — exact format; `<regime>` and `<含意>` are the 3 値 above
  verbatim. This line is parsed into the 地合いゲート that signal-judge / crash-scenario read, so a
  drifted wording silently drops the gate.
- Lines 2+: 2–4 body lines — the premarket tilt (SOX/NASDAQ/日経先物 と breadth が揃っているか),
  the event caveat (近接イベントがあれば), the 売買可否の理由を1行, and — if any — a 独り負け
  line naming the weakest watchlist name.

Then one stdout line, no narration:

```
地合い → <regime>・<含意> (SOX <±x%>/日経先物 cue, breadth <aligned|split>) event <tilt>
```
