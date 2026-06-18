---
name: context-builder
description: For a single ticker given as argument, pull newly-fetched IR AND per-ticker news from the Worker (each since its own cursor), then update that ticker's standing GitHub Issue body — a *living context* for the name (business shape, product lineup / tech roadmap, capital & management decisions, and a rolling summary of the latest material topics). It does NOT decide buy/sell. After updating the body it fires the signal-judge workflow. One-shot; designed for GitHub Actions, fired by the Worker on new IR or news.
---

# context-builder

This skill maintains the **living context** for a ticker in its standing GitHub Issue. It reads
newly-fetched IR and per-ticker news and folds what matters into the Issue body, so that the body
is always the best single-page brief for understanding the name.

**It does not produce a buy/sell/hold call.** Judging is a separate stage (the `signal-judge`
skill). This skill's only job is to keep the context current and then hand off. The split exists so
the two concerns stay independent and never form an edit loop: context-builder writes the Issue;
signal-judge reads it and writes only to Slack.

**The system is built for SWING trading (holding several days to a few weeks).** Frame the context
toward that horizon — what a swing trader needs to know to read this name's next few weeks.

## Invocation

```
/context-builder 285A
```

The argument `<ticker>` is the symbol this run owns. Fired by the Worker's `repository_dispatch`
(`signal-update`, one dispatch per ticker) when new IR or news arrives, or manually.

## Steps

### 1. Read the ticker's metadata

Read the `<ticker>` entry from `config/watchlist.yaml` and cache `name` / `fair_per` / `sector`.

### 2. Get the existing Issue and the two cursors

```
gh issue list --label ir-report --label "ticker:<ticker>" --state open --json number,body --limit 1
```

The body ends with two cursor comments:
```
<!-- cursor: ir_last_fetched_at=YYYY-MM-DDTHH:MM:SS.sssZ -->
<!-- cursor: news_last_fetched_at=YYYY-MM-DDTHH:MM:SS.sssZ -->
```
Read both, and read the **whole existing body** — it is the context you are amending, not
replacing wholesale. A missing cursor (first run) means "pull the recent backlog" — omit `since`.

If no Issue exists for this ticker, **do not** invent one silently — print
`<ticker> no-issue (skipped)` and exit. (The standing Issues are provisioned once, out of band.)

### 3. Pull new IR and new news from the Worker

All Worker calls (except `/health`) require auth: pass the token in the
`Authorization: Bearer` header (never in the URL — it leaks into logs). When `$SYNC_TOKEN` is
empty (dev), the header is harmless.

```
curl -s -H "Authorization: Bearer $SYNC_TOKEN" "$WORKER_URL/pull?code=<ticker>&since=<ir_last_fetched_at>&limit=20"
curl -s -H "Authorization: Bearer $SYNC_TOKEN" "$WORKER_URL/pull-news?code=<ticker>&since=<news_last_fetched_at>&limit=20"
```

Each response is `{ ok, count, rows: [{ url, title, published_at, ir_category, fetched_at, body }] }`.
`/pull` returns IR only; `/pull-news` returns per-ticker news only. (`ir_category` is null for news.)

If **both** counts are 0, exit without touching the Issue (nothing new to fold in, and the
existing context still stands — do **not** fire signal-judge). Print `<ticker> ir=0 news=0 (no update)`.

### 4. Read each new item and decide what is material to the *context*

This is a context update, **not** a judgment. For each new IR / news item ask: *does this change how
the name should be understood over the next weeks?* Fold in only what shifts the picture; drop pure
restatements and noise.

What counts as material context (this is the substance the Issue is for):
- **Management & capital decisions** — capex plans, capacity ramp up/down, M&A / alliances /
  supply agreements, buybacks / dilution / financing, leadership or strategy changes.
- **Product lineup & tech roadmap** — product generations and where each is in its cycle (e.g. BiCS
  layer count, HBM entry, tester/inspection generations), wins/losses vs competitors, customer
  concentration shifts.
- **Structural supply/demand** — position in the price cycle, inventory, end-market demand signals
  that persist beyond a day.
- **Earnings & guidance** — results vs expectations and revised guidance (durable, not the tape
  reaction).

What is **not** context (leave it out — it's signal-judge's transient input, not the Issue's):
- A buy/sell/hold call or confidence. Never write a recommendation into the body.
- Intraday price moves, PTS premiums, single-session volume spikes.
- Stale rehashes of already-recorded facts.

**Recency:** treat items by `published_at`. Recent material updates the relevant section AND the
rolling "直近の重大トピック" list. Items older than ~30 days are background only — fold into the
structural sections if genuinely new to the body, but never into the rolling-topics list.

**証券会社レーティング (`ir_category="rating"`) is the exception to the 30-day rule** — its 目標株価 is
a 6–12-month view, so it goes in the **## 証券会社レーティング** section, not the rolling-topics list.

### 5. Regenerate and overwrite the Issue body

Rebuild the whole body and overwrite with `gh issue edit`, preserving the section structure below.
Writing the whole body at once (not incremental edits) keeps it near-atomic: if the job is
cancelled mid-run (a newer dispatch superseded it via `concurrency: cancel-in-progress`), the old
body and the old cursors stay intact, and the next run re-pulls everything since those cursors.

**Body structure** (Japanese; keep these headings stable — signal-judge reads them):

```markdown
# [<ticker> <name>] 銘柄コンテキスト

## 事業の骨格
<rarely-changing structural facts: what the company is, where it sits in the value chain,
 production base, technology lineage>

## 商品ラインナップ / 技術ロードマップ
<product generations and roadmap; revise when a generation moves>

## 経営判断・資本政策
<capex / capacity / M&A / alliances / capital policy; accumulate and revise on material events>

## 直近の重大トピック
<rolling, newest first. Each line: `- YYYY-MM: <one-line summary> — <why it matters for the
 next few weeks>`. Keep roughly the last ~6–10 entries; push older ones down or prune once their
 effect has been absorbed into the structural sections above.>

## 証券会社レーティング
<newest first: `- YYYY-MM-DD <機関>: <格付> 目標株価 <値> [信頼度: …]`. Keep while in ~12-month
 horizon; drop when the same 機関 issues a newer call. Empty if none.>

## 決算・ガイダンス
<latest results vs expectations, current guidance, known next-earnings considerations — facts only>

<!-- cursor: ir_last_fetched_at=<max ir fetched_at, or unchanged if 0 new IR> -->
<!-- cursor: news_last_fetched_at=<max news fetched_at, or unchanged if 0 new news> -->
<!-- managed-by: context-builder skill. Auto-updated. Do not edit the body by hand. -->
```

**Only advance a cursor to the max `fetched_at` of the rows actually pulled for that kind** (leave
it unchanged if that kind had 0 new rows).

### 6. Fire signal-judge

The context changed, so the judgment should be refreshed. Trigger the `signal-judge` workflow via a
`repository_dispatch` from inside this job (needs `contents: write` on the workflow token):

```
gh api "repos/${GITHUB_REPOSITORY}/dispatches" \
  -f event_type=signal-judge \
  -F "client_payload[ticker]=<ticker>"
```

Do this **only** when the body was actually updated (step 5 ran). If both counts were 0 (step 3),
you already exited and must not fire.

This skill never posts the judgment to Slack — signal-judge does.

## Output style (stdout)

A single-line summary, no narration:
```
285A ir=2 news=1 → context updated (issue#12), signal-judge dispatched
```
On zero new (both kinds): `285A ir=0 news=0 (no update)`.
On missing Issue: `285A no-issue (skipped)`.
