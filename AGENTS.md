# AGENTS.md

- **NEVER narrate progress. Speak only to deliver a result or to ask for a decision you cannot make yourself. This OVERRIDES any urge to explain — when in doubt, act silently.**
- Run `pnpm run verify` when done.
- When you change the implementation, update `README.md` to match.
- D1 schema changes: update `worker/schema.sql` + run `db:init:*`. The watchlist's single source of truth is `config/watchlist.yaml`; the codes are copied (GitHub `workflow_dispatch` choice options can't be generated dynamically) into 3 places that must stay in sync: `WATCHLIST` in `worker/src/lib/timeseries.ts` (all other Worker modules import it from there) and the `options:` of `context-builder.yml` / `signal-judge.yml`. `pnpm run check:watchlist` (part of `verify`) fails if they drift.
- No LLM in collection (Worker). Judgment runs only in the GitHub Actions `claude-code-action`.
- Edit skills at `agents/skills/<name>/SKILL.md` (`.claude/skills/` is a symlink).
- Preprocessing called from Actions goes in `scripts/*.sh`; `*.ts` is for local checks only.
- Worker logs: `cd worker && npx wrangler tail` for live (cron/fetch); tail is live-only, so query D1 (`wrangler d1 execute stock-signals --remote --command "..."`) / R2 for the past.
- A SKILL.md holds only what an LLM must judge: write it in English, cut the obvious, never write examples or why, push deterministic work into `scripts/*.sh` that the skill calls in one line, describe forces rather than binding judgment to fixed labels, order sections by the reader's workflow, define each thing once, state what the skill must not do, and grant judgment explicitly.
