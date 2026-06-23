#!/usr/bin/env bats
# scripts/event-context.bats
# event-context.sh の日付計算ロジックと出力整形を検証する。
#
# 実行: pnpm run test:sh   (ローカルは gdate が要る → setup() で自動的に DATE=gdate を差す)
#       CI (ubuntu) は GNU date が素の `date` なので DATE 不要。
#
# 設計:
#   - 出力は引数 (基準日) から決定論的に決まるので、固定日付を渡して期待文字列を突き合わせる。
#   - module-private なヘルパー関数 (nth_friday 等) は本体を `source` して直接呼ぶ。
#     event-context.sh は `BASH_SOURCE == $0` のときだけ本体を実行するので、source では
#     関数定義だけが読み込まれる。
#   - @test の説明は ASCII のみ (bats 1.13 は非ASCIIのテスト名を実行できない)。
#     日本語の意図はコメントに残す。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  SCRIPT="$ROOT/scripts/event-context.sh"
  # macOS では gdate を使う。CI(ubuntu) では date がそのまま GNU date。
  if [[ -z "${DATE:-}" ]] && command -v gdate >/dev/null 2>&1; then
    export DATE=gdate
  fi
}

# 直接実行して 1 行出力を得るヘルパー。
# マクロイベント (FOMC/日銀) は Worker から取得するが、テストでは MACRO_EVENTS_JSON で固定の
# JSON を注入する (event-context.sh の fetch_macro_events_json はこの環境変数を最優先で使う)。
# 既定では空 (= マクロイベント無し)。WORKER_URL は未設定なので curl も走らない。
run_ctx() {
  run env MACRO_EVENTS_JSON="${MACRO_EVENTS_JSON:-}" WORKER_URL="" bash "$SCRIPT" "$1"
  [ "$status" -eq 0 ]
}

# FOMC を 2026-07-30 (jst_effect_date) に効くものとして注入する JSON。Worker の応答形と同じ。
fomc_json() {
  cat <<'JSON'
{"ok":true,"kind":"macro-events","rows":[
  {"date":"2026-07-29","kind":"fomc","label":"FOMC 政策金利発表 (7月会合)","impact":"high","jst_effect_date":"2026-07-30","note":"x"}
]}
JSON
}

# --- ヘルパー関数の単体テスト (source して直接呼ぶ) --------------------------

# 2026-06 の第2金曜 = 日本SQ (6/12)
@test "nth_friday: 2nd friday of 2026-06 is 06-12" {
  source "$SCRIPT"
  [ "$(nth_friday 2026-06 2)" = "2026-06-12" ]
}

# 2026-06 の第3金曜 = 米SQ (6/19)
@test "nth_friday: 3rd friday of 2026-06 is 06-19" {
  source "$SCRIPT"
  [ "$(nth_friday 2026-06 3)" = "2026-06-19" ]
}

# 月初が金曜の月でも第1金曜を正しく返す (2026-05-01 は金)
@test "nth_friday: handles month starting on friday (2026-05 1st = 05-01)" {
  source "$SCRIPT"
  [ "$(nth_friday 2026-05 1)" = "2026-05-01" ]
}

# 月末が金曜ならそのまま (2026-02-27 は金)
@test "last_business_day: month ending on friday stays (2026-02 = 02-27)" {
  source "$SCRIPT"
  [ "$(last_business_day 2026-02)" = "2026-02-27" ]
}

# 月末が日曜なら金曜へ寄せる (2026-05-31 は日 → 5/29 金)
@test "last_business_day: sunday end shifts back to friday (2026-05 = 05-29)" {
  source "$SCRIPT"
  [ "$(last_business_day 2026-05)" = "2026-05-29" ]
}

# 2026-04 の第1営業日 = 4/1 (水)
@test "nth_business_day: 1st business day of 2026-04 is 04-01" {
  source "$SCRIPT"
  [ "$(nth_business_day 2026-04 1)" = "2026-04-01" ]
}

# 月初が日曜でも最初の平日を返す (2026-02-01 は日 → 2/2 月)
@test "nth_business_day: skips weekend at month start (2026-02 = 02-02)" {
  source "$SCRIPT"
  [ "$(nth_business_day 2026-02 1)" = "2026-02-02" ]
}

# 暦日差 (6/12 → 6/19 = 7)
@test "days_diff: 06-12 to 06-19 is 7" {
  source "$SCRIPT"
  [ "$(days_diff 2026-06-12 2026-06-19)" = "7" ]
}

# --- 出力整形のシナリオテスト (基準日 → 1 行) -------------------------------

# 日本メジャーSQ当日 (2026-06-12) はメジャーSQ週を出す
@test "output: major SQ day shows SQ week note" {
  run_ctx 2026-06-12
  [[ "$output" == *"日本メジャーSQ週(6月限"* ]]
  [[ "$output" == *"SQ=2026-06-12"* ]]
}

# SQ明け週 (2026-06-19) は日本メジャーSQ明け・米メジャーSQ週・FTSEを出す
@test "output: post-SQ week shows JP post / US week / FTSE" {
  run_ctx 2026-06-19
  [[ "$output" == *"日本メジャーSQ明け(6月限"* ]]
  [[ "$output" == *"米メジャーSQ週(6月"* ]]
  [[ "$output" == *"FTSE/Russellリバランス"* ]]
}

# FOMC は jst_effect_date 基準で当日表示される (2026-07-30)。Worker 応答を注入する。
@test "output: FOMC shown on jst_effect_date as today" {
  MACRO_EVENTS_JSON="$(fomc_json)" run_ctx 2026-07-30
  [[ "$output" == *"FOMC 政策金利発表 (7月会合)"* ]]
  [[ "$output" == *"本日"* ]]
  [[ "$output" == *"[high]"* ]]
}

# FOMC は近接 (1日後) でも拾われる (2026-07-29)
@test "output: FOMC picked up 1 day before" {
  MACRO_EVENTS_JSON="$(fomc_json)" run_ctx 2026-07-29
  [[ "$output" == *"2026-07-30/1日後"* ]]
}

# マクロイベント取得不能 (空応答) でも SQ 計算は出る (2026-06-12 はメジャーSQ当日)
@test "output: works without macro events (empty worker response)" {
  MACRO_EVENTS_JSON="" run_ctx 2026-06-12
  [[ "$output" == *"日本メジャーSQ週(6月限"* ]]
}

# 該当イベントが無い日は '特になし' を出す (2026-04-20)。マクロイベントも無し。
@test "output: quiet day shows nothing special" {
  MACRO_EVENTS_JSON="" run_ctx 2026-04-20
  [[ "$output" == *"特になし"* ]]
}

# 出力は常に '需給イベント(基準日):' で始まる単一行
@test "output: single line starting with the standard prefix" {
  run_ctx 2026-06-12
  [[ "$output" == "需給イベント(2026-06-12):"* ]]
  # 改行を含まない (1 行)。
  [ "$(printf '%s' "$output" | wc -l | tr -d ' ')" = "0" ]
}

# --- 指数リバランスの実施前/当日/実施後の出し分け ---------------------------

# MSCI半期リバランス (2026-05-29 実施) の 2 日前は「N日後」文言を出す (実施前)
@test "index: MSCI rebalance shows days-after wording before the date" {
  MACRO_EVENTS_JSON="" run_ctx 2026-05-27
  [[ "$output" == *"MSCI半期リバランス"* ]]
  [[ "$output" == *"実施=2026-05-29/2日後"* ]]
  [[ "$output" == *"当日へ向けた歪み"* ]]
}

# 同リバランスを通過した後 (実施後) は「N日前に通過」文言を出す
@test "index: MSCI rebalance shows passed wording after the date" {
  MACRO_EVENTS_JSON="" run_ctx 2026-06-01
  [[ "$output" == *"MSCI半期リバランス"* ]]
  [[ "$output" == *"実施=2026-05-29/3日前に通過"* ]]
  [[ "$output" == *"剥落"* ]]
}

# FTSE/Russell リバランス (= 米SQ と同日 6/19) 当日は「本日」文言を出す
@test "index: FTSE rebalance on the day shows today wording" {
  MACRO_EVENTS_JSON="" run_ctx 2026-06-19
  [[ "$output" == *"FTSE/Russellリバランス(実施=本日2026-06-19"* ]]
}

# --- マクロイベントのエッジケース -------------------------------------------

# impact が null のときは [..] を付けない
@test "macro: null impact omits the bracket tag" {
  MACRO_EVENTS_JSON='{"rows":[{"date":"2026-07-30","label":"日銀会合","impact":null,"jst_effect_date":"2026-07-30"}]}' \
    run_ctx 2026-07-30
  [[ "$output" == *"日銀会合(2026-07-30/本日)"* ]]
  [[ "$output" != *"[null]"* ]]
  [[ "$output" != *"[]"* ]]
}

# 日付がパースできない行は無視され、正常な行だけが出る
@test "macro: unparseable date is skipped, valid row survives" {
  MACRO_EVENTS_JSON='{"rows":[
    {"date":"not-a-date","label":"broken","impact":"high"},
    {"date":"2026-07-30","label":"正常イベント","impact":"high","jst_effect_date":"2026-07-30"}
  ]}' run_ctx 2026-07-30
  [[ "$output" == *"正常イベント(2026-07-30/本日)[high]"* ]]
  # "broken" は stderr の警告にも出る (run は stderr を $output に混ぜる) ので、
  # マクロ note の体裁 "broken(" が出力本体に無いことで「スキップされた」を判定する。
  [[ "$output" != *"broken("* ]]
}

# 近接窓 (DAYS=5) の外のマクロイベントは拾わない (10日後)
@test "macro: event beyond the horizon window is not picked up" {
  MACRO_EVENTS_JSON='{"rows":[{"date":"2026-08-09","label":"遠いイベント","impact":"high","jst_effect_date":"2026-08-09"}]}' \
    run_ctx 2026-07-30
  [[ "$output" != *"遠いイベント"* ]]
}

# --- 海外SOX系ピア決算 (kind=peer_earnings:<TICKER>) -------------------------

# ピア決算が近接 (3日後) なら「あとX日で<社名>決算→SOX変動リスク」を出す。
# 決算日 2026-06-24 / jst_effect 2026-06-25 を基準日 2026-06-22 から見ると 3 日後。
@test "peer: SOX peer earnings shows X-days SOX risk note" {
  MACRO_EVENTS_JSON='{"rows":[{"date":"2026-06-24","kind":"peer_earnings:MU","label":"マイクロン(MU) 決算","impact":"high","jst_effect_date":"2026-06-25"}]}' \
    run_ctx 2026-06-22
  [[ "$output" == *"あと3日でマイクロン(MU) 決算"* ]]
  [[ "$output" == *"SOX変動リスク"* ]]
  # ピアは PEER_NOTE で出すので、マクロ用の "(日付/N日後)[impact]" 体裁では出さない。
  [[ "$output" != *"マイクロン(MU) 決算(2026"* ]]
}

# ピア決算が波及日 (jst_effect_date) 当日なら「本日」文言を出す。
@test "peer: SOX peer earnings on effect day shows today wording" {
  MACRO_EVENTS_JSON='{"rows":[{"date":"2026-06-24","kind":"peer_earnings:MU","label":"マイクロン(MU) 決算","impact":"high","jst_effect_date":"2026-06-25"}]}' \
    run_ctx 2026-06-25
  [[ "$output" == *"本日マイクロン(MU) 決算→SOX変動リスク"* ]]
}

# 同じ日に複数社が決算でも (kind がティッカーで分かれ衝突しない) 両方出る。
@test "peer: two peers on the same date both appear" {
  MACRO_EVENTS_JSON='{"rows":[
    {"date":"2026-08-13","kind":"peer_earnings:NVDA","label":"エヌビディア(NVDA) 決算","impact":"high","jst_effect_date":"2026-08-14"},
    {"date":"2026-08-13","kind":"peer_earnings:AMAT","label":"アプライド(AMAT) 決算","impact":"high","jst_effect_date":"2026-08-14"}
  ]}' run_ctx 2026-08-12
  [[ "$output" == *"エヌビディア(NVDA) 決算"* ]]
  [[ "$output" == *"アプライド(AMAT) 決算"* ]]
}

# 近接窓 (DAYS=5) の外のピア決算は拾わない (10日後)。
@test "peer: peer earnings beyond the horizon window is not picked up" {
  MACRO_EVENTS_JSON='{"rows":[{"date":"2026-08-09","kind":"peer_earnings:MU","label":"マイクロン(MU) 決算","impact":"high","jst_effect_date":"2026-08-10"}]}' \
    run_ctx 2026-07-30
  [[ "$output" != *"マイクロン(MU)"* ]]
}

# FOMC とピア決算が同時に近接していても、それぞれ別枠で正しく出る。
@test "peer: macro and peer coexist in one line" {
  MACRO_EVENTS_JSON='{"rows":[
    {"date":"2026-07-29","kind":"fomc","label":"FOMC 政策金利発表 (7月会合)","impact":"high","jst_effect_date":"2026-07-30"},
    {"date":"2026-07-31","kind":"peer_earnings:MU","label":"マイクロン(MU) 決算","impact":"high","jst_effect_date":"2026-08-01"}
  ]}' run_ctx 2026-07-30
  [[ "$output" == *"FOMC 政策金利発表 (7月会合)(2026-07-30/本日)[high]"* ]]
  [[ "$output" == *"あと2日でマイクロン(MU) 決算→SOX変動リスク"* ]]
}
