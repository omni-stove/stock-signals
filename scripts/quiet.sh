#!/usr/bin/env bash
# 任意のコマンドを「成功時は完全無音、失敗時のみ ✗ ラベル + 全出力」で実行するラッパー。
# 使い方: scripts/quiet.sh <ラベル> <コマンド...>
set -uo pipefail

label="$1"
shift

output="$("$@" 2>&1)"
status=$?

if [ "$status" -eq 0 ]; then
  exit 0
fi

# 失敗時のみ: ラベルと共にコマンドの全出力を表示。
echo "✗ ${label}"
printf '%s\n' "$output"
exit "$status"
