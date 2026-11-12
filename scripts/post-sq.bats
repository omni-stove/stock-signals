#!/usr/bin/env bats
# scripts/post-sq.bats
# post-sq.sh が組み立てる Slack ペイロード (親 = 太字の headline + 数値行、details = シナリオ・SQ連動度・注視) を検証する。
#
# 実行: pnpm run test:sh
#
# 設計:
#   - curl は POST_SQ_DRYRUN=1 で叩かず、組み立てた payload を stderr に "POST <url> <json>" で出す。
#   - @test の説明は ASCII のみ (bats 1.13 は非ASCIIのテスト名を実行できない)。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  SCRIPT="$ROOT/scripts/post-sq.sh"
  SIG="$BATS_TEST_TMPDIR/sq.json"
  CTX="$BATS_TEST_TMPDIR/sqctx.json"
  jq -n '{
    headline: "🎯 SQ週ブリーフ: 寄りの振れに注意",
    scenarios: [
      {name:"上振れ", likelihood:"中", trigger:"SOX 続伸", path:"SQ値が高めに決まり明けに剥落"},
      {name:"下振れ", likelihood:"低", trigger:"米金利上昇", path:"寄りで売り先行"}
    ],
    sensitivity: ["6857 が最も SQ に振られやすい"],
    watch: []
  }' > "$SIG"
  jq -n '{
    sq: {date:"2026-11-13", month:11, major:false, in_week:true, days_to_sq:1, week_start:"2026-11-09"},
    market: {
      nikkei225: {week_to_date:{status:"ok", days:3, latest_date:"2026-11-11", ret_pct:2.5, excess_pct:1}},
      topix: {history:{status:"insufficient"}, week_to_date:{status:"ok", days:3, latest_date:"2026-11-11", ret_pct:1.5}},
      nt_ratio: {status:"ok", nt:15.59, prev_week_end:15.45}
    },
    tickers: [
      {code:"6857", name:"アドバンテスト",
       history:{status:"ok", all:{n:5}, sensitivity:{sq_gap_abs_x:1.94, sq_week_abs_x:0.82, sq_vol_x:1.17, reversal_rate:0.8}},
       week_to_date:{status:"ok", days:3, latest_date:"2026-11-11", ret_pct:12.23, excess_pct:10.73}},
      {code:"6976", name:"太陽誘電", history:{status:"insufficient"}, week_to_date:{status:"ok", days:0, ret_pct:0}}
    ]
  }' > "$CTX"
}

run_sq() {
  run env WORKER_URL="http://test.invalid" POST_SQ_DRYRUN=1 bash "$SCRIPT" "$@" 2>&1
}

payload() {
  printf '%s\n' "$output" | awk '$1=="POST" { $1=""; $2=""; sub(/^  /,""); print }'
}

@test "args: missing signal-file fails" {
  run env WORKER_URL="http://test.invalid" POST_SQ_DRYRUN=1 bash "$SCRIPT"
  [ "$status" -ne 0 ]
}

@test "args: invalid JSON fails" {
  printf 'nope' > "$SIG"
  run_sq "$SIG"
  [ "$status" -ne 0 ]
}

@test "args: empty headline fails" {
  jq -n '{headline:""}' > "$SIG"
  run_sq "$SIG"
  [ "$status" -ne 0 ]
}

@test "parent: bold headline and kind sq-brief" {
  run_sq "$SIG"
  [ "$status" -eq 0 ]
  [ "$(payload | jq -r '.kind')" = "sq-brief" ]
  [ "$(payload | jq -r '.blocks[0].text.text')" = "*🎯 SQ週ブリーフ: 寄りの振れに注意*" ]
}

@test "details: scenarios and sensitivity sections, empty watch omitted" {
  run_sq "$SIG"
  [ "$(payload | jq '.details.blocks | length')" -eq 2 ]
  payload | jq -r '.details.blocks[0].text.text' | grep -qF '・*上振れ*（確度 中）: SOX 続伸'
  payload | jq -r '.details.blocks[0].text.text' | grep -qF '　→ SQ値が高めに決まり明けに剥落'
  payload | jq -r '.details.blocks[1].text.text' | grep -qF '6857 が最も SQ に振られやすい'
}

@test "numbers: no sqctx means no context block" {
  run_sq "$SIG"
  [ "$(payload | jq '[.blocks[] | select(.type=="context")] | length')" -eq 0 ]
}

@test "numbers: sq line, index week-to-date, NT ratio and per-ticker sensitivity" {
  run_sq "$SIG" "$CTX"
  local t
  t="$(payload | jq -r '.blocks[1].elements[0].text')"
  grep -qF 'SQ 2026-11-13（11月限・オプションのみ） あと1日 / 日経225 今週 +2.5%（TOPIX比 +1%） / TOPIX 今週 +1.5% / NT倍率 15.59（前週末 15.45）' <<<"$t"
  grep -qF '6857 アドバンテスト: 今週 +12.23%（TOPIX比 +10.73%） / SQ連動 寄りギャップ 1.94倍 / 週の値幅 0.82倍 / 出来高 1.17倍 / 明け反転 80%（n=5）' <<<"$t"
}

@test "numbers: ticker without data is skipped" {
  run_sq "$SIG" "$CTX"
  ! payload | jq -r '.blocks[1].elements[0].text' | grep -qF '6976'
}
