#!/usr/bin/env bats
# scripts/post-reply.bats
# post-reply.sh の 2 mode (crash / reply) が組み立てる /slack/post payload を検証する。
#
# 実行: pnpm run test:sh
#
# 設計:
#   - curl は POST_REPLY_DRYRUN=1 で叩かず、組み立てた payload を stderr に
#     "POST <url> <json>" 形式で出すだけにする (注入口)。
#   - run は stderr も $output に混ぜる (2>&1)。stdout の状態行と stderr の payload を
#     同じ $output から jq / grep で突き合わせる。
#   - WORKER_URL は必須チェックがあるのでダミー値を渡す (dryrun なので curl は走らない)。
#   - @test の説明は ASCII のみ (bats 1.13 は非ASCIIのテスト名を実行できない)。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  SCRIPT="$ROOT/scripts/post-reply.sh"
}

# dryrun で post-reply.sh を実行。stderr も取り込む。env は呼び出し側で上書き可。
run_pr() {
  run env \
    WORKER_URL="http://test.invalid" \
    SYNC_TOKEN="${SYNC_TOKEN:-}" \
    POST_REPLY_DRYRUN=1 \
    bash "$SCRIPT" "$@" 2>&1
}

# stderr に出た "POST <url> <json>" 行の JSON を返す。
payload() {
  printf '%s\n' "$output" | awk '$1=="POST" { $1=""; $2=""; sub(/^  /,""); print }'
}

# === args ===================================================================

@test "args: unknown mode fails" {
  run env WORKER_URL="http://test.invalid" POST_REPLY_DRYRUN=1 bash "$SCRIPT" bogus
  [ "$status" -ne 0 ]
  printf '%s\n' "$output" | grep -q "unknown mode"
}

@test "args: crash missing signal-file fails" {
  run env WORKER_URL="http://test.invalid" POST_REPLY_DRYRUN=1 bash "$SCRIPT" crash 285A "キオクシア"
  [ "$status" -ne 0 ]
}

@test "args: crash nonexistent signal-file fails" {
  run env WORKER_URL="http://test.invalid" POST_REPLY_DRYRUN=1 bash "$SCRIPT" crash 285A "キオクシア" "$BATS_TEST_TMPDIR/nope.json"
  [ "$status" -ne 0 ]
  printf '%s\n' "$output" | grep -q "signal-file not found"
}

@test "args: crash signal-file without blocks array fails" {
  printf '{"foo":1}' >"$BATS_TEST_TMPDIR/bad.json"
  run env WORKER_URL="http://test.invalid" POST_REPLY_DRYRUN=1 bash "$SCRIPT" crash 285A "キオクシア" "$BATS_TEST_TMPDIR/bad.json"
  [ "$status" -ne 0 ]
  printf '%s\n' "$output" | grep -q "lacks blocks array"
}

@test "args: reply missing signal-file fails" {
  printf '{"channel":"C1","thread_ts":"12.34"}' >"$BATS_TEST_TMPDIR/t.json"
  run env WORKER_URL="http://test.invalid" POST_REPLY_DRYRUN=1 bash "$SCRIPT" reply "$BATS_TEST_TMPDIR/t.json"
  [ "$status" -ne 0 ]
}

@test "args: reply nonexistent signal-file fails" {
  printf '{"channel":"C1","thread_ts":"12.34"}' >"$BATS_TEST_TMPDIR/t.json"
  run env WORKER_URL="http://test.invalid" POST_REPLY_DRYRUN=1 bash "$SCRIPT" reply "$BATS_TEST_TMPDIR/t.json" "$BATS_TEST_TMPDIR/nope.json"
  [ "$status" -ne 0 ]
  printf '%s\n' "$output" | grep -q "signal-file not found"
}

@test "args: reply empty reply fails" {
  printf '{"channel":"C1","thread_ts":"12.34"}' >"$BATS_TEST_TMPDIR/t.json"
  printf '{"reply":""}' >"$BATS_TEST_TMPDIR/r.json"
  run env WORKER_URL="http://test.invalid" POST_REPLY_DRYRUN=1 bash "$SCRIPT" reply "$BATS_TEST_TMPDIR/t.json" "$BATS_TEST_TMPDIR/r.json"
  [ "$status" -ne 0 ]
  printf '%s\n' "$output" | grep -q "empty reply"
}

@test "args: reply missing thread-json file fails" {
  run env WORKER_URL="http://test.invalid" POST_REPLY_DRYRUN=1 bash "$SCRIPT" reply "$BATS_TEST_TMPDIR/nope.json" "hi"
  [ "$status" -ne 0 ]
  printf '%s\n' "$output" | grep -q "thread-json not found"
}

# === crash mode =============================================================

# ticker/kind が載り、ヘッダ (text + 先頭ブロック) を script が組み、N は配列長-1
@test "crash: script builds header and prepends header block" {
  # scenario 2 ブロック + 総括 1 = 3 要素 → N=2。structured_output {blocks:[...]} で渡す。
  printf '%s' \
    '{"blocks":[{"type":"section","text":{"type":"mrkdwn","text":"s1"}},{"type":"section","text":{"type":"mrkdwn","text":"s2"}},{"type":"section","text":{"type":"mrkdwn","text":"総括"}}]}' \
    >"$BATS_TEST_TMPDIR/blocks.json"
  run_pr crash 285A "キオクシア" "$BATS_TEST_TMPDIR/blocks.json"
  [ "$status" -eq 0 ]
  local p; p="$(payload)"
  [ "$(printf '%s' "$p" | jq -r '.ticker')" = "285A" ]
  [ "$(printf '%s' "$p" | jq -r '.kind')" = "crash-scenario" ]
  [ "$(printf '%s' "$p" | jq -r '.text')" = "⚠️ 285A キオクシア 暴落プリモーテム (2 scenarios)" ]
  # 先頭にヘッダブロックが差し込まれ、渡した s1 は 2 番目になる
  [ "$(printf '%s' "$p" | jq -r '.blocks[0].text.text')" = "⚠️ 285A キオクシア 暴落プリモーテム (2 scenarios)" ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[1].text.text')" = "s1" ]
  # channel は付けない (Worker が SLACK_REPLY_CHANNEL から埋める)
  [ "$(printf '%s' "$p" | jq -r 'has("channel")')" = "false" ]
}

# === reply mode =============================================================

# channel / thread_ts は thread-json から抜く。text のみ引数。kind は付けない
@test "reply: pulls channel/thread_ts from thread-json, text from signal-file" {
  printf '{"channel":"C123","thread_ts":"1718000000.0001","kind":"ticker-brief","replies":[]}' \
    >"$BATS_TEST_TMPDIR/t.json"
  printf '{"reply":"押し目で見てます"}' >"$BATS_TEST_TMPDIR/reply.json"
  run_pr reply "$BATS_TEST_TMPDIR/t.json" "$BATS_TEST_TMPDIR/reply.json"
  [ "$status" -eq 0 ]
  local p; p="$(payload)"
  [ "$(printf '%s' "$p" | jq -r '.channel')" = "C123" ]
  [ "$(printf '%s' "$p" | jq -r '.thread_ts')" = "1718000000.0001" ]
  [ "$(printf '%s' "$p" | jq -r '.text')" = "押し目で見てます" ]
  [ "$(printf '%s' "$p" | jq -r 'has("kind")')" = "false" ]
}

# === url ====================================================================

# 両 mode とも /slack/post に投げる
@test "url: posts to /slack/post" {
  printf '{"channel":"C1","thread_ts":"1.0"}' >"$BATS_TEST_TMPDIR/t.json"
  printf '{"reply":"x"}' >"$BATS_TEST_TMPDIR/reply.json"
  run_pr reply "$BATS_TEST_TMPDIR/t.json" "$BATS_TEST_TMPDIR/reply.json"
  printf '%s\n' "$output" | grep -q "POST http://test.invalid/slack/post"
}
