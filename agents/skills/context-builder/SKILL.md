---
name: context-builder
description: For a single ticker given as argument, pull newly-fetched IR AND per-ticker news from the Worker (each since its own cursor), then update that ticker's *living context* stored in D1 (Worker /context) — business shape, product lineup / tech roadmap, capital & management decisions, and a rolling summary of the latest material topics. It does NOT decide buy/sell. After updating the context it posts the full body to a Slack channel and fires the signal-judge workflow. One-shot; designed for GitHub Actions, fired by the Worker on new IR or news.
---

# context-builder

Update one ticker's *living context* (the Worker's D1 `/context` store). Do not decide buy/sell. Write the context for a SWING-trading horizon (holding several days to a few weeks).

## Invocation

```
/context-builder 285A @/path/to/ctxin.json
```

First arg `<ticker>` is the symbol this run owns. Second arg `@<path>` is the input JSON from `scripts/context-input.sh` (the existing context body, the two cursors, and the newly-fetched IR/news pulled since each cursor).

## Steps

### 1. Read the ticker's metadata

Read the `<ticker>` entry from `config/watchlist.yaml`; take `name` / `fair_per` / `sector`.

### 2. Read the input JSON and branch on `status`

Read the `@<path>` JSON.

- `status: "no-update"` → print `<ticker> ir=0 news=0 (no update)` and exit. Skip the Slack post and signal-judge.
- `status: "ok"` → continue to step 3.

`ir_items` are IR (official IR + TDnet + `rating`); `news_items` are per-ticker news. Both are already filtered to since each cursor and ordered oldest-first. Empty `context_body` means first run — build the body from scratch (step 4). Pass `cursors.*.next` verbatim to the script in step 5.

### 3. Read each new item and select what is material to the context

For each item, decide whether it changes how the name should be understood over the next weeks. Fold in only what shifts the picture; drop restatements and noise.

Fold into the context:
- **Management & capital decisions** — capex plans, capacity ramp up/down, M&A / alliances / supply agreements, buybacks / dilution / financing, leadership or strategy changes.
- **Product lineup & tech roadmap** — product generations and their cycle position (e.g. BiCS layer count, HBM entry, tester/inspection generations), wins/losses vs competitors, customer-concentration shifts.
- **Structural supply/demand** — position in the price cycle, inventory, end-market demand signals that persist beyond a day.
- **Earnings & guidance** — results vs expectations and revised guidance (durable facts, not the tape reaction).

Keep out of the body:
- A buy/sell recommendation.
- Intraday price moves, PTS premiums, single-session volume spikes.
- Rehashes of already-recorded facts.

Treat items by `published_at`. A recent material update revises both the relevant section AND the "直近の重大トピック" list. Items older than ~30 days fold into the structural sections only, never the topics list.

Securities ratings (`ir_category="rating"`) are the exception to the 30-day rule: the target price is a 6–12-month view, so put it in the **## 証券会社レーティング** section, not the topics list.

### 4. Regenerate the whole body to a file

Rebuild the whole body (not incremental edits), keep the section structure below, and write it to a file (e.g. `/tmp/<ticker>-context.md`).

Body structure (Japanese; keep these headings stable — signal-judge reads them):

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
```

### 5. Commit the body: upsert, post to Slack, fire signal-judge

Pass the body file and the advanced cursors (`cursors.ir.next` / `cursors.news.next`, verbatim). The script upserts the context to the Worker, posts the full body to `$SLACK_CONTEXT_CHANNEL` (skipped if empty), and fires the signal-judge workflow.

```
bash scripts/post-context.sh <ticker> /tmp/<ticker>-context.md "<cursors.ir.next>" "<cursors.news.next>"
```

## Output style (stdout)

One-line summary:
```
<ticker> ir=<n> news=<n> → context updated (D1), slack posted, signal-judge dispatched
```
When both kinds have zero new items: `<ticker> ir=0 news=0 (no update)`.
