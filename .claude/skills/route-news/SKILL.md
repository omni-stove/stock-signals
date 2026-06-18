---
name: route-news
description: Watch data/inbox/ for macro articles and route each one to the relevant ticker queues under data/queue/<ticker>/. Unrelated articles go to data/archive/unmatched/.
---

# route-news

**SILENT MODE — STRICT. Read this first.**

This skill MUST produce no user-visible text during normal operation. No status lines, no progress reports, no per-article summaries, no "starting...", "done", "processed N", "watcher launched", etc.
Respond with tool calls only. Acknowledgements such as "OK" or "understood" are also forbidden.

The only allowed exceptions:
1. The watcher process has died twice in a row and cannot be restarted → emit one short error line and exit.
2. The user explicitly asks for status → answer concisely.

All progress and results go to `./logs/route-news.log` as JSONL. The user tails that file; the terminal stays quiet.

---

## Scope

This skill handles **macro articles only**. The fetcher's `macro_html` path deposits cross-ticker news into `./data/inbox/`. Articles fetched from per-ticker pages go straight to `./data/queue/<ticker>/` and are NOT touched here.

## Startup sequence

1. Launch the watcher in the background:
   ```
   Bash(run_in_background=true): node scripts/route-news-watch.ts
   ```
   stdout line protocol:
   - `<absolute-path>` — a file to process
   - `READY` — initial existing-scan finished
   - `ERROR <msg>` — recoverable error (continue)

2. Use `Monitor` on that process's stdout. For every line:
   - If it ends with `.json`, run the processing loop below.
   - `READY` is a marker; no action needed.
   - `ERROR` lines: append to `./logs/route-news.log` and continue.

3. If the watcher dies, restart it once. If it dies again, emit a single error line to the user and exit.

## Processing loop (one file per article)

1. Load `./config/watchlist.yaml` and `./config/related-signals.yaml` (cache both).
2. Read the article JSON. Shape:
   ```json
   {
     "id": "...",
     "fetched_at": "...",
     "source": "kabutan-marketnews",
     "url": "...",
     "title": "...",
     "body": "..."
   }
   ```
3. For each ticker in the watchlist, decide **related / not related** using:
   - **Direct match**: Any `aliases` literal appears in title/body → almost certainly related.
   - **Keyword + context**: `keywords` hit AND the article context matches the company's business → related.
   - **Macro broadcast**: Macro semiconductor news (HBM supply/demand, capex, memory pricing, EUV, etc.) MAY be broadcast to 6857 / 6920 / 285A.
   - **Proxy match (related-signals.yaml)**: For each proxy entry, if any `aliases` literal appears in title/body, add every ticker in `affects` to the matched set. Use the proxy's `reason_template` as the `matched_reason`.
   - Industry-only news with no company mention and no proxy hit → not related.
   - If a ticker matches via BOTH direct and proxy, prefer the direct reason (proxy is the weaker signal).
4. Copy the article to `./data/queue/<ticker>/<id>.json` for each matched ticker (copy, not move — multi-match needs multiple destinations). Add to the JSON:
   ```json
   {
     "routed_at": "...",
     "matched_reason": "<one short Japanese line — for proxy matches use the proxy's reason_template verbatim, e.g. 'NVIDIA経由（AI半導体需要のドライバー）'>"
   }
   ```
5. Move the original to `./data/archive/routed/<id>.json`.
6. If no ticker matched, move the original to `./data/archive/unmatched/<id>.json`.
7. Append one JSONL line to `./logs/route-news.log`:
   ```jsonl
   {"ts":"...","article_id":"...","matched":["6857","285A"],"reason":"...","via":"direct|proxy:NVDA|macro"}
   ```
   - `via` records how the match was made. If different tickers matched via different paths, record an object keyed by ticker, e.g. `"via":{"6857":"proxy:NVDA","285A":"direct"}`.

## Anti-patterns

- Do NOT include marginal matches "just in case" — it makes downstream analyze-ticker noisy.
- When unsure, send to `./data/archive/unmatched/`, not to a queue.
- Do not process the same article twice (the archive move guarantees idempotency, but a crash between copy and move can produce a duplicate — that is acceptable; do not add extra locking).
- Never log judgements to stdout. `./logs/route-news.log` is the only sink.

**SILENT MODE — STRICT. (re-stated)** No status text, no summaries, no acknowledgements. Tool calls only.
