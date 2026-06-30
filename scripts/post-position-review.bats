#!/usr/bin/env bats
# scripts/post-position-review.bats
# post-position-review.sh が組み立てる Slack DM ペイロード (所見 + 建玉ごとの section blocks) を検証する。
#
# 実行: pnpm run test:sh
#
# 設計:
#   - 外部呼び出し (curl) は POST_REVIEW_DRYRUN=1 で叩かず、組み立てた payload を
#     stderr に "POST <url> <json>" 形式で出すだけにする (注入口)。
#   - run は stderr も $output に混ぜる (2>&1) ので、stdout の状態行と stderr の
#     payload を同じ $output から jq / grep で突き合わせる。
#   - WORKER_URL は必須チェックがあるのでダミー値を渡す (dryrun なので curl は走らない)。
#   - @test の説明は ASCII のみ (bats 1.13 は非ASCIIのテスト名を実行できない)。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  SCRIPT="$ROOT/scripts/post-position-review.sh"
}

# dryrun で post-position-review.sh を実行。stderr も取り込む。
# 引数: $1=userId $2=review-json (structured_output 相当の JSON 文字列)。
run_pr() {
  local user="$1" review="$2"
  local f="$BATS_TEST_TMPDIR/review.json"
  printf '%s' "$review" > "$f"
  run env \
    WORKER_URL="http://test.invalid" \
    SYNC_TOKEN="${SYNC_TOKEN:-}" \
    POST_REVIEW_DRYRUN=1 \
    bash "$SCRIPT" "$user" "$f" 2>&1
}

# payload JSON を $output の "POST <url> <json>" 行から取り出す。
payload() {
  printf '%s\n' "$output" | sed -n 's/^POST [^ ]* //p'
}

@test "channel is the userId so chat.postMessage opens a DM" {
  run_pr "U0123ABCD" '{"portfolio":"半導体ロング集中","positions":[{"ticker":"285A","name":"キオクシア","action":"継続","urgency":"低","reason":"順行 含み益+10%"}]}'
  [ "$status" -eq 0 ]
  [ "$(payload | jq -r '.channel')" = "U0123ABCD" ]
  [ "$(payload | jq -r '.kind')" = "position-review" ]
}

@test "blocks lead with header then portfolio line" {
  run_pr "U1" '{"portfolio":"逆行が2件","positions":[{"ticker":"6857","name":"アドバンテスト","action":"損切り検討","urgency":"高","reason":"信用売建 逆行で含み損"}]}'
  [ "$status" -eq 0 ]
  [ "$(payload | jq -r '.blocks[0].text.text')" = "*📋 保有ポジション評価 (引け後)*" ]
  [ "$(payload | jq -r '.blocks[1].text.text')" = "逆行が2件" ]
}

@test "each position becomes one section with ticker, urgency, action and reason" {
  run_pr "U1" '{"portfolio":"x","positions":[{"ticker":"6857","name":"アドバンテスト","action":"損切り検討","urgency":"高","reason":"信用売建 逆行で含み損"}]}'
  [ "$status" -eq 0 ]
  local line
  line="$(payload | jq -r '.blocks[2].text.text')"
  printf '%s' "$line" | grep -q "\*6857 アドバンテスト\*"
  printf '%s' "$line" | grep -q "\[高\]"
  printf '%s' "$line" | grep -q "損切り検討"
  printf '%s' "$line" | grep -q "信用売建 逆行で含み損"
}

@test "multiple positions produce multiple sections after header and portfolio" {
  run_pr "U1" '{"portfolio":"x","positions":[{"ticker":"285A","action":"継続","urgency":"低","reason":"a"},{"ticker":"6857","action":"利確","urgency":"中","reason":"b"}]}'
  [ "$status" -eq 0 ]
  [ "$(payload | jq -r '.blocks | length')" = "4" ]
}

@test "reason absent does not append a newline tail" {
  run_pr "U1" '{"portfolio":"x","positions":[{"ticker":"285A","action":"継続","urgency":"低","reason":""}]}'
  [ "$status" -eq 0 ]
  [ "$(payload | jq -r '.blocks[2].text.text')" = "*285A 285A* [低] 継続" ]
}

@test "empty portfolio fails (evaluation not formed)" {
  run_pr "U1" '{"portfolio":"","positions":[{"ticker":"285A","action":"継続","urgency":"低","reason":"a"}]}'
  [ "$status" -ne 0 ]
  printf '%s' "$output" | grep -q "empty portfolio"
}

@test "invalid JSON fails" {
  run_pr "U1" 'not json'
  [ "$status" -ne 0 ]
  printf '%s' "$output" | grep -q "not valid JSON"
}
