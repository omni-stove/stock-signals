#!/usr/bin/env bats
# scripts/post-brief.bats
# post-brief.sh が組み立てる Slack ペイロード (headline + 材料/強気/弱気/注視点の section blocks +
# 決定論の注目水準行 + 観測行) と no_update の早期终了を検証する。
#
# 実行: pnpm run test:sh
#
# 設計:
#   - 外部呼び出し (curl) は POST_BRIEF_DRYRUN=1 で叩かず、組み立てた payload を
#     stderr に "POST <url> <json>" 形式で出すだけにする (注入口)。
#   - run は stderr も $output に混ぜる (2>&1) ので、stdout の状態行と stderr の
#     payload を同じ $output から jq / grep で突き合わせる。
#   - WORKER_URL は必須チェックがあるのでダミー値を渡す (dryrun なので curl は走らない)。
#   - @test の説明は ASCII のみ (bats 1.13 は非ASCIIのテスト名を実行できない)。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  SCRIPT="$ROOT/scripts/post-brief.sh"
  # リバランス観測行は前段ステップが Worker /index-rebalance を並行取得して rebalance-file に
  # 書いたものを読む (post-brief.sh は curl しない)。bats では FETCH_REBALANCE_JSON で注入する
  # (rebalance-file 読みより優先)。既定は「窓外 (note 空)」とし、窓ありのテストだけ上書きする。
  export FETCH_REBALANCE_JSON="${FETCH_REBALANCE_JSON:-{\"ok\":true,\"note\":\"\"}}"
}

# 単純な brief-file (headline + 材料 1 件・分析 1 行) を書く。
write_brief() {
  jq -n --arg h "$1" --arg t "$2" --arg a "$3" \
    '{status:"brief",headline:$h,materials:[{title:$t,analysis:[$a]}],bull:[],bear:[],watch:[]}'
}

# dryrun で post-brief.sh を実行 (brief-file のみ)。stderr も取り込む。
run_pb() {
  local ticker="$1" file="$2"
  run env \
    WORKER_URL="http://test.invalid" \
    SYNC_TOKEN="${SYNC_TOKEN:-}" \
    POST_BRIEF_DRYRUN=1 \
    FETCH_FORCED_JSON="${FETCH_FORCED_JSON:-}" \
    FETCH_REBALANCE_JSON="${FETCH_REBALANCE_JSON:-}" \
    bash "$SCRIPT" "$ticker" "$file" 2>&1
}

# stderr に出た "POST <url> <json>" 行のうち、url 末尾が $1 のものの JSON を返す。
payload_for() {
  printf '%s\n' "$output" | awk -v ep="$1" '
    $1=="POST" && $2 ~ ep"$" { $1=""; $2=""; sub(/^  /,""); print }'
}

# === 引数 / 前提チェック ====================================================

@test "args: missing ticker fails with usage" {
  run env WORKER_URL="http://test.invalid" POST_BRIEF_DRYRUN=1 bash "$SCRIPT"
  [ "$status" -ne 0 ]
}

@test "args: missing brief-file fails" {
  run env WORKER_URL="http://test.invalid" POST_BRIEF_DRYRUN=1 bash "$SCRIPT" 285A
  [ "$status" -ne 0 ]
}

@test "args: nonexistent brief-file fails" {
  run env WORKER_URL="http://test.invalid" POST_BRIEF_DRYRUN=1 bash "$SCRIPT" 285A "$BATS_TEST_TMPDIR/nope.json"
  [ "$status" -ne 0 ]
}

@test "args: invalid JSON brief-file fails" {
  printf 'not json' > "$BATS_TEST_TMPDIR/bad.json"
  run env WORKER_URL="http://test.invalid" POST_BRIEF_DRYRUN=1 bash "$SCRIPT" 285A "$BATS_TEST_TMPDIR/bad.json"
  [ "$status" -ne 0 ]
}

@test "args: missing WORKER_URL fails" {
  write_brief "HEAD" "2026-08-05 t" "a" > "$BATS_TEST_TMPDIR/m.json"
  run env POST_BRIEF_DRYRUN=1 bash "$SCRIPT" 285A "$BATS_TEST_TMPDIR/m.json"
  [ "$status" -ne 0 ]
}

# === no_update: 投稿も保存もしない正常出口 ===================================

@test "no_update: skips posting and exits 0" {
  jq -n '{status:"no_update",headline:null,materials:[],bull:[],bear:[],watch:[]}' \
    > "$BATS_TEST_TMPDIR/nu.json"
  run_pb 285A "$BATS_TEST_TMPDIR/nu.json"
  [ "$status" -eq 0 ]
  printf '%s\n' "$output" | grep -q "no update"
  # payload (POST 行) が一切出ていないこと
  [ -z "$(payload_for "/slack/post")" ]
}

@test "no_update: brief status with empty headline fails" {
  jq -n '{status:"brief",headline:null,materials:[],bull:[],bear:[],watch:[]}' \
    > "$BATS_TEST_TMPDIR/nh.json"
  run_pb 285A "$BATS_TEST_TMPDIR/nh.json"
  [ "$status" -ne 0 ]
}

# === payload 構造 ===========================================================

# kind / text / ticker / brief_body が載り、先頭 section は headline
@test "payload: carries kind, text, brief_body and headline as first block" {
  write_brief "HEAD line" "2026-08-05 topic" "why it matters" > "$BATS_TEST_TMPDIR/b.json"
  run_pb 285A "$BATS_TEST_TMPDIR/b.json"
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.kind')" = "ticker-brief" ]
  [ "$(printf '%s' "$p" | jq -r '.ticker')" = "285A" ]
  [ "$(printf '%s' "$p" | jq -r '.text')" = "HEAD line" ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[0].text.text')" = "HEAD line" ]
  # brief_body は LLM 由来の本文素テキスト (Worker が briefs に保存する)。
  printf '%s' "$p" | jq -e '.brief_body | test("2026-08-05 topic")' >/dev/null
  printf '%s' "$p" | jq -e '.brief_body | test("why it matters")' >/dev/null
  # 旧 signal フィールドは載らない。
  [ "$(printf '%s' "$p" | jq -r 'has("signal")')" = "false" ]
  printf '%s\n' "$output" | grep -q "slack skipped"
}

# 材料 (🆕 + ・分析) → 強気 (🐂) → 弱気 (🐻) → 注視点 (👀) の順で 1 行 1 section になる
@test "payload: materials, bull, bear, watch render in order with prefixes" {
  jq -n '{status:"brief",headline:"HEAD",
          materials:[{title:"2026-08-05 topic",analysis:["path one","path two"]}],
          bull:["strong point"],bear:["risk point"],watch:["next earnings"]}' \
    > "$BATS_TEST_TMPDIR/b.json"
  run_pb 285A "$BATS_TEST_TMPDIR/b.json"
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  # headline + (title + 分析2) + bull + bear + watch = 7 blocks
  [ "$(printf '%s' "$p" | jq -r '.blocks | length')" -eq 7 ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[1].text.text')" = "🆕 2026-08-05 topic" ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[2].text.text')" = "・path one" ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[3].text.text')" = "・path two" ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[4].text.text')" = "🐂 strong point" ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[5].text.text')" = "🐻 risk point" ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[6].text.text')" = "👀 next earnings" ]
}

# 全リストが空だと本文が組めないので落とす (headline だけの投稿は出さない)
@test "payload: brief with no content lines fails" {
  jq -n '{status:"brief",headline:"HEAD",materials:[],bull:[],bear:[],watch:[]}' \
    > "$BATS_TEST_TMPDIR/e.json"
  run_pb 285A "$BATS_TEST_TMPDIR/e.json"
  [ "$status" -ne 0 ]
}

# === levels: 注目水準行 (numctx の実在値から決定論で組む) =====================

# numctx-file 付きで実行するヘルパ。$1=numctx JSON
run_pb_ctx() {
  local ctx="$1"
  local f="$BATS_TEST_TMPDIR/brief.json" nf="$BATS_TEST_TMPDIR/numctx.json"
  write_brief "HEAD" "2026-08-05 t" "a" > "$f"
  printf '%s' "$ctx" > "$nf"
  run env WORKER_URL="http://test.invalid" POST_BRIEF_DRYRUN=1 \
    FETCH_FORCED_JSON='{"rows":[]}' FETCH_REBALANCE_JSON='{"ok":true,"note":""}' \
    bash "$SCRIPT" 285A "$f" "" "$nf" 2>&1
}

# 全フィールドが揃えば 現値/MA5/MA25/20日レンジ/ATR を 1 行にまとめて末尾に貼る
@test "levels: full numctx renders one line with all fields" {
  run_pb_ctx '{"prices":{"latest":{"price":10000}},
               "daily":{"close":9900,"ma5":9800,"ma25":9700,
                        "range_low_20d":9000,"range_high_20d":10200,"atr_pct":2.4}}'
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  local t; t="$(printf '%s' "$p" | jq -r '.blocks[-1].text.text')"
  printf '%s' "$t" | grep -q "📏 注目水準:"
  printf '%s' "$t" | grep -q "現値 10000"
  printf '%s' "$t" | grep -q "MA5 9800"
  printf '%s' "$t" | grep -q "MA25 9700"
  printf '%s' "$t" | grep -q "20日レンジ 9000〜10200"
  printf '%s' "$t" | grep -q "ATR 2.4%"
}

# prices が無ければ現値は daily.close にフォールバックし、null のフィールドは省かれる
@test "levels: null fields are omitted and close is the price fallback" {
  run_pb_ctx '{"daily":{"close":9900,"ma5":null,"ma25":9700,
                        "range_low_20d":null,"range_high_20d":10200,"atr_pct":null}}'
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  local t; t="$(printf '%s' "$p" | jq -r '.blocks[-1].text.text')"
  printf '%s' "$t" | grep -q "現値 9900"
  printf '%s' "$t" | grep -q "MA25 9700"
  ! printf '%s' "$t" | grep -q "MA5 "
  ! printf '%s' "$t" | grep -q "20日レンジ"
  ! printf '%s' "$t" | grep -q "ATR"
}

# 値が 1 つも無ければ注目水準行ごとスキップする
@test "levels: all-null numctx appends no line" {
  run_pb_ctx '{"daily":{"close":null,"ma5":null,"ma25":null,
                        "range_low_20d":null,"range_high_20d":null,"atr_pct":null}}'
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '[.blocks[].text.text | select(test("注目水準"))] | length')" -eq 0 ]
}

# numctx-file を渡さなければ注目水準行は付かない
@test "levels: omitted numctx-file appends no line" {
  write_brief "HEAD" "2026-08-05 t" "a" > "$BATS_TEST_TMPDIR/b.json"
  run_pb 285A "$BATS_TEST_TMPDIR/b.json"
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '[.blocks[].text.text | select(test("注目水準"))] | length')" -eq 0 ]
}

# 注目水準は brief_body (briefs 保存分) には含めない
@test "levels: level line is not part of brief_body" {
  run_pb_ctx '{"daily":{"close":9900,"ma5":9800,"ma25":9700,
                        "range_low_20d":9000,"range_high_20d":10200,"atr_pct":2.4}}'
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.brief_body | test("注目水準")')" = "false" ]
}

# === forced: 強制決済スコアの観測行を本文末尾に貼る (LLM には渡さない) =======

# stance!=none の行があれば最終 block に "強制フロー観測" 行が付く
@test "forced: building row appends an observation line as last block" {
  write_brief "HEAD" "2026-08-05 t" "a" > "$BATS_TEST_TMPDIR/b.json"
  FETCH_FORCED_JSON='{"rows":[{"stance":"building","summary":"toss warning 285A"}]}' \
    run_pb 285A "$BATS_TEST_TMPDIR/b.json"
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  printf '%s' "$p" | jq -e '.blocks[-1].text.text | test("強制フロー観測")' >/dev/null
  printf '%s' "$p" | jq -e '.blocks[-1].text.text | test("toss warning 285A")' >/dev/null
  # 観測行は brief_body には含めない。
  [ "$(printf '%s' "$p" | jq -r '.brief_body | test("強制フロー観測")')" = "false" ]
}

# stance==none の行は何も足さない
@test "forced: none stance appends nothing" {
  write_brief "HEAD" "2026-08-05 t" "a" > "$BATS_TEST_TMPDIR/b.json"
  FETCH_FORCED_JSON='{"rows":[{"stance":"none","summary":"na"}]}' \
    run_pb 285A "$BATS_TEST_TMPDIR/b.json"
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.blocks[-1].text.text | test("強制フロー観測")')" = "false" ]
}

# === rebalance: 指数リバランス窓の観測行 (LLM には渡さない) ================

# /index-rebalance が note を返す日 (窓内) は観測行が末尾に付く
@test "rebalance: in-window note appends an observation line" {
  write_brief "HEAD" "2026-08-05 t" "a" > "$BATS_TEST_TMPDIR/b.json"
  FETCH_FORCED_JSON='{"rows":[]}' \
    FETCH_REBALANCE_JSON='{"ok":true,"note":"MSCI半期リバランス(実施=本日2026-05-29/...)"}' \
    run_pb 285A "$BATS_TEST_TMPDIR/b.json"
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  printf '%s' "$p" | jq -e '.blocks[-1].text.text | test("リバランス窓")' >/dev/null
  printf '%s' "$p" | jq -e '.blocks[-1].text.text | test("MSCI")' >/dev/null
}

# forced 観測 + リバランス観測が両方ある日は両方付く (順序: forced → rebalance)
@test "rebalance: forced and rebalance observations stack" {
  write_brief "HEAD" "2026-08-05 t" "a" > "$BATS_TEST_TMPDIR/b.json"
  FETCH_FORCED_JSON='{"rows":[{"stance":"building","summary":"toss 285A"}]}' \
    FETCH_REBALANCE_JSON='{"ok":true,"note":"MSCI半期リバランス(実施=本日2026-05-29/...)"}' \
    run_pb 285A "$BATS_TEST_TMPDIR/b.json"
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  printf '%s' "$p" | jq -e '.blocks[-2].text.text | test("強制フロー観測")' >/dev/null
  printf '%s' "$p" | jq -e '.blocks[-1].text.text | test("リバランス窓")' >/dev/null
}

# === rebalance-file: 前段で並行取得した JSON ファイルを第3引数で受け取る ========

# 第3引数のファイルが窓内 note を持てば観測行が付く (FETCH_REBALANCE_JSON 未設定で経路を見る)
@test "rebalance-file: in-window note from file appends an observation line" {
  local f="$BATS_TEST_TMPDIR/brief.json" rf="$BATS_TEST_TMPDIR/rebalance.json"
  write_brief "HEAD" "2026-08-05 t" "a" > "$f"
  printf '%s' '{"ok":true,"note":"FTSE/Russellリバランス(実施=本日)"}' > "$rf"
  # FETCH_REBALANCE_JSON を空にして rebalance-file 読みの経路を通す (注入口が優先されるため)。
  run env WORKER_URL="http://test.invalid" POST_BRIEF_DRYRUN=1 \
    FETCH_FORCED_JSON='{"rows":[]}' FETCH_REBALANCE_JSON="" \
    bash "$SCRIPT" 285A "$f" "$rf" 2>&1
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  printf '%s' "$p" | jq -e '.blocks[-1].text.text | test("リバランス窓")' >/dev/null
  printf '%s' "$p" | jq -e '.blocks[-1].text.text | test("FTSE")' >/dev/null
}

# 第3引数を省略しても (rebalance-file なし) 何も足さず正常終了する
@test "rebalance-file: omitted arg appends nothing" {
  local f="$BATS_TEST_TMPDIR/brief.json"
  write_brief "HEAD" "2026-08-05 t" "a" > "$f"
  run env WORKER_URL="http://test.invalid" POST_BRIEF_DRYRUN=1 \
    FETCH_FORCED_JSON='{"rows":[]}' FETCH_REBALANCE_JSON="" \
    bash "$SCRIPT" 285A "$f" 2>&1
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '[.blocks[].text.text | select(test("リバランス窓"))] | length')" -eq 0 ]
}
