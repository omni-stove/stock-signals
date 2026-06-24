# AGENTS.md

- There is no `CLAUDE.md`; do not create one.
- Never switch branches; work on the current branch only.
- Never `cd`; run commands from the repo root with a path or filter.
- Run `pnpm run verify` when done.
- When you change the implementation, update `README.md` to match.
- D1 schema changes: edit `worker/src/lib/schema.ts` (single source of truth), then `pnpm db:generate` (review the diff SQL in `worker/drizzle/`) + `pnpm db:migrate:local`/`:remote`. No hand-written `schema.sql`.
- The watchlist's single source of truth is `TICKERS` in `worker/src/lib/watchlist.ts` (Worker imports it directly; `WATCHLIST` / `WATCHLIST_NAMES` / `WATCHLIST_META` / `IR_SOURCES` derive from it). Run `pnpm run gen:watchlist` to regenerate the `options:` of `context-builder.yml` / `signal-judge.yml`; `pnpm run check:watchlist` guards drift.
- No LLM in collection (Worker). Judgment runs only in the GitHub Actions `claude-code-action`.
- Edit skills at `agents/skills/<name>/SKILL.md` (`.claude/skills/` is a symlink).
- `scripts/*.sh`: preprocessing called from Actions. `scripts/*.ts`: tools run via `pnpm run`, never called by Actions at runtime.
- Write tests in-source: an `if (import.meta.vitest) { ... }` block at the end of the module under test.
- Worker logs: `wrangler tail` is live-only; query D1 / R2 for the past.
- Local secrets live in `worker/.dev.vars`.
