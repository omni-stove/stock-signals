#!/usr/bin/env bats
# scripts/post-market.bats
# post-market.sh が組み立てる Slack ペイロード (親 = 太字の headline、details = 本文の section blocks) を検証する。
#
# 実行: pnpm run test:sh
#
# 設計:
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
# 構造化 JSON (market-brief の structured_output 相当 {headline, body[]}) を組んで signal-file に
# 書き、script には <signal-file> を渡す。リテラル "\n" は body 配列の分割点にする。
run_pm() {
  local headline="$1" body="$2"
  local f="$BATS_TEST_TMPDIR/market.json"
  jq -n --arg h "$headline" --arg b "$body" \
    '{headline:$h, body:($b | gsub("\\\\n";"\n") | split("\n") | map(select(length>0)))}' > "$f"
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

@test "args: missing signal-file fails with usage" {
  run env WORKER_URL="http://test.invalid" POST_MARKET_DRYRUN=1 bash "$SCRIPT"
  [ "$status" -ne 0 ]
}

@test "args: nonexistent signal-file fails" {
  run env WORKER_URL="http://test.invalid" POST_MARKET_DRYRUN=1 bash "$SCRIPT" "$BATS_TEST_TMPDIR/nope.json"
  [ "$status" -ne 0 ]
}

@test "args: invalid JSON signal-file fails" {
  printf 'not json' > "$BATS_TEST_TMPDIR/bad.json"
  run env WORKER_URL="http://test.invalid" POST_MARKET_DRYRUN=1 bash "$SCRIPT" "$BATS_TEST_TMPDIR/bad.json"
  [ "$status" -ne 0 ]
}

@test "args: empty headline fails" {
  jq -n '{headline:"", body:["x"]}' > "$BATS_TEST_TMPDIR/m.json"
  run env WORKER_URL="http://test.invalid" POST_MARKET_DRYRUN=1 bash "$SCRIPT" "$BATS_TEST_TMPDIR/m.json"
  [ "$status" -ne 0 ]
}

@test "args: missing WORKER_URL fails" {
  jq -n '{headline:"HEAD", body:["body"]}' > "$BATS_TEST_TMPDIR/m.json"
  run env POST_MARKET_DRYRUN=1 bash "$SCRIPT" "$BATS_TEST_TMPDIR/m.json"
  [ "$status" -ne 0 ]
}

# === payload 構造 ===========================================================

# kind / text / ticker(=market) が載り、親の block は太字の headline だけ
@test "payload: carries market-brief kind, market ticker, and bold headline as the only parent block" {
  run_pm "HEAD line" "one line body"
  [ "$status" -eq 0 ]
  local p; p="$(payload)"
  [ "$(printf '%s' "$p" | jq -r '.kind')" = "market-brief" ]
  [ "$(printf '%s' "$p" | jq -r '.ticker')" = "market" ]
  [ "$(printf '%s' "$p" | jq -r '.text')" = "HEAD line" ]
  [ "$(printf '%s' "$p" | jq -r '.blocks | length')" -eq 1 ]
  [ "$(printf '%s' "$p" | jq -r '.blocks[0].text.text')" = "*HEAD line*" ]
  [ "$(printf '%s' "$p" | jq -r '.details.text')" = "one line body" ]
  printf '%s\n' "$output" | grep -q "slack skipped"
}

# === 改行分割 ===============================================================

@test "newline: literal backslash-n splits body into separate blocks" {
  run_pm "HEAD" 'first.\nsecond.\nthird.'
  [ "$status" -eq 0 ]
  local p; p="$(payload)"
  [ "$(printf '%s' "$p" | jq -r '.details.blocks | length')" -eq 3 ]
  [ "$(printf '%s' "$p" | jq -r '.details.blocks[0].text.text')" = "first." ]
  [ "$(printf '%s' "$p" | jq -r '.details.blocks[2].text.text')" = "third." ]
}

@test "newline: blank lines are dropped" {
  run_pm "HEAD" 'a\n\n\nb'
  [ "$status" -eq 0 ]
  local p; p="$(payload)"
  [ "$(printf '%s' "$p" | jq -r '.details.blocks | length')" -eq 2 ]
  [ "$(printf '%s' "$p" | jq -r '.details.blocks[0].text.text')" = "a" ]
  [ "$(printf '%s' "$p" | jq -r '.details.blocks[1].text.text')" = "b" ]
}

# 本文が空なら details を付けない (空のスレッド返信を出さない)
@test "details: empty body omits details" {
  jq -n '{headline:"HEAD", body:[]}' > "$BATS_TEST_TMPDIR/m.json"
  run env WORKER_URL="http://test.invalid" POST_MARKET_DRYRUN=1 bash "$SCRIPT" "$BATS_TEST_TMPDIR/m.json" 2>&1
  [ "$status" -eq 0 ]
  [ "$(payload | jq -r 'has("details")')" = "false" ]
}

# === 数値行 (marketctx から決定論で組む) =====================================

# marketctx を書いて post-market.sh に第2引数で渡す。引数: $1=marketctx JSON。
run_pm_ctx() {
  local f="$BATS_TEST_TMPDIR/market.json" c="$BATS_TEST_TMPDIR/marketctx.json"
  jq -n '{headline:"HEAD", body:["body"]}' > "$f"
  printf '%s' "$1" > "$c"
  run env WORKER_URL="http://test.invalid" POST_MARKET_DRYRUN=1 bash "$SCRIPT" "$f" "$c" 2>&1
}

@test "numbers: builds US, live, sector and flow lines as a context block under the headline" {
  run_pm_ctx '{
    "premarket":{"status":"ok","date":"2026-11-13","us_session":"fresh","sox_change_pct":-2.1,"nasdaq_change_pct":-0.8,
      "dow_change_pct":0.2,"nikkei_futures_price":38500,"usdjpy_price":150.2,"usdjpy_change":-0.4,
      "us10y_yield":4.3,"us10y_change_bp":5,"vix_price":18.5,"vix_change_pct":6.1},
    "live_indexes":{"status":"ok","indexes":[{"key":"nikkei225","label":"日経225","status":"ok","price":38600,"change_pct":-1.2},
      {"key":"kospi","label":"KOSPI","status":"stale","price":2500,"change_pct":0.5}]},
    "sectors":{"status":"ok","sectors":[{"sector":"半導体","avg_change_pct":-1.5,"avg_ret_5d_pct":2.3}]},
    "market_short_ratio":{"status":"ok","ratio_pct":42.1,"avg_5d_pct":39.8},
    "investor_flows":{"status":"ok","week_start":"2026-11-02","week_end":"2026-11-06","net":{"foreigners":-1200},"foreigners_streak_weeks":-2}
  }'
  [ "$status" -eq 0 ]
  local t; t="$(payload | jq -r '.blocks[1].elements[0].text')"
  [ "$(payload | jq -r '.blocks[1].type')" = "context" ]
  grep -qF '前夜米国（2026-11-13）: SOX -2.1% / NASDAQ -0.8% / Dow +0.2% / 日経先物 38500 / ドル円 150.2（-0.4） / 米10年 4.3%（+5bp） / VIX 18.5（+6.1%）' <<<"$t"
  grep -qF '場中: 日経225 38600（-1.2%）' <<<"$t"
  ! grep -qF 'KOSPI' <<<"$t"
  grep -qF 'セクター平均: 半導体 前日比 -1.5%・5日 +2.3%' <<<"$t"
  grep -qF '空売り比率 42.1%（5日平均 39.8%） / 海外投資家 -1200億円（2026-11-02〜2026-11-06・2週連続売り越し）' <<<"$t"
}

@test "numbers: carried-over and stale premarket are tagged next to the date" {
  run_pm_ctx '{"premarket":{"status":"stale","date":"2026-11-12","us_session":"carried_over","sox_change_pct":1}}'
  [ "$status" -eq 0 ]
  payload | jq -r '.blocks[1].elements[0].text' | grep -qF '前夜米国（2026-11-12・休場明けの前回終値・stale）: SOX +1%'
}

@test "numbers: unavailable blocks add no context block" {
  run_pm_ctx '{"premarket":{"status":"unavailable"},"live_indexes":{"status":"unavailable","indexes":[]},
    "sectors":{"status":"unavailable","sectors":[]},"market_short_ratio":{"status":"unavailable"},"investor_flows":{"status":"unavailable"}}'
  [ "$status" -eq 0 ]
  [ "$(payload | jq -r '.blocks | length')" -eq 1 ]
}
