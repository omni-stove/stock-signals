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
}

# dryrun で post-context.sh を実行。stderr も取り込む。
# 引数: $1=ticker $2=見出し本文の目印 $3=ir-cursor $4=news-cursor。structured_output JSON
# ({status:"ok", title, sections, ir_cursor, news_cursor}) を signal-file に書いて <ticker> <signal-file> を渡す。
# title に $2 を入れ、sections は 1 セクション 1 行の最小形で $2 を本文に持たせる
# (payload の title / sections に $2 が載ることを後段で検証する)。
# 空カーソルは JSON で null として書く (script 側で null→null のまま送られる)。
run_pc() {
  local ticker="$1" mark="$2" ir="$3" news="$4"
  local sf="$BATS_TEST_TMPDIR/context.json"
  jq -n --arg m "$mark" --arg ir "$ir" --arg news "$news" \
    '{status:"ok", title:$m,
      sections:[{heading:"事業の骨格", lines:[$m]}],
      ir_cursor:(if $ir=="" then null else $ir end),
      news_cursor:(if $news=="" then null else $news end)}' >"$sf"
  run env \
    WORKER_URL="http://test.invalid" \
    SYNC_TOKEN="${SYNC_TOKEN:-}" \
    SLACK_CONTEXT_CHANNEL="${SLACK_CONTEXT_CHANNEL:-}" \
    GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-}" \
    POST_CONTEXT_DRYRUN=1 \
    bash "$SCRIPT" "$ticker" "$sf" 2>&1
}

# stderr に出た "POST <url> <json>" 行のうち、url 末尾が $1 のものの JSON を返す。
payload_for() {
  printf '%s\n' "$output" | awk -v ep="$1" '
    $1=="POST" && $2 ~ ep"$" { $1=""; $2=""; sub(/^  /,""); print }'
}

# === 引数 / 前提チェック ====================================================

@test "args: missing signal-file fails" {
  run env WORKER_URL="http://test.invalid" \
    POST_CONTEXT_DRYRUN=1 bash "$SCRIPT" 285A "$BATS_TEST_TMPDIR/nope.json"
  [ "$status" -ne 0 ]
  printf '%s\n' "$output" | grep -q "signal-file not found"
}

@test "args: invalid JSON signal-file fails" {
  printf 'not json' >"$BATS_TEST_TMPDIR/bad.json"
  run env WORKER_URL="http://test.invalid" \
    POST_CONTEXT_DRYRUN=1 bash "$SCRIPT" 285A "$BATS_TEST_TMPDIR/bad.json"
  [ "$status" -ne 0 ]
  printf '%s\n' "$output" | grep -q "not valid JSON"
}

@test "args: missing ticker fails with usage" {
  run env WORKER_URL="http://test.invalid" POST_CONTEXT_DRYRUN=1 bash "$SCRIPT"
  [ "$status" -ne 0 ]
}

# === no-update 分岐 =========================================================

# status=no-update なら upsert も投稿もせず即終了する
@test "no-update: skips upsert and post" {
  printf '{"status":"no-update"}' >"$BATS_TEST_TMPDIR/context.json"
  run env WORKER_URL="http://test.invalid" SLACK_CONTEXT_CHANNEL="C123" \
    POST_CONTEXT_DRYRUN=1 bash "$SCRIPT" 285A "$BATS_TEST_TMPDIR/context.json" 2>&1
  [ "$status" -eq 0 ]
  printf '%s\n' "$output" | grep -q "no update"
  [ -z "$(printf '%s\n' "$output" | awk '$1=="POST"')" ]
}

# === 1. D1 upsert payload ===================================================

# title + sections が同梱され、カーソルがそのまま載る (body 文字列は送らない)
@test "context: payload carries title, sections and both cursors verbatim" {
  run_pc 285A "285A context" "2026-06-09T00:00:00Z" "2026-06-07T00:00:00Z"
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/context")"
  [ "$(printf '%s' "$p" | jq -r '.code')" = "285A" ]
  [ "$(printf '%s' "$p" | jq -r '.ir_cursor')" = "2026-06-09T00:00:00Z" ]
  [ "$(printf '%s' "$p" | jq -r '.news_cursor')" = "2026-06-07T00:00:00Z" ]
  [ "$(printf '%s' "$p" | jq -r '.title')" = "285A context" ]
  [ "$(printf '%s' "$p" | jq -r '.sections | length')" = "1" ]
  [ "$(printf '%s' "$p" | jq -r '.sections[0].lines[0]')" = "285A context" ]
  # body 文字列は送らない (Worker が sections から組む)
  [ "$(printf '%s' "$p" | jq -r 'has("body")')" = "false" ]
  printf '%s\n' "$output" | grep -q "context posted (D1)"
}

# 空カーソルは null として送る (初回 backlog 後など)
@test "context: empty cursor becomes null" {
  run_pc 285A "285A context" "" ""
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/context")"
  [ "$(printf '%s' "$p" | jq -r '.ir_cursor')" = "null" ]
  [ "$(printf '%s' "$p" | jq -r '.news_cursor')" = "null" ]
}

# 片方だけ空のときは片方 null・片方は値
@test "context: one empty one set yields null and value" {
  run_pc 285A "285A context" "2026-06-09T00:00:00Z" ""
  local p; p="$(payload_for "/context")"
  [ "$(printf '%s' "$p" | jq -r '.ir_cursor')" = "2026-06-09T00:00:00Z" ]
  [ "$(printf '%s' "$p" | jq -r '.news_cursor')" = "null" ]
}

# === 総量バックストップ (行数/文字数の上限) ==================================

# 上限内なら通る (境界値: ちょうど上限)
@test "size: passes at exactly the caps" {
  local sf="$BATS_TEST_TMPDIR/context.json"
  jq -n '{status:"ok", title:"t",
    sections:[{heading:"h", lines:["1234567890","1234567890"]}],
    ir_cursor:null, news_cursor:null}' >"$sf"
  run env WORKER_URL="http://test.invalid" POST_CONTEXT_DRYRUN=1 \
    POST_CONTEXT_MAX_LINES=2 POST_CONTEXT_MAX_CHARS=20 \
    bash "$SCRIPT" 285A "$sf" 2>&1
  [ "$status" -eq 0 ]
  printf '%s\n' "$output" | grep -q "context posted (D1)"
}

# 総行数が上限を超えると fail し、upsert/投稿は走らない
@test "size: fails when total lines exceed cap" {
  local sf="$BATS_TEST_TMPDIR/context.json"
  jq -n '{status:"ok", title:"t",
    sections:[{heading:"h1", lines:["a","b"]},{heading:"h2", lines:["c"]}],
    ir_cursor:null, news_cursor:null}' >"$sf"
  run env WORKER_URL="http://test.invalid" POST_CONTEXT_DRYRUN=1 \
    POST_CONTEXT_MAX_LINES=2 \
    bash "$SCRIPT" 285A "$sf" 2>&1
  [ "$status" -ne 0 ]
  printf '%s\n' "$output" | grep -q "context too large"
  [ -z "$(printf '%s\n' "$output" | awk '$1=="POST"')" ]
}

# 総文字数が上限を超えると fail する (文字数 = 全行の連結長)
@test "size: fails when total chars exceed cap" {
  local sf="$BATS_TEST_TMPDIR/context.json"
  jq -n '{status:"ok", title:"t",
    sections:[{heading:"h", lines:["12345678901"]}],
    ir_cursor:null, news_cursor:null}' >"$sf"
  run env WORKER_URL="http://test.invalid" POST_CONTEXT_DRYRUN=1 \
    POST_CONTEXT_MAX_CHARS=10 \
    bash "$SCRIPT" 285A "$sf" 2>&1
  [ "$status" -ne 0 ]
  printf '%s\n' "$output" | grep -q "context too large"
  [ -z "$(printf '%s\n' "$output" | awk '$1=="POST"')" ]
}

# === 2. Slack post ==========================================================

# SLACK_CONTEXT_CHANNEL があれば channel 明示で context_sections を投稿する (blocks 整形は Worker)
@test "slack: posts context_sections with explicit channel when set" {
  SLACK_CONTEXT_CHANNEL="C123" run_pc 285A "285A context" "" ""
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.channel')" = "C123" ]
  [ "$(printf '%s' "$p" | jq -r '.context_sections.title')" = "285A context" ]
  [ "$(printf '%s' "$p" | jq -r '.context_sections.sections[0].lines[0]')" = "285A context" ]
  # text/blocks は載せない (Worker が context_sections から組む)。thread_ts/ticker も付けない
  [ "$(printf '%s' "$p" | jq -r 'has("text")')" = "false" ]
  [ "$(printf '%s' "$p" | jq -r 'has("thread_ts")')" = "false" ]
  [ "$(printf '%s' "$p" | jq -r 'has("ticker")')" = "false" ]
  printf '%s\n' "$output" | grep -q "slack ok"
}

# SLACK_CONTEXT_CHANNEL が空ならスキップ (run は成功のまま)
@test "slack: skipped when channel unset" {
  SLACK_CONTEXT_CHANNEL="" run_pc 285A "285A context" "" ""
  [ "$status" -eq 0 ]
  printf '%s\n' "$output" | grep -q "slack skipped (no channel)"
  # /slack/post は呼ばれない
  [ -z "$(payload_for "/slack/post")" ]
}

# === 3. signal-judge は撃たない (発火は dispatch-judge.sh に一本化した) ========

# GITHUB_REPOSITORY が設定されていても post-context.sh は judge を発火しない
@test "dispatch: post-context never fires signal-judge (moved to dispatch-judge.sh)" {
  GITHUB_REPOSITORY="foo/bar" run_pc 285A "285A context" "" ""
  [ "$status" -eq 0 ]
  printf '%s\n' "$output" | grep -vq "signal-judge"
  printf '%s\n' "$output" | grep -vq "dispatches"
}
