# AGENTS.md

## Workflow

- Never switch branches; work on the current branch only.
- Never `cd`; run commands from the repo root with a path or filter.
- Local secrets live in `worker/.dev.vars`; source them into the env before running any `scripts/*.sh` locally.

## Design

- Never output buy/sell direction, limit price, stop-loss, or position actions; LLMs only research news and organize judgment material.
- Keep LLMs out of collection: the Worker does all fetching and normalization, and judgment runs only in the GitHub Actions `claude-code-action`.
- Never let an LLM produce numbers; post scripts build every figure from real data.
- Use web search only to corroborate collected data, and cite the source.
- Never implement or propose anything in `docs/non-goals.md`; add newly decided non-goals there.

## Architecture

- `context-builder` maintains each ticker's context; `ticker-brief` builds the brief from it plus price and market state.
- `market-brief` posts market-wide facts before the open; ticker briefs use it as background only.
- Keep LLM inputs lean: add a `/judge-context` block only by merging into an existing one or removing another (`JUDGE_BLOCKS`); market-wide data goes to `market-brief`, not ticker inputs.
- `scripts/*.ts` are manual tools; never call them from Actions.
- LLM judgment rules live inline in each workflow's `prompt:` (`.github/workflows/*.yml`); edit the prompt there, not a skill file.
- D1 schema changes: edit `worker/src/lib/schema.ts`, then `pnpm db:generate`.

## Code & docs

- Test TS in-source in the module under test, not in separate test files.
- Test `scripts/*.sh` in a sibling `*.bats`.
- In docs/comments/messages, write the current state only; omit history, rationale, and "previously" unless skipping it invites a real bad practice.
- Keep `README.md` user-facing and minimal; leave out implementation details and anything a user learns by using it.
