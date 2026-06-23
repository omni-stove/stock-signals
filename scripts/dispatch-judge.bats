#!/usr/bin/env bats
# scripts/dispatch-judge.bats
# dispatch-judge.sh が signal-judge を repository_dispatch で発火する分岐を検証する。
#
# 実行: pnpm run test:sh
#
# 設計:
#   - gh は DISPATCH_JUDGE_DRYRUN=1 で叩かず、組み立てた引数を stderr に "GH <args>"
#     形式で出すだけにする (注入口)。run は 2>&1 で stderr も $output に混ぜる。
#   - @test の説明は ASCII のみ (bats 1.13 は非ASCIIのテスト名を実行できない)。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  SCRIPT="$ROOT/scripts/dispatch-judge.sh"
}

# dryrun で dispatch-judge.sh を実行。stderr も取り込む。
run_dj() {
  run env \
    GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-}" \
    DISPATCH_JUDGE_DRYRUN=1 \
    bash "$SCRIPT" "$@" 2>&1
}

@test "args: missing ticker fails with usage" {
  run env DISPATCH_JUDGE_DRYRUN=1 bash "$SCRIPT"
  [ "$status" -ne 0 ]
}

# GITHUB_REPOSITORY があれば repository_dispatch で signal-judge を起動する
@test "dispatch: fires signal-judge with ticker payload when repo set" {
  GITHUB_REPOSITORY="foo/bar" run_dj 285A
  [ "$status" -eq 0 ]
  printf '%s\n' "$output" | grep -q "GH api repos/foo/bar/dispatches"
  printf '%s\n' "$output" | grep -q "event_type=signal-judge"
  printf '%s\n' "$output" | grep -q "client_payload\[ticker\]=285A"
  printf '%s\n' "$output" | grep -q "signal-judge dispatched"
}

# GITHUB_REPOSITORY が無ければ dispatch しない (ローカル等)。run は成功のまま。
@test "dispatch: skipped when GITHUB_REPOSITORY unset" {
  GITHUB_REPOSITORY="" run_dj 285A
  [ "$status" -eq 0 ]
  printf '%s\n' "$output" | grep -q "signal-judge skipped (no GITHUB_REPOSITORY)"
  printf '%s\n' "$output" | grep -vq "^GH "
}
