#!/usr/bin/env bash
# scripts/cap.sh
# 全変更を commit して current branch に push する。skill (cap) はこれを 1 行で呼ぶだけ。
#
# 設計: commit message だけが LLM の判断要素なので $1 で受け取る。残り (ステージ・ブランチ保護・
#   push) は決定論的なのでここが持つ。
#   - default branch (main/master) に直接 push しない。default 上にいたら cap/<timestamp> を切る。
#   - force-push しない (素の git push のみ)。
#   - 変更が無ければ何もせず抜ける。
#
# 入力: $1 = commit message (必須)
# 出力 (stdout): 実行結果の 1 行。

set -euo pipefail

MSG="${1:?usage: cap.sh <commit-message>}"

# 変更が無ければ何もしない。
if git diff --quiet && git diff --cached --quiet && [[ -z "$(git status --porcelain)" ]]; then
  echo "cap: no changes to commit"
  exit 0
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
DEFAULT="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"
[[ -z "$DEFAULT" ]] && DEFAULT="main"

# default branch 上なら作業ブランチを切ってから commit する。
if [[ "$BRANCH" == "$DEFAULT" || "$BRANCH" == "master" ]]; then
  NEW="cap/$(git log -1 --format=%h 2>/dev/null || echo work)-$$"
  git switch -c "$NEW"
  BRANCH="$NEW"
  echo "cap: was on default branch, switched to $BRANCH"
fi

git add -A
git commit -m "$MSG"
git push -u origin "$BRANCH"

echo "cap: committed + pushed to $BRANCH"
