# AGENTS.md

- Run `pnpm run verify` when done.
- When you change the implementation, update `README.md` to match.
- D1 schema changes: update `worker/schema.sql` + run `db:init:*`.
- The watchlist's single source of truth is `config/watchlist.yaml`; keep `WATCHLIST` in `worker/src/lib/timeseries.ts` and the `options:` of `context-builder.yml` / `signal-judge.yml` in sync with it. `pnpm run check:watchlist` guards drift.
- No LLM in collection (Worker). Judgment runs only in the GitHub Actions `claude-code-action`.
- Edit skills at `agents/skills/<name>/SKILL.md` (`.claude/skills/` is a symlink).
- Preprocessing called from Actions goes in `scripts/*.sh`; `*.ts` is for local checks only.
- Worker logs: `wrangler tail` is live-only; query D1 / R2 for the past.
- Any document that instructs an LLM (SKILL.md, AGENTS.md, prompts, command/workflow definitions, …) holds only what the LLM must judge: write it in English, cut the obvious, never write examples or why, describe forces rather than binding judgment to fixed labels, order sections by the reader's workflow, define each thing once, state what it must not do, and grant judgment explicitly. For a SKILL.md specifically, also push deterministic work into `scripts/*.sh` that the skill calls in one line. These rules live in `agents/skills/_LLM_INSTRUCTION_RULES.md` and a PreToolUse hook (`scripts/llm-instruction-guard.sh`) injects them before any such file is edited.
