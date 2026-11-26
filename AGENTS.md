# AGENTS.md

## Workflow

- Never `cd`; run commands from the repo root with a path or filter.
- Source `worker/.dev.vars` into the env before running a `scripts/*.sh` locally.

## Design

- The Worker does all fetching and normalization; LLMs only judge and organize what it collected, in the GitHub Actions `claude-code-action`. Use web search only to corroborate collected data, and cite the source.
- Keep buy/sell actions, limit price, stop-loss, and position actions out of every prompt and output schema rather than listing them as prohibitions. Only `ticker-brief` and `slack-reply` state a directional lean (Bull/Bear), with its basis and reversal condition.
- LLMs never produce a figure; post scripts build every figure and signal deterministically from real data.
- Never implement or propose anything in `docs/non-goals.md`; add newly decided non-goals there.

## Architecture

- `context-builder` maintains each ticker's context; `ticker-brief` builds the brief from it plus price and market state.
- `market-brief` posts market-wide facts before the open; market-wide data goes there, and ticker briefs use it as background only.
- Add a `/judge-context` block only by merging it into an existing one or removing another (`JUDGE_BLOCKS`).
- `scripts/*.ts` are manual tools; never call them from Actions.
- LLM judgment rules live inline in each workflow's `prompt:` (`.github/workflows/*.yml`); edit them there, not in a skill file. In it, say for each input field what to lead on, what only confirms, and what to ignore; and how to treat a stale, insufficient, or unavailable input. Do not define a field, value, or sign that its name already makes clear. Have it return structured output and stop, and mark each machine-parsed output line as exact-format, verbatim.
- D1 schema changes: edit `worker/src/lib/schema.ts`, then run `pnpm -C worker db:generate`.

## Code & docs

- Test TS in-source in the module under test.
- Test `scripts/*.sh` in a sibling `*.bats`.
- In docs and messages, write the current state only; omit history, rationale, and "previously" unless skipping it invites a real bad practice.
- Keep `README.md` user-facing and minimal; leave out implementation details and anything a user learns by using it.

# Code rules

A JSDoc or docblock states behavior: what the function does, its inputs and outputs, how it is used. Every other comment states only why the straightforward alternative was not taken, or the constraint that binds the code. Delete a comment that restates the implementation, also in code you did not write.

Change a generated file by changing its source and regenerating it.
