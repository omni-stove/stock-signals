---
name: context-builder
description: For one ticker, fold newly-fetched IR and news into that ticker's *living context* and regenerate it. It does NOT decide buy/sell. One-shot; fired by the Worker on new IR or news.
---

# context-builder

Regenerate one ticker's *living context* for a SWING-trading horizon (several days to a few weeks). Do not decide buy/sell.

The bar for every line is whether it moves the swing call over the next weeks, not whether it is
true or on-topic. Carry the judgment-bearing fact, not the catalog entry behind it: drop model
numbers, spec figures, awards, release dates, person names, fund/legal entity names, trademark
symbols (™/®), and sub-product variant lists. When a section would enumerate variants (e.g. several
SSD grades, several chip families), collapse them into the single line that carries the call —
name the market shift, not the SKUs. When in doubt, cut.

One fact lives in exactly one section. If the same event would fit two sections, write it where its
*lasting* effect belongs and do not restate it elsewhere — a topic line and a structural line must
not say the same thing. Before writing the body, scan for any fact that appears twice and keep only
the strongest single placement.

## Inputs

A `<ticker>` (the symbol this run owns), one input JSON to **read** (`ticker_meta` with the ticker's
`name` / `fair_per` / `sector` / `note`; the existing context body; the two cursors; and the
newly-fetched IR/news pulled since each cursor), and two output paths to **write**: `body=<path>` for
the regenerated context body and `cursors=<path>` for the advanced cursors. Do not post to Slack; do
not upsert; do not run any script — write the two files and stop.

## Steps

### 1. Read the input JSON and branch on `status`

Read the `@<path>` JSON. Take `ticker_meta` for the heading `name` and any judgment context.

- `status: "no-update"` → write neither output file, print `<ticker> ir=0 news=0 (no update)`, exit.
- `status: "ok"` → continue to step 2.

`ir_items` are IR (official IR + TDnet + `rating`); `news_items` are per-ticker news. Both are already filtered to since each cursor and ordered oldest-first. Empty `context_body` means first run — build the body from scratch (step 3).

### 2. Read each new item and select what is material to the context

Keep an item only when it shifts the swing call: a management or capital decision, a generation
move in the product lineup or roadmap, a structural supply/demand turn that outlives a session, or
earnings/guidance against expectations. Reduce each to its judgment-bearing fact. Never a buy/sell
view, the day's tape, or a restatement of something already recorded.

`published_at` governs where a fact lands, not whether it counts. A fresh material fact lands in one
place: the 直近の重大トピック list while its near-term effect is live, then it leaves the list once
that effect is spent and only its lasting consequence survives — folded into a structural section,
not duplicated as a topic. Do not carry the same fact as both a topic and a structural line at once.
Securities ratings (`ir_category="rating"`) are the exception: route them to
**## 証券会社レーティング** regardless of age, never the topics list.

### 3. Regenerate the whole body

Rebuild the whole body (not incremental edits), keep the section structure below, and write it to the `body=<path>` file.

Body structure (Japanese; keep these headings stable):

```markdown
# [<ticker> <name>] 銘柄コンテキスト

## 事業の骨格
<rarely-changing structural facts: what the company is, where it sits in the value chain,
 production base, technology lineage. A few lines that tell a continuation from a reversal, not a
 company profile.>

## 商品ラインナップ / 技術ロードマップ
<the current generation and where the next one stands; one line per product line, named by
 generation and market position only.>

## 経営判断・資本政策
<capex / capacity / M&A / alliances / capital policy; accumulate and revise on material events>

## 直近の重大トピック
<rolling, newest first by date. Each line: `- YYYY-MM-DD: <one-line summary> — <その先数週間への効き>`,
 the summary tight enough to stay one line. Keep roughly the last ~6–10 entries; push older ones down
 or prune once their effect is absorbed into the structural sections above.>

## 証券会社レーティング
<newest first: `- YYYY-MM-DD <機関>: <格付> 目標株価 <値> [信頼度: …]`. Keep while in ~12-month
 horizon; drop when the same 機関 issues a newer call. Empty if none.>

## 決算の特色・クセ
<structural reaction pattern of this name's earnings: focus metric, ガイダンス vs 実績 の効き方,
 ピア連動. When empty, research it once (web / past IR) and fill. Otherwise revise only when fresh
 `ir_items` carry a 決算/業績修正/ガイダンス item; else carry it forward verbatim.>

## 決算・ガイダンス
<latest results vs expectations, current guidance, known next-earnings considerations — facts only>
```

### 4. Write the advanced cursors

Write the `cursors=<path>` file: line 1 = `cursors.ir.next` verbatim, line 2 = `cursors.news.next`
verbatim (empty line if a cursor is null).

## Output style (stdout)

One-line summary:
```
<ticker> ir=<n> news=<n> → body + cursors written
```
When both kinds have zero new items: `<ticker> ir=0 news=0 (no update)`.
