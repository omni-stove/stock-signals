#!/usr/bin/env bats
# scripts/post-market.bats
# post-market.sh が組み立てる Slack ペイロード (headline + 本文の section blocks) を検証する。
#
# 実行: pnpm run test:sh
#
# 設計 (post-signal.bats と同じ思想):
#   - 外部呼び出し (curl) は POST_MARKET_DRYRUN=1 で叩かず、組み立てた payload を
#     stderr に "POST <url> <json>" 形式で出すだけにする (注入口)。
#   - run は stderr も $output に混ぜる (2>&1) ので stdout の状態行と stderr の payload を
#     同じ $output から jq / grep で突き合わせる。
#   - WORKER_URL は必須チェックがあるのでダミー値を渡す (dryrun なので curl は走らない)。
#   - @test の説明は ASCII のみ (bats 1.13 は非ASCIIのテスト名を実行できない)。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  SCRIPT="$ROOT/scripts/post-market.sh"
}

# dryrun で post-market.sh を実行。stderr も取り込む。引数: $1=headline $2=body。
# headline+body を 1 ファイル (1 行目 headline、2 行目以降 body) に書き、script には
# <body-file> を渡す。リテラル "\n" は実改行へ展開して複数行ファイルにする。
run_pm() {
  local headline="$1" body="$2"
  local f="$BATS_TEST_TMPDIR/market.out"
  { printf '%s\n' "$headline"; printf '%b' "${body//\\n/$'\n'}"; printf '\n'; } > "$f"
  run env \
    WORKER_URL="http://test.invalid" \
    SYNC_TOKEN="${SYNC_TOKEN:-}" \
    POST_MARKET_DRYRUN=1 \
    bash "$SCRIPT" "$f" 2>&1
}

# stderr に出た "POST <url> <json>" 行の JSON を返す。
payload() {
  printf '%s\n' "$output" | awk '$1=="POST" { $1=""; $2=""; sub(/^  /,""); print }'
}

# === 引数 / 前提チェック ====================================================

@test "args: missing body-file fails with usage" {
  run env WORKER_URL="http://test.invalid" POST_MARKET_DRYRUN=1 bash "$SCRIPT"
  [ "$status" -ne 0 ]
}

@test "args: nonexistent body-file fails" {
  run env WORKER_URL="http://test.invalid" POST_MARKET_DRYRUN=1 bash "$SCRIPT" "$BATS_TEST_TMPDIR/nope.out"
  [ "$status" -ne 0 ]
}

@test "args: missing WORKER_URL fails" {
  printf 'HEAD\nbody\n' > "$BATS_TEST_TMPDIR/m.out"
  run env POST_MARKET_DRYRUN=1 bash "$SCRIPT" "$BATS_TEST_TMPDIR/m.out"
  [ "$status" -ne 0 ]
}

# === payload 構造 ===========================================================

# kind / text / ticker(=market) が載り、先頭 section は headline
@test "payload: carries market-check kind, market ticker, and headline as first block" {
  run_pm "HEAD line" "one line body"
  [ "$status" -eq 0 ]
  local p; p="$(payload)"
  [ "$(printf '%s' "$p" | jq -r '.kind')" = "market-check" ]
  [ "$(printf '%s' "$p" | jq -r '.ticker')" = "market" ]
  [ "$(printf '%s' "$p" | jq -r '.text')" = "HEAD line" ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[0].text.text')" = "HEAD line" ]
  printf '%s\n' "$output" | grep -q "slack skipped"
}

# === 改行分割 ===============================================================

@test "newline: literal backslash-n splits body into separate blocks" {
  run_pm "HEAD" 'first.\nsecond.\nthird.'
  [ "$status" -eq 0 ]
  local p; p="$(payload)"
  [ "$(printf '%s' "$p" | jq -r '.blocks | length')" -eq 4 ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[1].text.text')" = "first." ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[3].text.text')" = "third." ]
}

@test "newline: blank lines are dropped" {
  run_pm "HEAD" 'a\n\n\nb'
  [ "$status" -eq 0 ]
  local p; p="$(payload)"
  [ "$(printf '%s' "$p" | jq -r '.blocks | length')" -eq 3 ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[1].text.text')" = "a" ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[2].text.text')" = "b" ]
}
