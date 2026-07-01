#!/usr/bin/env bash
# scripts/sync-skill-links.sh
# agents/skills/<name>/SKILL.md を持つ各スキルについて、Claude Code が読む .claude/skills/<name>
# を agents/skills/<name> への相対 symlink として貼り直す。agents/skills/ が唯一のソースで、
# .claude/skills/ はそのミラー。スキルを増やしたら or 手元の symlink が抜け/壊れていたら流す。
#
# 冪等: 既に正しい相対 symlink が張られている項目はスキップ、抜け・壊れ・別実体は貼り直す。
# .claude/skills/ 側にしか無い項目 (ソースから消えたスキル) は削除する。
# SKILL.md を持たないディレクトリ (_LLM_INSTRUCTION_RULES.md 等) はスキルではないので対象外。

set -euo pipefail
shopt -s nullglob

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT/agents/skills"
DST_DIR="$ROOT/.claude/skills"

[[ -d "$SRC_DIR" ]] || { echo "sync-skill-links.sh: not found: $SRC_DIR" >&2; exit 1; }
mkdir -p "$DST_DIR"

# ソース側の正当なスキル (SKILL.md 持ち) を辿って symlink を貼り直す。
for skill in "$SRC_DIR"/*/; do
  name="$(basename "$skill")"
  [[ -f "$skill/SKILL.md" ]] || continue

  link="$DST_DIR/$name"
  target="../../agents/skills/$name"

  # 既に正しい相対 symlink なら何もしない。
  if [[ -L "$link" && "$(readlink "$link")" == "$target" ]]; then
    echo "ok      $name"
    continue
  fi

  # 別実体 (通常ファイル/ディレクトリ) や壊れた・別向き symlink は消してから貼り直す。
  [[ -e "$link" || -L "$link" ]] && rm -rf "$link"
  ln -s "$target" "$link"
  echo "linked  $name -> $target"
done

# ソースから消えたスキルの残骸 symlink を掃除する (symlink だけ。実ファイルは触らない)。
# ソース側に SKILL.md がもう無い項目だけを削除対象にする。
for link in "$DST_DIR"/*; do
  [[ -L "$link" ]] || continue
  name="$(basename "$link")"
  [[ -f "$SRC_DIR/$name/SKILL.md" ]] && continue
  rm -f "$link"
  echo "removed $name (no source)"
done
