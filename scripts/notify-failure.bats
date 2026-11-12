#!/usr/bin/env bats
# scripts/notify-failure.bats
# notify-failure.sh が組み立てる Slack webhook payload を検証する。
#
# 実行: pnpm run test:sh
#
# 設計:
#   - curl は NOTIFY_FAILURE_DRYRUN=1 で叩かず、payload を stderr に "POST <json>" で出すだけにする。
#   - run は stderr も $output に混ぜる (2>&1)。
#   - @test の説明は ASCII のみ (bats 1.13 は非ASCIIのテスト名を実行できない)。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  SCRIPT="$ROOT/scripts/notify-failure.sh"
  URL="https://github.com/o/r/actions/runs/1"
}

run_nf() {
  run env NOTIFY_FAILURE_DRYRUN=1 bash "$SCRIPT" "$@" 2>&1
}

# payload の text を返す。
text() {
  printf '%s\n' "$output" | awk '$1=="POST" { $1=""; sub(/^ /,""); print }' | jq -r '.text'
}

@test "args: missing url fails" {
  run bash "$SCRIPT" ticker-brief "ticker-brief 6857"
  [ "$status" -ne 0 ]
}

@test "target: run-name starting with workflow name is used as is" {
  run_nf ticker-brief "ticker-brief 6857" "$URL"
  [ "$status" -eq 0 ]
  text | head -n 1 | grep -qF "*ticker-brief 6857*"
  text | grep -qF "<$URL|"
}

@test "target: run-name equal to workflow name shows name once" {
  run_nf market-brief "market-brief" "$URL"
  [ "$status" -eq 0 ]
  text | head -n 1 | grep -qF "*market-brief*"
}

@test "target: unrelated title (commit message) is appended in parens, first line only" {
  run_nf deploy-worker $'feat: something\n\nbody' "$URL"
  [ "$status" -eq 0 ]
  text | head -n 1 | grep -qF "*deploy-worker (feat: something)*"
  ! text | grep -qF "body"
}

@test "steps: each failed step becomes a bullet line" {
  run_nf ticker-brief "ticker-brief 6857" "$URL" $'ticker-brief / Run ticker-brief\nticker-brief / Post brief to Slack\n'
  [ "$status" -eq 0 ]
  [ "$(text | wc -l | tr -d ' ')" -eq 3 ]
  text | sed -n 2p | grep -qF "・ticker-brief / Run ticker-brief"
}

@test "steps: none means single line" {
  run_nf ticker-brief "ticker-brief 6857" "$URL" ""
  [ "$(text | wc -l | tr -d ' ')" -eq 1 ]
}

@test "webhook unset: skipped without posting" {
  run env -u SLACK_WEBHOOK_URL bash "$SCRIPT" ticker-brief "ticker-brief 6857" "$URL"
  [ "$status" -eq 0 ]
  [ "$output" = "slack skipped" ]
}
