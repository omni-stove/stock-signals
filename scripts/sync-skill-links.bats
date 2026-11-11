#!/usr/bin/env bats

setup() {
  ROOT="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$ROOT/scripts" "$ROOT/agents/skills/local" "$ROOT/.claude/skills"
  cp "$BATS_TEST_DIRNAME/sync-skill-links.sh" "$ROOT/scripts/"
  touch "$ROOT/agents/skills/local/SKILL.md"
  KIT="$BATS_TEST_TMPDIR/kit"
  mkdir -p "$KIT/kit-skill" "$KIT/local"
}

@test "links an agents/skills skill with a relative symlink" {
  run bash "$ROOT/scripts/sync-skill-links.sh"
  [ "$status" -eq 0 ]
  [ "$(readlink "$ROOT/.claude/skills/local")" = "../../agents/skills/local" ]
}

@test "keeps skill-kit symlinks" {
  ln -s "$KIT/kit-skill" "$ROOT/.claude/skills/kit-skill"
  run bash "$ROOT/scripts/sync-skill-links.sh"
  [ "$status" -eq 0 ]
  [ "$(readlink "$ROOT/.claude/skills/kit-skill")" = "$KIT/kit-skill" ]
}

@test "agents/skills wins a name clash with skill-kit" {
  ln -s "$KIT/local" "$ROOT/.claude/skills/local"
  run bash "$ROOT/scripts/sync-skill-links.sh"
  [ "$status" -eq 0 ]
  [ "$(readlink "$ROOT/.claude/skills/local")" = "../../agents/skills/local" ]
}

@test "removes the symlink of a skill gone from the source" {
  ln -s "../../agents/skills/gone" "$ROOT/.claude/skills/gone"
  run bash "$ROOT/scripts/sync-skill-links.sh"
  [ "$status" -eq 0 ]
  [ ! -L "$ROOT/.claude/skills/gone" ]
}
