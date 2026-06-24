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
- For a SKILL.md: push deterministic work into `scripts/*.sh` the skill calls in one line.
- For a command the skill runs: name it and what it does in one line — never explain how it works inside.
- Keep the frontmatter `description` to the trigger and the shape of the work, not the full procedure.
