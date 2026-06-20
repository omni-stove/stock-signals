#!/usr/bin/env bats
# scripts/post-signal.bats
# post-signal.sh が組み立てる Slack ペイロード (headline + 本文の section blocks) を検証する。
#
# 実行: pnpm run test:sh
#
# 設計 (post-context.bats と同じ思想):
#   - 外部呼び出し (curl) は POST_SIGNAL_DRYRUN=1 で叩かず、組み立てた payload を
#     stderr に "POST <url> <json>" 形式で出すだけにする (注入口)。
#   - run は stderr も $output に混ぜる (2>&1) ので、stdout の状態行と stderr の
#     payload を同じ $output から jq / grep で突き合わせる。
#   - WORKER_URL は必須チェックがあるのでダミー値を渡す (dryrun なので curl は走らない)。
#   - @test の説明は ASCII のみ (bats 1.13 は非ASCIIのテスト名を実行できない)。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  SCRIPT="$ROOT/scripts/post-signal.sh"
}

# dryrun で post-signal.sh を実行。stderr も取り込む。
# 引数: $1=ticker $2=headline $3=body。env は呼び出し側で上書き可。
run_ps() {
  run env \
    WORKER_URL="http://test.invalid" \
    SYNC_TOKEN="${SYNC_TOKEN:-}" \
    POST_SIGNAL_DRYRUN=1 \
    bash "$SCRIPT" "$@" 2>&1
}

# stderr に出た "POST <url> <json>" 行のうち、url 末尾が $1 のものの JSON を返す。
payload_for() {
  printf '%s\n' "$output" | awk -v ep="$1" '
    $1=="POST" && $2 ~ ep"$" { $1=""; $2=""; sub(/^  /,""); print }'
}

# === 引数 / 前提チェック ====================================================

@test "args: missing ticker fails with usage" {
  run env WORKER_URL="http://test.invalid" POST_SIGNAL_DRYRUN=1 bash "$SCRIPT"
  [ "$status" -ne 0 ]
}

@test "args: missing body fails" {
  run env WORKER_URL="http://test.invalid" POST_SIGNAL_DRYRUN=1 bash "$SCRIPT" 285A "HEAD"
  [ "$status" -ne 0 ]
}

@test "args: missing WORKER_URL fails" {
  run env POST_SIGNAL_DRYRUN=1 bash "$SCRIPT" 285A "HEAD" "body"
  [ "$status" -ne 0 ]
}

# === payload 構造 ===========================================================

# kind / text / ticker が載り、先頭 section は headline
@test "payload: carries kind, text and headline as first block" {
  run_ps 285A "HEAD line" "one line body"
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.kind')" = "signal-judge" ]
  [ "$(printf '%s' "$p" | jq -r '.ticker')" = "285A" ]
  [ "$(printf '%s' "$p" | jq -r '.text')" = "HEAD line" ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[0].text.text')" = "HEAD line" ]
  printf '%s\n' "$output" | grep -q "slack skipped"
}

# === 改行分割 (本来のバグ) ==================================================

# リテラル "\n" (バックスラッシュ+n) を渡しても本文が複数 section に分割される
@test "newline: literal backslash-n splits body into separate blocks" {
  run_ps 285A "HEAD" 'first line.\nsecond line.\nthird line.'
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  # headline(1) + 本文 3 行 = 4 blocks
  [ "$(printf '%s' "$p" | jq -r '.blocks | length')" -eq 4 ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[1].text.text')" = "first line." ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[2].text.text')" = "second line." ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[3].text.text')" = "third line." ]
  # リテラル \n が本文中に残っていないこと
  [ "$(printf '%s' "$p" | jq -r '.blocks[] | select(.text.text | test("\\\\n"))' | wc -l)" -eq 0 ]
}

# 本物の改行で渡しても同じく複数 section に分割される
@test "newline: real newlines split body into separate blocks" {
  run_ps 285A "HEAD" "$(printf 'alpha\nbeta\ngamma')"
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.blocks | length')" -eq 4 ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[1].text.text')" = "alpha" ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[2].text.text')" = "beta" ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[3].text.text')" = "gamma" ]
}

# 空行 (連続改行) は section を作らない
@test "newline: blank lines are dropped" {
  run_ps 285A "HEAD" 'a\n\n\nb'
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  # headline + a + b = 3 blocks (空行ぶんは select(length>0) で落ちる)
  [ "$(printf '%s' "$p" | jq -r '.blocks | length')" -eq 3 ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[1].text.text')" = "a" ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[2].text.text')" = "b" ]
}
