#!/usr/bin/env bats
# scripts/post-signal.bats
# post-signal.sh が組み立てる Slack ペイロード (headline + 本文の section blocks) を検証する。
#
# 実行: pnpm run test:sh
#
# 設計:
#   - 外部呼び出し (curl) は POST_SIGNAL_DRYRUN=1 で叩かず、組み立てた payload を
#     stderr に "POST <url> <json>" 形式で出すだけにする (注入口)。
#   - run は stderr も $output に混ぜる (2>&1) ので、stdout の状態行と stderr の
#     payload を同じ $output から jq / grep で突き合わせる。
#   - WORKER_URL は必須チェックがあるのでダミー値を渡す (dryrun なので curl は走らない)。
#   - @test の説明は ASCII のみ (bats 1.13 は非ASCIIのテスト名を実行できない)。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  SCRIPT="$ROOT/scripts/post-signal.sh"
  # リバランス観測行は前段ステップが Worker /index-rebalance を並行取得して rebalance-file に
  # 書いたものを読む (post-signal.sh は curl しない)。bats では FETCH_REBALANCE_JSON で注入する
  # (rebalance-file 読みより優先)。既定は「窓外 (note 空)」とし、窓ありのテストだけ上書きする。
  export FETCH_REBALANCE_JSON="${FETCH_REBALANCE_JSON:-{\"ok\":true,\"note\":\"\"}}"
}

# dryrun で post-signal.sh を実行。stderr も取り込む。
# 引数: $1=ticker $2=headline $3=body。body は "\n" 区切りの本文を body[] 配列に分解した
# 構造化 JSON (signal-judge の structured_output 相当) を組んで signal-file に書き、script には
# <ticker> <signal-file> を渡す。side/line/stop/rr はテスト用のダミー (保存経路は worker 側でテスト)。
run_ps() {
  local ticker="$1" headline="$2" body="$3"
  local f="$BATS_TEST_TMPDIR/signal.json"
  jq -n --arg h "$headline" --arg b "$body" \
    '{side:"buy",exec:"now",line:1000,stop:"MA25",rr:"可",headline:$h,
      body:($b | gsub("\\\\n";"\n") | split("\n") | map(select(length>0)))}' > "$f"
  run env \
    WORKER_URL="http://test.invalid" \
    SYNC_TOKEN="${SYNC_TOKEN:-}" \
    POST_SIGNAL_DRYRUN=1 \
    FETCH_FORCED_JSON="${FETCH_FORCED_JSON:-}" \
    FETCH_REBALANCE_JSON="${FETCH_REBALANCE_JSON:-}" \
    bash "$SCRIPT" "$ticker" "$f" 2>&1
}

# テスト用の signal-file を 1 個書く (headline + 単一 body 行)。rebalance-file 経路のテスト用。
write_signal() {
  jq -n --arg h "$1" --arg b "$2" \
    '{side:"buy",exec:"now",line:1000,stop:"MA25",rr:"可",headline:$h,body:[$b]}'
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

@test "args: missing signal-file fails" {
  run env WORKER_URL="http://test.invalid" POST_SIGNAL_DRYRUN=1 bash "$SCRIPT" 285A
  [ "$status" -ne 0 ]
}

@test "args: nonexistent signal-file fails" {
  run env WORKER_URL="http://test.invalid" POST_SIGNAL_DRYRUN=1 bash "$SCRIPT" 285A "$BATS_TEST_TMPDIR/nope.json"
  [ "$status" -ne 0 ]
}

@test "args: invalid JSON signal-file fails" {
  printf 'not json' > "$BATS_TEST_TMPDIR/bad.json"
  run env WORKER_URL="http://test.invalid" POST_SIGNAL_DRYRUN=1 bash "$SCRIPT" 285A "$BATS_TEST_TMPDIR/bad.json"
  [ "$status" -ne 0 ]
}

@test "args: missing WORKER_URL fails" {
  write_signal "HEAD" "body" > "$BATS_TEST_TMPDIR/m.json"
  run env POST_SIGNAL_DRYRUN=1 bash "$SCRIPT" 285A "$BATS_TEST_TMPDIR/m.json"
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
  # 判定 (side/line/stop/rr) は signal フィールドに載る (Worker が signals に保存する)。
  [ "$(printf '%s' "$p" | jq -r '.signal.side')" = "buy" ]
  [ "$(printf '%s' "$p" | jq -r '.signal.line')" = "1000" ]
  [ "$(printf '%s' "$p" | jq -r '.signal.rr')" = "可" ]
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

# === forced: 強制決済スコアの観測行を本文末尾に貼る (judge には渡さない) =======

# stance!=none の行があれば最終 block に "強制フロー観測" 行が付く
@test "forced: building row appends an observation line as last block" {
  FETCH_FORCED_JSON='{"rows":[{"stance":"building","summary":"toss warning 285A"}]}' \
    run_ps 285A "HEAD" "alpha"
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  # headline + alpha + forced = 3 blocks。最終 block が観測行。
  [ "$(printf '%s' "$p" | jq -r '.blocks | length')" -eq 3 ]
  printf '%s' "$p" | jq -e '.blocks[-1].text.text | test("強制フロー観測")' >/dev/null
  printf '%s' "$p" | jq -e '.blocks[-1].text.text | test("toss warning 285A")' >/dev/null
}

# stance==none の行は何も足さない
@test "forced: none stance appends nothing" {
  FETCH_FORCED_JSON='{"rows":[{"stance":"none","summary":"na"}]}' \
    run_ps 285A "HEAD" "alpha"
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.blocks | length')" -eq 2 ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[-1].text.text | test("強制フロー観測")')" = "false" ]
}

# 行なし (未算出) も何も足さない
@test "forced: missing row appends nothing" {
  FETCH_FORCED_JSON='{"rows":[]}' run_ps 285A "HEAD" "alpha"
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.blocks | length')" -eq 2 ]
}

# === rebalance: 指数リバランス窓の観測行 (judge には渡さない) ================

# /index-rebalance が note を返す日 (窓内) は観測行が末尾に付く
@test "rebalance: in-window note appends an observation line" {
  FETCH_FORCED_JSON='{"rows":[]}' \
    FETCH_REBALANCE_JSON='{"ok":true,"note":"MSCI半期リバランス(実施=本日2026-05-29/...)"}' \
    run_ps 285A "HEAD" "alpha"
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  printf '%s' "$p" | jq -e '.blocks[-1].text.text | test("リバランス窓")' >/dev/null
  printf '%s' "$p" | jq -e '.blocks[-1].text.text | test("MSCI")' >/dev/null
}

# note が空 (窓外) の日は何も足さない
@test "rebalance: empty note appends nothing" {
  FETCH_FORCED_JSON='{"rows":[]}' FETCH_REBALANCE_JSON='{"ok":true,"note":""}' \
    run_ps 285A "HEAD" "alpha"
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.blocks | length')" -eq 2 ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[-1].text.text | test("リバランス窓")')" = "false" ]
}

# forced 観測 + リバランス観測が両方ある日は両方付く (順序: forced → rebalance)
@test "rebalance: forced and rebalance observations stack" {
  FETCH_FORCED_JSON='{"rows":[{"stance":"building","summary":"toss 285A"}]}' \
    FETCH_REBALANCE_JSON='{"ok":true,"note":"MSCI半期リバランス(実施=本日2026-05-29/...)"}' \
    run_ps 285A "HEAD" "alpha"
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  # headline + alpha + forced + rebalance = 4 blocks
  [ "$(printf '%s' "$p" | jq -r '.blocks | length')" -eq 4 ]
  printf '%s' "$p" | jq -e '.blocks[2].text.text | test("強制フロー観測")' >/dev/null
  printf '%s' "$p" | jq -e '.blocks[3].text.text | test("リバランス窓")' >/dev/null
}

# === rebalance-file: 前段で並行取得した JSON ファイルを第3引数で受け取る ========

# 第3引数のファイルが窓内 note を持てば観測行が付く (FETCH_REBALANCE_JSON 未設定で経路を見る)
@test "rebalance-file: in-window note from file appends an observation line" {
  local f="$BATS_TEST_TMPDIR/signal.json" rf="$BATS_TEST_TMPDIR/rebalance.json"
  write_signal "HEAD" "alpha" > "$f"
  printf '%s' '{"ok":true,"note":"FTSE/Russellリバランス(実施=本日)"}' > "$rf"
  # FETCH_REBALANCE_JSON を空にして rebalance-file 読みの経路を通す (注入口が優先されるため)。
  run env WORKER_URL="http://test.invalid" POST_SIGNAL_DRYRUN=1 \
    FETCH_FORCED_JSON='{"rows":[]}' FETCH_REBALANCE_JSON="" \
    bash "$SCRIPT" 285A "$f" "$rf" 2>&1
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  printf '%s' "$p" | jq -e '.blocks[-1].text.text | test("リバランス窓")' >/dev/null
  printf '%s' "$p" | jq -e '.blocks[-1].text.text | test("FTSE")' >/dev/null
}

# 第3引数のファイルが空 note (窓外) なら何も足さない
@test "rebalance-file: empty note from file appends nothing" {
  local f="$BATS_TEST_TMPDIR/signal.json" rf="$BATS_TEST_TMPDIR/rebalance.json"
  write_signal "HEAD" "alpha" > "$f"
  printf '%s' '{"ok":true,"note":""}' > "$rf"
  run env WORKER_URL="http://test.invalid" POST_SIGNAL_DRYRUN=1 \
    FETCH_FORCED_JSON='{"rows":[]}' FETCH_REBALANCE_JSON="" \
    bash "$SCRIPT" 285A "$f" "$rf" 2>&1
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.blocks | length')" -eq 2 ]
}

# 第3引数を省略しても (rebalance-file なし) 何も足さず正常終了する
@test "rebalance-file: omitted arg appends nothing" {
  local f="$BATS_TEST_TMPDIR/signal.json"
  write_signal "HEAD" "alpha" > "$f"
  run env WORKER_URL="http://test.invalid" POST_SIGNAL_DRYRUN=1 \
    FETCH_FORCED_JSON='{"rows":[]}' FETCH_REBALANCE_JSON="" \
    bash "$SCRIPT" 285A "$f" 2>&1
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.blocks | length')" -eq 2 ]
}

# === guard: 押し目ガード (wait の指値をデータ実在アンカーへ決定論で吸着) =======

# ガード用の signal-file と numctx-file を書いて第4引数経路で実行する。
# numctx のアンカーは ref から導出: ma5=ref*0.98 / ma25=ref*0.97 / レンジ下限=ref*0.90 /
# レンジ上限=ref*1.02。$1=side $2=exec $3=line $4=ref $5=atr_pct("null" で欠損)
run_guard() {
  local side="$1" exec="$2" line="$3" ref="$4" atr="$5"
  local f="$BATS_TEST_TMPDIR/signal.json" nf="$BATS_TEST_TMPDIR/numctx.json"
  jq -n --arg side "$side" --arg exec "$exec" --argjson line "$line" \
    '{side:$side,exec:$exec,line:$line,stop:"stop",rr:"可",
      headline:("🧭 285A NAME signal: " + $side + " (" + (if $exec=="wait" then "wait@" + ($line|tostring) else "now" end) + "; 損切り=x / RR可)"),
      body:["alpha"]}' > "$f"
  jq -n --argjson ref "$ref" --argjson atr "$atr" \
    '{prices:{latest:{price:$ref}},
      daily:{close:($ref*0.99),atr_pct:$atr,ma5:($ref*0.98),ma25:($ref*0.97),
             range_low_20d:($ref*0.90),range_high_20d:($ref*1.02)}}' > "$nf"
  run env WORKER_URL="http://test.invalid" POST_SIGNAL_DRYRUN=1 \
    FETCH_FORCED_JSON='{"rows":[]}' FETCH_REBALANCE_JSON='{"ok":true,"note":""}' \
    bash "$SCRIPT" 285A "$f" "" "$nf" 2>&1
}

# 帯内アンカーから遠い買い指値は最寄りの有効アンカーへ吸着する (9200 → ma25=9700)
@test "guard: deep buy line snaps to nearest in-band anchor" {
  run_guard buy wait 9200 10000 2   # 許容3%: ma5=9800(2%) ma25=9700(3%) 下限9000(圏外)
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.signal.exec')" = "wait" ]
  [ "$(printf '%s' "$p" | jq -r '.signal.line')" = "9700" ]
  printf '%s' "$p" | jq -e '.signal.headline | test("wait@9700")' >/dev/null
  printf '%s' "$p" | jq -e '.blocks[-1].text.text | test("押し目ガード") and test("9700")' >/dev/null
}

# 指値が既に有効アンカー値ならそのまま通す (補正行も付かない)
@test "guard: line equal to an in-band anchor passes unchanged" {
  run_guard buy wait 9800 10000 2   # = ma5
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.signal.line')" = "9800" ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[-1].text.text | test("押し目ガード")')" = "false" ]
}

# 買いなのに現値より上の指値 (逆側) も正しい側のアンカーへ吸着する
@test "guard: buy line above reference snaps back to a valid anchor" {
  run_guard buy wait 10200 10000 5
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.signal.exec')" = "wait" ]
  [ "$(printf '%s' "$p" | jq -r '.signal.line')" = "9800" ]
  printf '%s' "$p" | jq -e '.blocks[-1].text.text | test("押し目ガード")' >/dev/null
}

# 売りは参照価格より上のアンカー (レンジ上限) へ吸着する
@test "guard: sell line snaps to the upper-side anchor" {
  run_guard sell wait 10150 10000 2   # 上側の有効アンカーは range_high=10200 のみ
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.signal.exec')" = "wait" ]
  [ "$(printf '%s' "$p" | jq -r '.signal.line')" = "10200" ]
}

# ATR 欠損 (daily stale 等) は 5% を基準にした帯 (7.5%) で判定する
@test "guard: null atr falls back to 5pct-based band" {
  run_guard buy wait 9400 10000 null   # 許容7.5%: ma25=9700 が最寄り (下限9000 は圏外)
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.signal.exec')" = "wait" ]
  [ "$(printf '%s' "$p" | jq -r '.signal.line')" = "9700" ]
}

# 帯内に有効アンカーが 1 つも無ければ now に降格する
@test "guard: no valid anchor demotes to now" {
  local f="$BATS_TEST_TMPDIR/signal.json" nf="$BATS_TEST_TMPDIR/numctx.json"
  jq -n '{side:"buy",exec:"wait",line:9800,stop:"x",rr:"可",
          headline:"🧭 285A NAME signal: buy (wait@9800; 損切り=x / RR可)",body:["alpha"]}' > "$f"
  # 買い側アンカーが全滅: ma は参照より上、レンジ下限は帯 (3%) の外。
  jq -n '{prices:{latest:{price:10000}},
          daily:{close:9900,atr_pct:2,ma5:10100,ma25:10200,
                 range_low_20d:9000,range_high_20d:11000}}' > "$nf"
  run env WORKER_URL="http://test.invalid" POST_SIGNAL_DRYRUN=1 \
    FETCH_FORCED_JSON='{"rows":[]}' FETCH_REBALANCE_JSON='{"ok":true,"note":""}' \
    bash "$SCRIPT" 285A "$f" "" "$nf" 2>&1
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.signal.exec')" = "now" ]
  [ "$(printf '%s' "$p" | jq -r '.signal.line')" = "null" ]
  printf '%s' "$p" | jq -e '.signal.headline | test("now") and (test("wait@") | not)' >/dev/null
  printf '%s' "$p" | jq -e '.blocks[-1].text.text | test("押し目ガード") and test("降格")' >/dev/null
}

# アンカー値の端数は買いで floor される (売りは ceil)
@test "guard: fractional anchor value floors for buy" {
  local f="$BATS_TEST_TMPDIR/signal.json" nf="$BATS_TEST_TMPDIR/numctx.json"
  jq -n '{side:"buy",exec:"wait",line:9700,stop:"x",rr:"可",
          headline:"🧭 285A NAME signal: buy (wait@9700; 損切り=x / RR可)",body:["alpha"]}' > "$f"
  jq -n '{prices:{latest:{price:10000}},
          daily:{close:9900,atr_pct:5,ma5:null,ma25:9700.7,
                 range_low_20d:9000,range_high_20d:11000}}' > "$nf"
  run env WORKER_URL="http://test.invalid" POST_SIGNAL_DRYRUN=1 \
    FETCH_FORCED_JSON='{"rows":[]}' FETCH_REBALANCE_JSON='{"ok":true,"note":""}' \
    bash "$SCRIPT" 285A "$f" "" "$nf" 2>&1
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.signal.line')" = "9700" ]
}

# exec=now はガード対象外 (line も見ない)
@test "guard: exec now is not touched" {
  run_guard buy now 1000 10000 2
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.signal.exec')" = "now" ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[-1].text.text | test("押し目ガード")')" = "false" ]
}

# numctx-file を渡さなければガードはスキップ (従来挙動)
@test "guard: omitted numctx-file skips the guard" {
  local f="$BATS_TEST_TMPDIR/signal.json"
  jq -n '{side:"buy",exec:"wait",line:9200,stop:"x",rr:"可",
          headline:"🧭 285A NAME signal: buy (wait@9200; 損切り=x / RR可)",body:["alpha"]}' > "$f"
  run env WORKER_URL="http://test.invalid" POST_SIGNAL_DRYRUN=1 \
    FETCH_FORCED_JSON='{"rows":[]}' FETCH_REBALANCE_JSON='{"ok":true,"note":""}' \
    bash "$SCRIPT" 285A "$f" 2>&1
  [ "$status" -eq 0 ]
  local p; p="$(payload_for "/slack/post")"
  [ "$(printf '%s' "$p" | jq -r '.signal.exec')" = "wait" ]
}
