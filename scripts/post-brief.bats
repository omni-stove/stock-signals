#!/usr/bin/env bats
# scripts/post-brief.bats
# post-brief.sh が組み立てる Slack ペイロード (親 = 太字の headline + 決定論の数値行の context block、
# details = 材料/テクニカル/強気・弱気/注視点の section blocks + 観測行) と no_update の早期終了を検証する。
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

# kind / text / ticker / brief_body が載り、親の block は太字の headline だけ
@test "payload: carries kind, text, brief_body and bold headline as the only parent block" {
  write_brief "HEAD line" "2026-08-05 topic" "why it matters" > "$BATS_TEST_TMPDIR/b.json"
  run_pb 285A "$BATS_TEST_TMPDIR/b.json"
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.kind')" = "ticker-brief" ]
  [ "$(printf '%s' "$p" | jq -r '.ticker')" = "285A" ]
  [ "$(printf '%s' "$p" | jq -r '.text')" = "HEAD line" ]
  [ "$(printf '%s' "$p" | jq -r '.blocks | length')" -eq 1 ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[0].text.text')" = "*HEAD line*" ]
  # スレッド詳細に本文が載る
  printf '%s' "$p" | jq -e '.details.text | test("why it matters")' >/dev/null
  # brief_body は LLM 由来の本文素テキスト (Worker が briefs に保存する)。
  printf '%s' "$p" | jq -e '.brief_body | test("2026-08-05 topic")' >/dev/null
  printf '%s' "$p" | jq -e '.brief_body | test("why it matters")' >/dev/null
  # 旧 signal フィールドは載らない。
  [ "$(printf '%s' "$p" | jq -r 'has("signal")')" = "false" ]
  printf '%s\n' "$output" | grep -q "slack skipped"
}

# emoji はセクション見出しに 1 回だけ出し、項目は ・ で並ぶ
@test "payload: emoji headings group items into one section each" {
  jq -n '{status:"brief",headline:"HEAD",
          materials:[{title:"2026-08-05 topic",analysis:["path one"]},{title:"2026-08-04 other",analysis:["path two"]}],
          technical:["tape read"],
          bull:["strong point","second point"],bear:["risk point"],watch:["next earnings"]}' \
    > "$BATS_TEST_TMPDIR/b.json"
  run_pb 285A "$BATS_TEST_TMPDIR/b.json"
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  # 新着 + テクニカル + 強気 + 弱気 + 注視 = 5 blocks
  [ "$(printf '%s' "$p" | jq -r '.details.blocks | length')" -eq 5 ]
  [ "$(printf '%s' "$p" | jq -r '.details.blocks[0].text.text')" = "$(printf '🆕 *新着*\n・2026-08-05 topic\n　→ path one\n・2026-08-04 other\n　→ path two')" ]
  [ "$(printf '%s' "$p" | jq -r '.details.blocks[1].text.text')" = "$(printf '📈 *テクニカル*\n・tape read')" ]
  [ "$(printf '%s' "$p" | jq -r '.details.blocks[2].text.text')" = "$(printf '🐂 *強気*\n・strong point\n・second point')" ]
  [ "$(printf '%s' "$p" | jq -r '.details.blocks[3].text.text')" = "$(printf '🐻 *弱気*\n・risk point')" ]
  [ "$(printf '%s' "$p" | jq -r '.details.blocks[4].text.text')" = "$(printf '👀 *注視*\n・next earnings')" ]
  # テクニカルの読みは LLM 由来なので brief_body に含める
  printf '%s' "$p" | jq -e '.brief_body | test("tape read")' >/dev/null
}

# 項目が無いセクションは見出しごと出さない
@test "payload: empty groups produce no section" {
  jq -n '{status:"brief",headline:"HEAD",materials:[],technical:[],bull:[],bear:["risk point"],watch:[]}' \
    > "$BATS_TEST_TMPDIR/b.json"
  run_pb 285A "$BATS_TEST_TMPDIR/b.json"
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.details.blocks | length')" -eq 1 ]
  [ "$(printf '%s' "$p" | jq -r '.details.blocks[0].text.text')" = "$(printf '🐻 *弱気*\n・risk point')" ]
}

# 全リストが空だと本文が組めないので落とす (headline だけの投稿は出さない)
@test "payload: brief with no content lines fails" {
  jq -n '{status:"brief",headline:"HEAD",materials:[],bull:[],bear:[],watch:[]}' \
    > "$BATS_TEST_TMPDIR/e.json"
  run_pb 285A "$BATS_TEST_TMPDIR/e.json"
  [ "$status" -ne 0 ]
}

# === numbers: 数値行 (numctx の実在値から決定論で組み、親の context block に貼る) ===

# numctx-file 付きで実行するヘルパ。$1=numctx JSON
run_pb_ctx() {
  local ctx="$1"
  local f="$BATS_TEST_TMPDIR/brief.json" nf="$BATS_TEST_TMPDIR/numctx.json"
  local forced='{"rows":[]}'
  [[ -n "${FETCH_FORCED_JSON:-}" ]] && forced="$FETCH_FORCED_JSON"
  write_brief "HEAD" "2026-08-05 t" "a" > "$f"
  printf '%s' "$ctx" > "$nf"
  run env WORKER_URL="http://test.invalid" POST_BRIEF_DRYRUN=1 \
    FETCH_FORCED_JSON="$forced" FETCH_REBALANCE_JSON='{"ok":true,"note":""}' \
    bash "$SCRIPT" 285A "$f" "" "$nf" 2>&1
}

# payload の context block の本文を返す (無ければ空)。
numbers_text() {
  payload_for "/slack/post" | jq -r '.blocks[] | select(.type == "context") | .elements[0].text'
}

# 現在の行と確定足の行が親の headline の直後の context block に分かれて載る。乖離は符号付き
@test "numbers: full numctx renders current and confirmed lines in one context block" {
  run_pb_ctx '{"prices":{"latest":{"price":10000}},
               "daily":{"status":"ok","latest_date":"2026-10-26","close":9900,"ma5":9800,"ma25":9700,
                        "ma25_dev_pct":2.3,"rsi_14":72,"range_low_20d":9000,"range_high_20d":10200,
                        "range_pct":85,"atr_pct":2.4,"atr_vs_baseline":1.31,"vol_x_20d":1.9,
                        "vol_x_20d_intraday":null,"obv_trend":"rising","cmf_20d":0.12}}'
  [ "$status" -eq 0 ]
  [ "$(payload_for "/slack/post" | jq -r '.blocks | map(.type) | join(",")')" = "section,context" ]
  [ "$(payload_for "/slack/post" | jq -r '[.details.blocks[] | select(.type == "context")] | length')" -eq 0 ]
  [ "$(numbers_text)" = "$(printf '📐 *数値*\n現在: 現値 10000\n2026-10-26 確定足: MA5 9800 / MA25 9700（乖離 +2.3%%） / 20日レンジ 9000〜10200（位置 85%%） / RSI14 72 / ATR 2.4%%（平常比 1.31倍） / 出来高 1.9倍 / OBV 上向き / CMF20 0.12')" ]
}

# ザラ場中の出来高ペースは現在の行に載せ、確定足の行には出来高を載せない。マイナス乖離はそのまま出す
@test "numbers: intraday volume pace goes on the current line" {
  run_pb_ctx '{"prices":{"latest":{"price":10000}},
               "daily":{"status":"ok","latest_date":"2026-10-26","ma25_dev_pct":-3.4,
                        "vol_x_20d":1.9,"vol_x_20d_intraday":0.8}}'
  [ "$status" -eq 0 ]
  [ "$(numbers_text)" = "$(printf '📐 *数値*\n現在: 現値 10000 / 出来高 当日ペース0.8倍\n2026-10-26 確定足: MA25乖離 -3.4%%')" ]
}

# prices が無ければ現値は daily.close にフォールバックし、null のフィールドは省かれる
@test "numbers: null fields are omitted and close is the price fallback" {
  run_pb_ctx '{"daily":{"close":9900,"ma5":null,"ma25":9700,
                        "range_low_20d":null,"range_high_20d":10200,"atr_pct":null}}'
  [ "$status" -eq 0 ]
  [ "$(numbers_text)" = "$(printf '📐 *数値*\n現在: 現値 9900\n最新 確定足: MA25 9700')" ]
}

# 中期の行 (MA75 / 52週高値・安値 / TOPIX比 20日 / 予想PER) は確定足の行の下に載る
@test "numbers: medium-term line from trend, relative and valuation" {
  run_pb_ctx '{"prices":{"latest":{"price":31440}},
               "trend":{"status":"ok","ma75":33727.47,"ma75_dev_pct":-6.8,"high_52w":41990,"from_high_52w_pct":-25.1,
                        "low_52w":18270,"from_low_52w_pct":72.1},
               "relative":{"status":"ok","returns":[{"days":5,"excess_pct":-10},{"days":20,"excess_pct":-17.8}]},
               "valuation":{"status":"ok","per":30.6}}'
  [ "$status" -eq 0 ]
  [ "$(numbers_text)" = "$(printf '📐 *数値*\n現在: 現値 31440\n中期: MA75 33727.47（乖離 -6.8%%） / 52週高値 41990（-25.1%%） / 52週安値 18270（+72.1%%） / TOPIX比 20日 -17.8%% / 予想PER 30.6倍')" ]
}

# trend が insufficient なら中期の行には TOPIX比と PER だけ残る
@test "numbers: insufficient trend keeps only relative and PER" {
  run_pb_ctx '{"trend":{"status":"insufficient"},
               "relative":{"status":"ok","returns":[{"days":20,"excess_pct":3.2}]},
               "valuation":{"status":"unavailable"}}'
  [ "$status" -eq 0 ]
  [ "$(numbers_text)" = "$(printf '📐 *数値*\n中期: TOPIX比 20日 +3.2%%')" ]
}

# 値が 1 つも無ければ context block ごと付かない
@test "numbers: all-null numctx appends no block" {
  run_pb_ctx '{"daily":{"close":null,"ma5":null,"ma25":null,
                        "range_low_20d":null,"range_high_20d":null,"atr_pct":null}}'
  [ "$status" -eq 0 ]
  [ -z "$(numbers_text)" ]
}

# numctx-file を渡さなければ context block は付かない
@test "numbers: omitted numctx-file appends no block" {
  write_brief "HEAD" "2026-08-05 t" "a" > "$BATS_TEST_TMPDIR/b.json"
  run_pb 285A "$BATS_TEST_TMPDIR/b.json"
  [ "$status" -eq 0 ]
  [ -z "$(numbers_text)" ]
}

# daily が stale なら確定足の行は付かず、現値だけ残る
@test "numbers: stale daily drops the confirmed line" {
  run_pb_ctx '{"prices":{"latest":{"price":10000}},"daily":{"status":"stale","latest_date":"2026-10-20"}}'
  [ "$status" -eq 0 ]
  [ "$(numbers_text)" = "$(printf '📐 *数値*\n現在: 現値 10000')" ]
}

# 数値行は brief_body (briefs 保存分) には含めない
@test "numbers: number lines are not part of brief_body" {
  run_pb_ctx '{"prices":{"latest":{"price":10000}},"daily":{"status":"ok","latest_date":"2026-10-26","rsi_14":72}}'
  [ "$status" -eq 0 ]
  numbers_text | grep -q "RSI14 72"
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.brief_body | test("RSI14|現値")')" = "false" ]
}

# 観測行は親ではなく details に載り、数値の context block は親に残る
@test "numbers: observations stay in details while numbers stay in the parent" {
  FETCH_FORCED_JSON='{"rows":[{"stance":"building","summary":"toss 285A"}]}' \
    run_pb_ctx '{"prices":{"latest":{"price":10000}}}'
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  printf '%s' "$p" | jq -e '.details.blocks[-1].text.text | test("強制フロー観測")' >/dev/null
  [ "$(printf '%s' "$p" | jq -r '.blocks[-1].type')" = "context" ]
}

# === forced: 強制決済スコアの観測行を本文末尾に貼る (LLM には渡さない) =======

# stance!=none の行があれば最終 block に "強制フロー観測" 行が付く
@test "forced: building row appends an observation line as last block" {
  write_brief "HEAD" "2026-08-05 t" "a" > "$BATS_TEST_TMPDIR/b.json"
  FETCH_FORCED_JSON='{"rows":[{"stance":"building","summary":"toss warning 285A"}]}' \
    run_pb 285A "$BATS_TEST_TMPDIR/b.json"
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  printf '%s' "$p" | jq -e '.details.blocks[-1].text.text | test("強制フロー観測")' >/dev/null
  printf '%s' "$p" | jq -e '.details.blocks[-1].text.text | test("toss warning 285A")' >/dev/null
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
  [ "$(printf '%s' "$p" | jq -r '.details.blocks[-1].text.text | test("強制フロー観測")')" = "false" ]
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
  printf '%s' "$p" | jq -e '.details.blocks[-1].text.text | test("リバランス窓")' >/dev/null
  printf '%s' "$p" | jq -e '.details.blocks[-1].text.text | test("MSCI")' >/dev/null
}

# forced 観測 + リバランス観測が両方ある日は両方付く (順序: forced → rebalance)
@test "rebalance: forced and rebalance observations stack" {
  write_brief "HEAD" "2026-08-05 t" "a" > "$BATS_TEST_TMPDIR/b.json"
  FETCH_FORCED_JSON='{"rows":[{"stance":"building","summary":"toss 285A"}]}' \
    FETCH_REBALANCE_JSON='{"ok":true,"note":"MSCI半期リバランス(実施=本日2026-05-29/...)"}' \
    run_pb 285A "$BATS_TEST_TMPDIR/b.json"
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  printf '%s' "$p" | jq -e '.details.blocks[-2].text.text | test("強制フロー観測")' >/dev/null
  printf '%s' "$p" | jq -e '.details.blocks[-1].text.text | test("リバランス窓")' >/dev/null
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
  printf '%s' "$p" | jq -e '.details.blocks[-1].text.text | test("リバランス窓")' >/dev/null
  printf '%s' "$p" | jq -e '.details.blocks[-1].text.text | test("FTSE")' >/dev/null
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
  [ "$(printf '%s' "$p" | jq -r '[.details.blocks[].text.text | select(test("リバランス窓"))] | length')" -eq 0 ]
}
