#!/usr/bin/env bash
# bats を「成功時は無音、失敗時のみ詳細表示」で実行するラッパー。
# tap 出力を解析し、失敗テスト (not ok) とその診断行、最終サマリのみ出す。
set -uo pipefail

# テスト対象はこのリポの scripts ディレクトリに固定。
# tap で実行。失敗行とその後続の診断 (# で始まる行) を保持する。
# --print-output-on-failure で失敗テストの実出力も診断 (# Last output:) に含める。
output="$(bats --tap --print-output-on-failure scripts 2>&1)"
status=$?

total="$(printf '%s\n' "$output" | grep -cE '^(ok|not ok) ')"
failed="$(printf '%s\n' "$output" | grep -cE '^not ok ')"

if [ "$status" -eq 0 ]; then
  echo "bats: ${total} tests passed"
  exit 0
fi

# 失敗時: 失敗テストの行と、それに続く診断 (#) 行を抽出して表示。
printf '%s\n' "$output" | awk '
  /^not ok / { show=1; print; next }
  /^# /      { if (show) print; next }
  /^ok /     { show=0; next }
  { show=0 }
'
echo "bats: ${failed}/${total} tests FAILED"
exit "$status"
