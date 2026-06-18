---
name: context-builder
description: For a single ticker given as argument, pull newly-fetched IR AND per-ticker news from the Worker (each since its own cursor), then update that ticker's standing GitHub Issue body — a *living context* for the name (business shape, product lineup / tech roadmap, capital & management decisions, and a rolling summary of the latest material topics). It does NOT decide buy/sell. After updating the body it fires the signal-judge workflow. One-shot; designed for GitHub Actions, fired by the Worker on new IR or news.
---

# context-builder

This skill maintains the **living context** for a ticker in its standing GitHub Issue. It reads
newly-fetched IR and per-ticker news and folds what matters into the Issue body, so that the body
is always the best single-page brief for understanding the name.

**It does not produce a buy/sell call** — judging is the separate `signal-judge` skill.
context-builder writes the Issue; signal-judge reads it and writes only to Slack.

**The system is built for SWING trading (holding several days to a few weeks).** Frame the context
toward that horizon — what a swing trader needs to know to read this name's next few weeks.

## Invocation

```
/context-builder 285A @/path/to/ctxin.json
```

`<ticker>` is the symbol this run owns. The `@<path>` second argument is the **input context**
JSON the workflow computed at launch (`scripts/context-input.sh` output) — the existing Issue, the
two cursors, and the newly-fetched IR/news already pulled since each cursor. **Read this file** for
all of it (the Issue, cursors, and items are already in the JSON).

Fired by the Worker's `repository_dispatch` (`signal-update`, one dispatch per ticker) when new IR
or news arrives, or manually.

## Steps

### 1. Read the ticker's metadata

Read the `<ticker>` entry from `config/watchlist.yaml` and cache `name` / `fair_per` / `sector`.

### 2. Read the input context JSON and branch on `status`

Read the `@<path>` JSON. Its `status` decides the whole run:

- `status: "no-issue"` → no standing Issue for this ticker. Print `<ticker> no-issue (skipped)` and
  exit. (Standing Issues are provisioned once, out of band.)
- `status: "no-update"` → the Issue exists but **both** new-item counts are 0. Print
  `<ticker> ir=0 news=0 (no update)` and exit (leave the Issue as-is, skip signal-judge).
- `status: "ok"` → there are new items. Continue to step 3.

For `status: "ok"`, the JSON carries everything you need:
```
{
  "status": "ok",
  "issue_number": 12,
  "issue_body": "<the WHOLE existing body — the context you are amending, not replacing wholesale>",
  "cursors": {
    "ir":   { "current": "<old>", "next": "<advance to this>" },
    "news": { "current": "<old>", "next": "<advance to this>" }
  },
  "ir_count": 2, "news_count": 1,
  "ir_items":   [{ "url", "title", "published_at", "ir_category", "fetched_at", "body" }, ...],
  "news_items": [{ ... same shape, "ir_category" is null ... }]
}
```
`ir_items` are IR (official IR + TDnet + `rating`); `news_items` are per-ticker news. Both are
already filtered to "since each cursor" and ordered oldest-first. Use `cursors.*.next` verbatim when
you rewrite the body (step 5) — the workflow already computed the correct max `fetched_at` per kind
and left a kind's cursor unchanged when it had 0 new rows.

### 4. Read each new item and decide what is material to the *context*

This is a context update, **not** a judgment. For each item in `ir_items` / `news_items` ask: *does
this change how the name should be understood over the next weeks?* Fold in only what shifts the
picture; drop pure restatements and noise.

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
- A buy/sell call. Never write a recommendation into the body.
- Intraday price moves, PTS premiums, single-session volume spikes.
- Stale rehashes of already-recorded facts.

**Recency:** treat items by `published_at`. Recent material updates the relevant section AND the
rolling "直近の重大トピック" list. Items older than ~30 days are background only — fold into the
structural sections if genuinely new to the body, but never into the rolling-topics list.

**証券会社レーティング (`ir_category="rating"`) is the exception to the 30-day rule** — its 目標株価 is
a 6–12-month view, so it goes in the **## 証券会社レーティング** section, not the rolling-topics list.

### 5. Regenerate and overwrite the Issue body

Rebuild the whole body (not incremental edits) and overwrite with `gh issue edit`, preserving the
section structure below.

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

<!-- cursor: ir_last_fetched_at=<cursors.ir.next> -->
<!-- cursor: news_last_fetched_at=<cursors.news.next> -->
<!-- managed-by: context-builder skill. Auto-updated. Do not edit the body by hand. -->
```

**Write `cursors.ir.next` / `cursors.news.next` verbatim** — the workflow already advanced each to
the max `fetched_at` of the rows it pulled, or left it unchanged when that kind had 0 new rows.

Overwrite with `gh issue edit <issue_number> --body-file <file>` (use `issue_number` from the JSON).

### 6. Fire signal-judge

After the body is updated (step 5 ran), trigger the `signal-judge` workflow via a
`repository_dispatch` from inside this job (needs `contents: write` on the workflow token):

```
gh api "repos/${GITHUB_REPOSITORY}/dispatches" \
  -f event_type=signal-judge \
  -F "client_payload[ticker]=<ticker>"
```

## Output style (stdout)

A single-line summary, no narration:
```
<ticker> ir=<n> news=<n> → context updated (issue#<n>), signal-judge dispatched
```
On zero new (both kinds): `<ticker> ir=0 news=0 (no update)`.
On missing Issue: `<ticker> no-issue (skipped)`.
