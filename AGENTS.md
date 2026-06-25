# AGENTS.md

## Workflow

- Never switch branches; work on the current branch only.
- Never `cd`; run commands from the repo root with a path or filter.
- Local secrets live in `worker/.dev.vars`; source them into the env before running any `scripts/*.sh` locally.
- When something breaks, check the logs first; for the past, query D1 / R2.

## Architecture

- No LLM in collection (Worker). Judgment runs only in the GitHub Actions `claude-code-action`.
- `scripts/*.sh`: preprocessing called from Actions.
- `scripts/*.ts`: tools run via `pnpm run`, never called by Actions at runtime.
- Edit skills at `agents/skills/<name>/SKILL.md` (`.claude/skills/` is a symlink).
- D1 schema changes: edit `worker/src/lib/schema.ts`, then `pnpm db:generate`.

## Code & docs

- Test TS in-source in the module under test, not in separate test files.
- Test `scripts/*.sh` in a sibling `*.bats`.
- In docs/comments/messages, write the current state only; omit history, rationale, and "previously" unless skipping it invites a real bad practice.
- When you change the implementation, update `README.md` to match.
- Keep `README.md` user-facing; leave implementation details to the code.
