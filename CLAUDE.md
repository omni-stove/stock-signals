# CLAUDE.md

Rules for implementation. See `README.md` for structure and rationale.

- Run `pnpm run verify` when done.
- When you change the implementation, update `README.md` to match.
- Imports use `.ts` extensions; don't reorder them.
- D1 schema changes: update `worker/schema.sql` + run `db:init:*`. When adding to the watchlist, also sync `WATCHLIST` in `ratings.ts`.
- No LLM in collection (Worker). Judgment runs only in the GitHub Actions `claude-code-action`.
- Edit skills at `agents/skills/<name>/SKILL.md` (`.claude/skills/` is a symlink).
- Preprocessing called from Actions goes in `scripts/*.sh`; `*.ts` is for local checks only.
