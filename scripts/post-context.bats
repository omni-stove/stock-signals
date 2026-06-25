#!/usr/bin/env bats
# scripts/post-context.bats
# post-context.sh の後処理 2 つ (D1 upsert / Slack 投稿) の分岐と、組み立てる JSON
# ペイロードを検証する。signal-judge の発火は dispatch-judge.sh が担うので、
# ここでは「judge を撃たない」ことだけ確認する。
#
# 実行: pnpm run test:sh
#
# 設計:
#   - 外部呼び出し (curl) は POST_CONTEXT_DRYRUN=1 で叩かず、組み立てた payload を
#     stderr に "POST <url> <json>" 形式で出すだけにする (注入口)。
#   - run は stderr も $output に混ぜる (2>&1) ので、stdout の状態行と stderr の
#     payload を同じ $output から jq / grep で突き合わせる。
#   - WORKER_URL は必須チェックがあるのでダミー値を渡す (dryrun なので curl は走らない)。
#   - @test の説明は ASCII のみ (bats 1.13 は非ASCIIのテスト名を実行できない)。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  SCRIPT="$ROOT/scripts/post-context.sh"
  BODY="$BATS_TEST_TMPDIR/body.md"
  printf '# 285A context\nline2\n' >"$BODY"
}

# dryrun で post-context.sh を実行。stderr も取り込む。
# 引数: $1=ticker $2=body-file $3=ir-cursor $4=news-cursor。ir/news は cursor-file
# (1 行目 ir、2 行目 news) に書き、script には <ticker> <body-file> <cursor-file> を渡す。
run_pc() {
  local ticker="$1" body="$2" ir="$3" news="$4"
  local cf="$BATS_TEST_TMPDIR/cursors.txt"
  printf '%s\n%s\n' "$ir" "$news" >"$cf"
  run env \
    WORKER_URL="http://test.invalid" \
    SYNC_TOKEN="${SYNC_TOKEN:-}" \
    SLACK_CONTEXT_CHANNEL="${SLACK_CONTEXT_CHANNEL:-}" \
    GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-}" \
    POST_CONTEXT_DRYRUN=1 \
    bash "$SCRIPT" "$ticker" "$body" "$cf" 2>&1
}

# stderr に出た "POST <url> <json>" 行のうち、url 末尾が $1 のものの JSON を返す。
payload_for() {
  printf '%s\n' "$output" | awk -v ep="$1" '
    $1=="POST" && $2 ~ ep"$" { $1=""; $2=""; sub(/^  /,""); print }'
}

# === 引数 / 前提チェック ====================================================

@test "args: missing body-file fails" {
  WORKER_URL="http://test.invalid" run env WORKER_URL="http://test.invalid" \
    POST_CONTEXT_DRYRUN=1 bash "$SCRIPT" 285A "$BATS_TEST_TMPDIR/nope.md" "" ""
  [ "$status" -ne 0 ]
  printf '%s\n' "$output" | grep -q "body-file not found"
}

@test "args: missing ticker fails with usage" {
  run env WORKER_URL="http://test.invalid" POST_CONTEXT_DRYRUN=1 bash "$SCRIPT"
  [ "$status" -ne 0 ]
}

# === 1. D1 upsert payload ===================================================

# 本文が同梱され、カーソルがそのまま載る
@test "context: payload carries body and both cursors verbatim" {
  run_pc 285A "$BODY" "2026-06-09T00:00:00Z" "2026-06-07T00:00:00Z"
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/context")"
  [ "$(printf '%s' "$p" | jq -r '.code')" = "285A" ]
  [ "$(printf '%s' "$p" | jq -r '.ir_cursor')" = "2026-06-09T00:00:00Z" ]
  [ "$(printf '%s' "$p" | jq -r '.news_cursor')" = "2026-06-07T00:00:00Z" ]
  [ "$(printf '%s' "$p" | jq -r '.body | test("285A context")')" = "true" ]
  printf '%s\n' "$output" | grep -q "context posted (D1)"
}

# 空カーソルは null として送る (初回 backlog 後など)
@test "context: empty cursor becomes null" {
  run_pc 285A "$BODY" "" ""
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/context")"
  [ "$(printf '%s' "$p" | jq -r '.ir_cursor')" = "null" ]
  [ "$(printf '%s' "$p" | jq -r '.news_cursor')" = "null" ]
}

# 片方だけ空のときは片方 null・片方は値
@test "context: one empty one set yields null and value" {
  run_pc 285A "$BODY" "2026-06-09T00:00:00Z" ""
  local p; p="$(payload_for "/context")"
  [ "$(printf '%s' "$p" | jq -r '.ir_cursor')" = "2026-06-09T00:00:00Z" ]
  [ "$(printf '%s' "$p" | jq -r '.news_cursor')" = "null" ]
}

# === 2. Slack post ==========================================================

# SLACK_CONTEXT_CHANNEL があれば channel 明示で全文を投稿する (thread_ts/ticker なし)
@test "slack: posts full body with explicit channel when set" {
  SLACK_CONTEXT_CHANNEL="C123" run_pc 285A "$BODY" "" ""
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.channel')" = "C123" ]
  [ "$(printf '%s' "$p" | jq -r '.text | test("285A context")')" = "true" ]
  # thread_ts / ticker は付けない
  [ "$(printf '%s' "$p" | jq -r 'has("thread_ts")')" = "false" ]
  [ "$(printf '%s' "$p" | jq -r 'has("ticker")')" = "false" ]
  printf '%s\n' "$output" | grep -q "slack ok"
}

# SLACK_CONTEXT_CHANNEL が空ならスキップ (run は成功のまま)
@test "slack: skipped when channel unset" {
  SLACK_CONTEXT_CHANNEL="" run_pc 285A "$BODY" "" ""
  [ "$status" -eq 0 ]
  printf '%s\n' "$output" | grep -q "slack skipped (no channel)"
  # /slack/post は呼ばれない
  [ -z "$(payload_for "/slack/post")" ]
}

# === 3. signal-judge は撃たない (発火は dispatch-judge.sh に一本化した) ========

# GITHUB_REPOSITORY が設定されていても post-context.sh は judge を発火しない
@test "dispatch: post-context never fires signal-judge (moved to dispatch-judge.sh)" {
  GITHUB_REPOSITORY="foo/bar" run_pc 285A "$BODY" "" ""
  [ "$status" -eq 0 ]
  printf '%s\n' "$output" | grep -vq "signal-judge"
  printf '%s\n' "$output" | grep -vq "dispatches"
}
