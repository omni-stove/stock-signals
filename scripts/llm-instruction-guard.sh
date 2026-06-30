#!/usr/bin/env bash
# PreToolUse(Edit|Write) hook: when the target file is an LLM-facing instruction
# document, inject the authoring rules so they are in front of the model before it writes.
set -euo pipefail

input="$(cat)"
file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"
[ -z "$file" ] && exit 0

case "$file" in
  *_LLM_INSTRUCTION_RULES.md|*SKILL.md|*AGENTS.md|*CLAUDE.md|*.github/*.yml|*.github/*.yaml|*/prompts/*|*/docs/*.md)
    rules="$(cat "$(dirname "$0")/../agents/skills/_LLM_INSTRUCTION_RULES.md")"
    jq -n --arg ctx "$rules" \
      '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$ctx}}'
    ;;
  *)
    exit 0
    ;;
esac
