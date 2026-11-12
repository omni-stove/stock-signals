# AGENTS.md

## Workflow

- Never switch branches; work on the current branch only.
- Never `cd`; run commands from the repo root with a path or filter.
- Local secrets live in `worker/.dev.vars`; source them into the env before running any `scripts/*.sh` locally.

## Architecture

- No LLM in collection (Worker). Judgment runs only in the GitHub Actions `claude-code-action`.
- `scripts/*.ts` are manual tools; never call them from Actions.
- LLM judgment rules live inline in each workflow's `prompt:` (`.github/workflows/*.yml`); edit the prompt there, not a skill file.
- D1 schema changes: edit `worker/src/lib/schema.ts`, then `pnpm db:generate`.

## Code & docs

- Test TS in-source in the module under test, not in separate test files.
- Test `scripts/*.sh` in a sibling `*.bats`.
- In docs/comments/messages, write the current state only; omit history, rationale, and "previously" unless skipping it invites a real bad practice.
- Keep `README.md` user-facing and minimal; leave out implementation details and anything a user learns by using it.
