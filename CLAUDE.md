# CLAUDE.md

Rules for implementation. See `README.md` for structure and rationale.

- Run `pnpm run verify` when done.
- When you change the implementation, update `README.md` to match.
- Imports use `.ts` extensions; don't reorder them.
- D1 schema changes: update `worker/schema.sql` + run `db:init:*`. The watchlist's single source of truth is `config/watchlist.yaml`; the codes are copied (GitHub `workflow_dispatch` choice options can't be generated dynamically) into 3 places that must stay in sync: `WATCHLIST` in `worker/src/lib/timeseries.ts` (all other Worker modules import it from there) and the `options:` of `context-builder.yml` / `signal-judge.yml`. `pnpm run check:watchlist` (part of `verify`) fails if they drift.
- No LLM in collection (Worker). Judgment runs only in the GitHub Actions `claude-code-action`.
- Edit skills at `agents/skills/<name>/SKILL.md` (`.claude/skills/` is a symlink).
- Preprocessing called from Actions goes in `scripts/*.sh`; `*.ts` is for local checks only.
- Worker のログ調査は `cd worker && npx wrangler tail` で本番のリアルタイムログを見る (cron 発火や fetch の挙動確認)。`--format pretty` で整形、`--status error` でエラーのみ、`npx wrangler tail --search "<ticker>"` で絞り込み。過去分は tail に残らないので D1 (`wrangler d1 execute stock-signals --remote --command "..."`) / R2 を直接クエリする。
- Don't narrate progress step by step; ask the user only when you actually need a decision or input.
