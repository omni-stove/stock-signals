---
name: add-ticker
description: Add one monitored ticker to the watchlist from a securities code, then regenerate the workflow mirrors. It edits source only — it does NOT fetch prices, build context, or post to Slack. One-shot; run manually when adding a name to monitor.
---

# add-ticker

Add one entry to `TICKERS` in `worker/src/lib/watchlist.ts` — the single source of truth — then run
`npm run gen:watchlist` to regenerate the GitHub Actions choice options. Edit only this file; never
hand-edit the generated workflow options.

This skill edits source only. It does not fetch prices, build context, or post to Slack — the normal
cron / workflows pick the name up after it is added.

When a value is missing, do not stop to ask the user: research it via web / IR and fill it. Where a
value can't be confirmed, enter an estimate and mark it in a line comment, matching the existing
entries' comment style.

## Inputs

`<code>` (securities code) is required. Further args are optional: a company name, or `key=value`
overrides.

## Steps

### 1. Read one existing entry to learn the format

Read an existing `TICKERS` entry and follow its fields, types, and comment style. Leave the long
field-explanation comment block at the top untouched.

### 2. Fix the new ticker's values

Fill these to the same granularity as the existing entries:

- `code` / `name` — required. If name is unspecified, look up the formal company name on the web.
- `sector` / `sector_role` — sector identifier and the name's position within it. A new sector name
  is fine for non-semiconductor names (relative strength is compared only within a sector).
- `aliases` — alternate names / abbreviations / English names used to match the ticker in news text.
- `keywords` — context words for this name (industry, products).
- `ir_url` — official IR / press-release index page (human-facing reference).
- `ir` — official-IR scrape definition `{ site, list_url }`. Set it only when an existing parser in
  `worker/src/lib/ir-sources.ts` (`parseList`) already handles the site's list structure; otherwise
  omit `ir` (the name is then excluded from IR scraping). Adding a new site needs a new parser there
  — do not invent a `site` value with no parser.
- `news_url` — kabutan ticker news: `https://kabutan.jp/stock/news?code=<code>`.
- `next_earnings_date` — next scheduled earnings (YYYY-MM-DD). With no official date, estimate from
  the prior-year same-quarter date; the eod cron overwrites it later.
- `fair_per` — the forward PER you judge fair for this name (subjective). `null` if none.

### 3. Insert into TICKERS

Insert into `TICKERS[]` in its natural sort order, matching the surrounding indentation and comment
style. Edit only `watchlist.ts` — never hand-edit the generated workflow options.

### 4. Regenerate workflow options

```
npm run gen:watchlist
```

### 5. Verify

```
npm run check:watchlist
```

### 6. Report in one line

stdout, no narration:

```
add-ticker <code> (<name>) → watchlist.ts + gen mirrors, check:watchlist <ok|FAIL>
```

If any value was estimated (next_earnings_date / fair_per), or `ir` was omitted for lack of a parser,
note that one point. Add that prices / context / Slack were not touched and the next cron / workflow
picks up the first data.
