#!/usr/bin/env bash
# 全チェックを並列実行し、成功時は "all green" の 1 行だけ、
# 失敗時は落ちたステップの ✗ ラベル + 全出力だけを表示する。
# 実行中は「running...」のドットアニメーションを表示する。
set -uo pipefail

# 各 verify:* は quiet.sh 経由で「成功時無音 / 失敗時のみ詳細」。
# run-p -c で全ステップを完走させてから成否を集約する。
# -s で npm-run-all2 / pnpm のコマンドエコー ($ ...) を抑制。
# 出力はファイルに退避し、完了後にまとめて表示する (スピナーと混ざらないように)。
out="$(mktemp)"
trap 'rm -f "$out"' EXIT

pnpm exec run-p -c -s \
  verify:lint \
  verify:typecheck \
  verify:worker:typecheck \
  verify:check:watchlist \
  verify:test \
  verify:worker:test \
  verify:test:sh \
  verify:knip >"$out" 2>&1 &
pid=$!

# TTY のときだけスピナーを出す (CI 等のパイプ出力では無効)。
if [ -t 1 ]; then
  dots=""
  while kill -0 "$pid" 2>/dev/null; do
    dots="${dots}."
    [ "${#dots}" -gt 3 ] && dots="."
    printf '\r\033[Krunning%s' "$dots"
    sleep 0.3
  done
  printf '\r\033[K'
fi

wait "$pid"
status=$?

cat "$out"

if [ "$status" -eq 0 ]; then
  echo "all green"
else
  exit 1
fi
