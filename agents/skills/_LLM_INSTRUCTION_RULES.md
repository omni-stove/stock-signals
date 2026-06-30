# Rules for writing any LLM-facing instruction (SKILL.md, AGENTS.md, prompts, command/workflow defs)

Hold only what the LLM must judge.

- Write it in English.
- Cut the obvious.
- Write what to do, not why or examples.
- Describe forces rather than binding judgment to fixed labels.
- Order sections by the reader's workflow.
- Define each thing once.
- State what it must not do.
- Grant judgment explicitly.

## When the instruction drives a skill

- Push deterministic work into `scripts/*.sh` the skill calls in one line.
- Name a command the skill runs and what it does in one line — never explain how it works inside.
- Keep the frontmatter `description` to the trigger and the shape of the work, not the full procedure.

## When the instruction judges from supplied context (e.g. a workflow `prompt:`)

- For each input field, say what to lead on, what only confirms, and what to ignore.
- Say how to treat a stale, insufficient, or unavailable input — demote or skip it.
- Bound what it may judge on: only what it can see now, never hindsight or a future bar.
- Forbid every side effect, then have it return structured output and stop.
- Mark any output line that gets machine-parsed as exact-format, verbatim.
