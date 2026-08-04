#!/usr/bin/env bats
# scripts/post-position-report.bats
# post-position-report.sh が組み立てる Slack DM ペイロード (事実 1 行 + 建玉ごとの決定論の
# 事実行 + LLM の材料メモ) を検証する。
#
# 実行: pnpm run test:sh
#
# 設計:
#   - 外部呼び出し (curl) は POST_REPORT_DRYRUN=1 で叩かず、組み立てた payload を
#     stderr に "POST <url> <json>" 形式で出すだけにする (注入口)。
#   - run は stderr も $output に混ぜる (2>&1) ので、stdout の状態行と stderr の
#     payload を同じ $output から jq / grep で突き合わせる。
#   - WORKER_URL は必須チェックがあるのでダミー値を渡す (dryrun なので curl は走らない)。
#   - @test の説明は ASCII のみ (bats 1.13 は非ASCIIのテスト名を実行できない)。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  SCRIPT="$ROOT/scripts/post-position-report.sh"
}

# dryrun で post-position-report.sh を実行。stderr も取り込む。
# 引数: $1=userId $2=report-json $3=posctx-json (どちらも JSON 文字列)。
run_pr() {
  local user="$1" report="$2" posctx="$3"
  local rf="$BATS_TEST_TMPDIR/report.json" pf="$BATS_TEST_TMPDIR/posctx.json"
  printf '%s' "$report" > "$rf"
  printf '%s' "$posctx" > "$pf"
  run env \
    WORKER_URL="http://test.invalid" \
    SYNC_TOKEN="${SYNC_TOKEN:-}" \
    POST_REPORT_DRYRUN=1 \
    bash "$SCRIPT" "$user" "$rf" "$pf" 2>&1
}

# payload JSON を $output の "POST <url> <json>" 行から取り出す。
payload() {
  printf '%s\n' "$output" | sed -n 's/^POST [^ ]* //p'
}

POSCTX_ONE='{"positions":[{"ticker":"285A","name":"キオクシア","account":"cash","side":"long","avgPrice":3000,"price":3120,"pnlPct":4}]}'

@test "channel is the userId so chat.postMessage opens a DM" {
  run_pr "U0123ABCD" '{"portfolio":"半導体ロング集中","positions":[{"ticker":"285A","notes":[]}]}' "$POSCTX_ONE"
  [ "$status" -eq 0 ]
  [ "$(payload | jq -r '.channel')" = "U0123ABCD" ]
  [ "$(payload | jq -r '.kind')" = "position-report" ]
}

@test "blocks lead with header then portfolio line" {
  run_pr "U1" '{"portfolio":"半導体ロング2件 含み益側","positions":[{"ticker":"285A","notes":[]}]}' "$POSCTX_ONE"
  [ "$status" -eq 0 ]
  [ "$(payload | jq -r '.blocks[0].text.text')" = "*📋 保有ポジション事実レポート (引け後)*" ]
  [ "$(payload | jq -r '.blocks[1].text.text')" = "半導体ロング2件 含み益側" ]
}

# 建玉の事実行は posctx から決定論で組む (LLM 出力には依存しない)
@test "fact line renders account, side, prices and pnl from posctx" {
  run_pr "U1" '{"portfolio":"x","positions":[{"ticker":"285A","notes":[]}]}' "$POSCTX_ONE"
  [ "$status" -eq 0 ]
  local line
  line="$(payload | jq -r '.blocks[2].text.text')"
  printf '%s' "$line" | grep -q "\*285A キオクシア\*"
  printf '%s' "$line" | grep -q "現物買建"
  printf '%s' "$line" | grep -q "建値 3000 → 現値 3120"
  printf '%s' "$line" | grep -q "(+4%)"
}

@test "short margin position renders its own labels and negative pnl" {
  run_pr "U1" '{"portfolio":"x","positions":[{"ticker":"6857","notes":[]}]}' \
    '{"positions":[{"ticker":"6857","name":"アドバンテスト","account":"margin","side":"short","avgPrice":10000,"price":10500,"pnlPct":-5}]}'
  [ "$status" -eq 0 ]
  local line
  line="$(payload | jq -r '.blocks[2].text.text')"
  printf '%s' "$line" | grep -q "信用売建"
  printf '%s' "$line" | grep -q "(-5%)"
}

@test "null price and pnl render as em dash" {
  run_pr "U1" '{"portfolio":"x","positions":[{"ticker":"285A","notes":[]}]}' \
    '{"positions":[{"ticker":"285A","name":"キオクシア","account":"cash","side":"long","avgPrice":3000,"price":null,"pnlPct":null}]}'
  [ "$status" -eq 0 ]
  local line
  line="$(payload | jq -r '.blocks[2].text.text')"
  printf '%s' "$line" | grep -q "現値 — (—)"
}

# LLM の notes は事実行の下に "・" 行でぶら下がる
@test "notes hang under the fact line" {
  run_pr "U1" '{"portfolio":"x","positions":[{"ticker":"285A","notes":["fresh IR bears on this","margin buildup"]}]}' "$POSCTX_ONE"
  [ "$status" -eq 0 ]
  local line
  line="$(payload | jq -r '.blocks[2].text.text')"
  printf '%s' "$line" | grep -q "・fresh IR bears on this"
  printf '%s' "$line" | grep -q "・margin buildup"
}

@test "empty notes leave the fact line alone" {
  run_pr "U1" '{"portfolio":"x","positions":[{"ticker":"285A","notes":[]}]}' "$POSCTX_ONE"
  [ "$status" -eq 0 ]
  local line
  line="$(payload | jq -r '.blocks[2].text.text')"
  ! printf '%s' "$line" | grep -q "・"
}

# 同一銘柄の現物/信用 2 行持ちでも notes は最初の行にだけ付く
@test "duplicate ticker rows carry notes only once" {
  run_pr "U1" '{"portfolio":"x","positions":[{"ticker":"285A","notes":["one note"]}]}' \
    '{"positions":[
       {"ticker":"285A","name":"キオクシア","account":"cash","side":"long","avgPrice":3000,"price":3120,"pnlPct":4},
       {"ticker":"285A","name":"キオクシア","account":"margin","side":"long","avgPrice":3100,"price":3120,"pnlPct":0.6}]}'
  [ "$status" -eq 0 ]
  [ "$(payload | jq -r '.blocks | length')" = "4" ]
  payload | jq -e '.blocks[2].text.text | test("・one note")' >/dev/null
  [ "$(payload | jq -r '.blocks[3].text.text | test("・")')" = "false" ]
}

@test "multiple positions produce multiple sections after header and portfolio" {
  run_pr "U1" '{"portfolio":"x","positions":[{"ticker":"285A","notes":[]},{"ticker":"6857","notes":[]}]}' \
    '{"positions":[
       {"ticker":"285A","name":"キオクシア","account":"cash","side":"long","avgPrice":3000,"price":3120,"pnlPct":4},
       {"ticker":"6857","name":"アドバンテスト","account":"cash","side":"long","avgPrice":10000,"price":9900,"pnlPct":-1}]}'
  [ "$status" -eq 0 ]
  [ "$(payload | jq -r '.blocks | length')" = "4" ]
}

@test "empty portfolio fails (report not formed)" {
  run_pr "U1" '{"portfolio":"","positions":[{"ticker":"285A","notes":[]}]}' "$POSCTX_ONE"
  [ "$status" -ne 0 ]
  printf '%s' "$output" | grep -q "empty portfolio"
}

@test "invalid report JSON fails" {
  run_pr "U1" 'not json' "$POSCTX_ONE"
  [ "$status" -ne 0 ]
  printf '%s' "$output" | grep -q "not valid JSON"
}

@test "invalid posctx JSON fails" {
  run_pr "U1" '{"portfolio":"x","positions":[]}' 'not json'
  [ "$status" -ne 0 ]
  printf '%s' "$output" | grep -q "not valid JSON"
}

@test "missing posctx arg fails with usage" {
  local rf="$BATS_TEST_TMPDIR/report.json"
  printf '%s' '{"portfolio":"x","positions":[]}' > "$rf"
  run env WORKER_URL="http://test.invalid" POST_REPORT_DRYRUN=1 bash "$SCRIPT" U1 "$rf"
  [ "$status" -ne 0 ]
}
