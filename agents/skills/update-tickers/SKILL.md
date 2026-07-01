---
name: update-tickers
description: Add or remove one monitored ticker on the watchlist from a securities code, then regenerate the workflow mirrors. Edits source only — no prices/context/Slack, no D1. One-shot; run manually.
---

# update-tickers

`TICKERS` in `worker/src/lib/watchlist.ts` is the single source of truth; the workflow choice options are
generated from it. Edit `TICKERS`, then run `pnpm run gen:watchlist && pnpm run check:watchlist`.

- `add <code> [name] [key=value ...]` — add one ticker; copy an existing entry's shape.
- `remove <code>` — drop the matching entry; no match → report the misfire and stop.

Do not touch prices, context, Slack, or D1.

## Judgment when adding

Copy field shapes from a neighbor; these need a call, not a lookup:

- `sector` / `sector_role` — relative strength is compared only within a sector, so a fresh sector name is
  fine for a non-semiconductor name.
- `ir` — set `{ site, list_url }` only when `parseList` in `worker/src/lib/ir-sources.ts` already handles that
  site; otherwise omit it (the name skips IR scraping). Never invent a `site` with no parser.
- `next_earnings_date` — with no official date, estimate from the prior-year same quarter.
- `fair_per` — the forward PER you judge fair here; `null` for none.

Can't confirm a value? Enter your estimate and mark it in a line comment. Flag any estimated
`next_earnings_date` / `fair_per` and any omitted `ir` in the final report.
