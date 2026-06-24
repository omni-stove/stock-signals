#!/usr/bin/env bash
# scripts/cap.sh
# 全変更を commit して current branch に push する。skill (cap) はこれを 1 行で呼ぶだけ。
#
# 設計: commit message だけが LLM の判断要素なので $1 で受け取る。残り (ステージ・push) は
#   決定論的なのでここが持つ。
#   - 常に current branch にそのまま commit/push する (ブランチは切らない。main 直 push も許可)。
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

git add -A
git commit -m "$MSG"
git push -u origin "$BRANCH"

echo "cap: committed + pushed to $BRANCH"
