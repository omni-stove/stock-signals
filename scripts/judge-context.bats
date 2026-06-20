#!/usr/bin/env bats
# scripts/judge-context.bats
# judge-context.sh の数値正規化ロジック (days_to_earnings / premarket 鮮度 / margin WoW /
# daily レンジ位置・MA位置・出来高倍率 / fetch 失敗の {} 正規化) を検証する。
#
# 実行: pnpm run test:sh   (ローカルは gdate が要る → setup() で自動的に DATE=gdate を差す)
#       CI (ubuntu) は GNU date が素の `date` なので DATE 不要。
#
# 設計:
#   - Worker /latest への curl は judge-context.sh の fetch() が見る FETCH_<KIND>_JSON 環境変数で
#     差し替える (注入口)。<KIND> は earnings/prices/daily/premarket/margin。
#   - Worker /context への curl は CONTEXT_JSON 環境変数で差し替える (注入口)。未指定なら
#     curl が失敗 → context_body=null に倒れる。
#   - WORKER_URL は必須チェックがあるのでダミー値を渡す (注入があるので curl は走らない)。
#   - 出力は JSON 1 行なので jq で値を取り出して突き合わせる。
#   - @test の説明は ASCII のみ (bats 1.13 は非ASCIIのテスト名を実行できない)。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  SCRIPT="$ROOT/scripts/judge-context.sh"
  if [[ -z "${DATE:-}" ]] && command -v gdate >/dev/null 2>&1; then
    export DATE=gdate
  fi
}

# ticker と基準日を渡して judge-context.sh を直接実行し、JSON を $output に得る。
# 各 kind の応答は FETCH_<KIND>_JSON 環境変数で注入する (呼び出し側で export 済みのものを引き継ぐ)。
run_judge() {
  local ticker="$1" today="$2"
  run env \
    WORKER_URL="http://test.invalid" \
    SYNC_TOKEN="" \
    CONTEXT_JSON="${CONTEXT_JSON:-}" \
    FETCH_EARNINGS_JSON="${FETCH_EARNINGS_JSON:-}" \
    FETCH_PRICES_JSON="${FETCH_PRICES_JSON:-}" \
    FETCH_DAILY_JSON="${FETCH_DAILY_JSON:-}" \
    FETCH_PREMARKET_JSON="${FETCH_PREMARKET_JSON:-}" \
    FETCH_MARGIN_JSON="${FETCH_MARGIN_JSON:-}" \
    bash "$SCRIPT" "$ticker" "$today"
  [ "$status" -eq 0 ]
}

# $output (JSON) から jq でフィールドを取り出す。
jqf() { printf '%s' "$output" | jq -r "$1"; }

# 20 本の daily 行を生成する。close を引数で固定し、high/low を散らして range を作る。
# 最新行 (rows[0]) が「現在地」。rows は新しい順 (DESC)。
daily_rows() {
  # 引数: close ma5 ma25 vol  (最新行ぶん)。残り19本はダミーで high/low/volume の母集団を作る。
  cat <<JSON
{"rows":[
  {"date":"2026-06-19","close":$1,"high":$1,"low":$1,"ma5":$2,"ma25":$3,"volume":$4},
  {"date":"2026-06-18","close":100,"high":120,"low":80,"ma5":100,"ma25":100,"volume":1000},
  {"date":"2026-06-17","close":100,"high":110,"low":90,"ma5":100,"ma25":100,"volume":1000},
  {"date":"2026-06-16","close":100,"high":120,"low":80,"ma5":100,"ma25":100,"volume":1000},
  {"date":"2026-06-15","close":100,"high":110,"low":90,"ma5":100,"ma25":100,"volume":1000}
]}
JSON
}

# === context_body (living document 同梱) ====================================

# /context の body が context_body として同梱される
@test "context: body from /context is bundled as context_body" {
  CONTEXT_JSON='{"exists":true,"body":"living doc here","cursors":{"ir":null,"news":null}}' \
    run_judge 285A 2026-06-20
  [ "$(jqf '.context_body')" = "living doc here" ]
}

# /context に行が無い (body null) なら context_body=null
@test "context: missing context row yields null context_body" {
  CONTEXT_JSON='{"exists":false,"body":null,"cursors":{"ir":null,"news":null}}' \
    run_judge 285A 2026-06-20
  [ "$(jqf '.context_body')" = "null" ]
}

# === earnings: days_to_earnings ============================================

# next_date があれば基準日との暦日差を days_to_earnings に出す
@test "earnings: days_to_earnings counts calendar days" {
  FETCH_EARNINGS_JSON='{"rows":[{"next_date":"2026-06-30"}]}' run_judge 285A 2026-06-20
  [ "$(jqf '.earnings.status')" = "ok" ]
  [ "$(jqf '.earnings.days_to_earnings')" = "10" ]
  [ "$(jqf '.earnings.next_date')" = "2026-06-30" ]
}

# next_date が無ければ status=unknown / null
@test "earnings: missing next_date yields unknown" {
  FETCH_EARNINGS_JSON='{"rows":[]}' run_judge 285A 2026-06-20
  [ "$(jqf '.earnings.status')" = "unknown" ]
  [ "$(jqf '.earnings.days_to_earnings')" = "null" ]
}

# fetch 失敗 (空応答 = curl 失敗相当) でも {} に正規化され unknown になる
@test "earnings: empty response normalizes to unknown" {
  FETCH_EARNINGS_JSON='' FETCH_PRICES_JSON='' FETCH_DAILY_JSON='' \
    FETCH_PREMARKET_JSON='' FETCH_MARGIN_JSON='' run_judge 285A 2026-06-20
  [ "$(jqf '.earnings.status')" = "unknown" ]
}

# === premarket: 鮮度判定 ====================================================
# age_hours > 20 で stale。fetched_at は現在時刻から逆算するのでテスト内で生成する。

# 直近 (数分前) の premarket は ok
@test "premarket: fresh fetch is ok" {
  local fresh; fresh="$("${DATE:-date}" -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ)"
  FETCH_PREMARKET_JSON="{\"rows\":[{\"fetched_at\":\"$fresh\",\"sox_change_pct\":1.2}]}" \
    run_judge 285A 2026-06-20
  [ "$(jqf '.premarket.status')" = "ok" ]
  [ "$(jqf '.premarket.sox_change_pct')" = "1.2" ]
}

# 24h 前の premarket は stale (>20h)
@test "premarket: stale when older than 20h" {
  local old; old="$("${DATE:-date}" -u -d '-24 hour' +%Y-%m-%dT%H:%M:%SZ)"
  FETCH_PREMARKET_JSON="{\"rows\":[{\"fetched_at\":\"$old\"}]}" run_judge 285A 2026-06-20
  [ "$(jqf '.premarket.status')" = "stale" ]
}

# premarket 無しは unavailable
@test "premarket: missing rows is unavailable" {
  FETCH_PREMARKET_JSON='{"rows":[]}' run_judge 285A 2026-06-20
  [ "$(jqf '.premarket.status')" = "unavailable" ]
}

# === margin: WoW 増減 =======================================================
# rows は date DESC。rows[0]=最新週 / rows[1]=前週。long_chg = cur - prev。

# 2 週分あれば long_chg/short_chg を前週比で出す
@test "margin: computes WoW change from latest two weeks" {
  FETCH_MARGIN_JSON='{"rows":[
    {"date":"2026-06-19","long_qty":150.0,"short_qty":40.0,"ratio":3.75},
    {"date":"2026-06-12","long_qty":100.0,"short_qty":50.0,"ratio":2.0}
  ]}' run_judge 285A 2026-06-20
  [ "$(jqf '.margin.status')" = "ok" ]
  [ "$(jqf '.margin.long_chg')" = "50" ]
  [ "$(jqf '.margin.short_chg')" = "-10" ]
  [ "$(jqf '.margin.prev_date')" = "2026-06-12" ]
}

# 1 週分しかなければ前週比は null (据え置き)
@test "margin: single week leaves change null" {
  FETCH_MARGIN_JSON='{"rows":[
    {"date":"2026-06-19","long_qty":150.0,"short_qty":40.0,"ratio":3.75}
  ]}' run_judge 285A 2026-06-20
  [ "$(jqf '.margin.status')" = "ok" ]
  [ "$(jqf '.margin.long_chg')" = "null" ]
  [ "$(jqf '.margin.prev_date')" = "null" ]
}

# margin 無しは unavailable
@test "margin: missing rows is unavailable" {
  FETCH_MARGIN_JSON='{"rows":[]}' run_judge 285A 2026-06-20
  [ "$(jqf '.margin.status')" = "unavailable" ]
}

# === daily: レンジ位置 / MA位置 / 出来高倍率 ================================

# 5 本未満は insufficient
@test "daily: fewer than 5 rows is insufficient" {
  FETCH_DAILY_JSON='{"rows":[
    {"date":"2026-06-19","close":100,"high":110,"low":90,"ma5":100,"ma25":100,"volume":1000}
  ]}' run_judge 285A 2026-06-20
  [ "$(jqf '.daily.status')" = "insufficient" ]
  [ "$(jqf '.daily.rows_n')" = "1" ]
}

# 高値圏 (close=最高値) で range_pct=100, MA上 (close>ma5,ma25) で above
@test "daily: top of range is range_pct 100 and ma above" {
  FETCH_DAILY_JSON="$(daily_rows 120 100 100 1000)" run_judge 285A 2026-06-20
  [ "$(jqf '.daily.status')" = "ok" ]
  [ "$(jqf '.daily.range_pct')" = "100" ]
  [ "$(jqf '.daily.ma_position')" = "above" ]
}

# 安値圏 (close=最安値) で range_pct=0, MA下 (close<ma5,ma25) で below
@test "daily: bottom of range is range_pct 0 and ma below" {
  FETCH_DAILY_JSON="$(daily_rows 80 100 100 1000)" run_judge 285A 2026-06-20
  [ "$(jqf '.daily.range_pct')" = "0" ]
  [ "$(jqf '.daily.ma_position')" = "below" ]
}

# close が ma5 の上・ma25 の下なら between (chop)
@test "daily: mixed MA position is between" {
  # close=100, ma5=95 (下), ma25=120 (上) → above 条件も below 条件も満たさず between
  FETCH_DAILY_JSON="$(daily_rows 100 95 120 1000)" run_judge 285A 2026-06-20
  [ "$(jqf '.daily.ma_position')" = "between" ]
}

# 出来高倍率: 最新 volume が平均の約 5 倍 → vol_x_20d ~ 5
@test "daily: volume multiple vs 20d average" {
  # 最新 volume=5000, 他 4 本は 1000 → avg = (5000+1000*4)/5 = 1800, 5000/1800 = 2.7
  FETCH_DAILY_JSON="$(daily_rows 100 100 100 5000)" run_judge 285A 2026-06-20
  [ "$(jqf '.daily.vol_x_20d')" = "2.7" ]
}

# === daily: RSI14 / ATR14 (モメンタム指標) =================================

# 等差で close を並べた daily 行を n 本生成する (新しい順 DESC)。
# 引数: n step  (close[i] = 100 + i*step, i は古い順)。high=close+halfrange, low=close-halfrange。
# halfrange は固定 5 にして TR を読みやすくする。
ramp_rows() {
  jq -n --argjson n "$1" --argjson step "$2" '
    [ range(0;$n) as $i |
      (100 + $i*$step) as $c |
      { date: ("2026-06-" + (if ($i+1)<10 then "0" else "" end) + (($i+1)|tostring)),
        close: $c, high: ($c+5), low: ($c-5), volume: 1000, ma5: null, ma25: null }
    ] | reverse | {rows: .}'
}

# close 5 本だけ (差分4本) では RSI/ATR は計算不能 → null
@test "daily: rsi and atr are null when fewer than 15 closes" {
  FETCH_DAILY_JSON="$(daily_rows 100 100 100 1000)" run_judge 285A 2026-06-20
  [ "$(jqf '.daily.rsi_14')" = "null" ]
  [ "$(jqf '.daily.atr_pct')" = "null" ]
}

# 単調増加 (上げのみ) 15 本 → RSI=100。
@test "daily: monotonic rise gives rsi 100" {
  FETCH_DAILY_JSON="$(ramp_rows 15 10)" run_judge 285A 2026-06-20
  [ "$(jqf '.daily.rsi_14')" = "100" ]
}

# ATR ベースライン (平時比): 系列が最新1本だけ (15本=ATR14が1本) のときは baseline/比は null。
@test "daily: atr baseline null when series too short" {
  FETCH_DAILY_JSON="$(ramp_rows 15 10)" run_judge 285A 2026-06-20
  [ "$(jqf '.daily.atr_pct_baseline')" = "null" ]
  [ "$(jqf '.daily.atr_vs_baseline')" = "null" ]
}

# 系列が十分長ければ baseline (過去中央値) と最新比が出る。step 一定なので atr は一定 → 比 ~1.0。
@test "daily: atr baseline and ratio populate with enough history" {
  # 40 本 → ATR14 系列 26 本。step 一定で TR は一定だが close が増えるので atr_pct は逓減し、
  # 最新 atr_pct < 過去中央値 → atr_vs_baseline < 1。値そのものより「埋まること」を確認する。
  FETCH_DAILY_JSON="$(ramp_rows 40 5)" run_judge 285A 2026-06-20
  [ "$(jqf '.daily.atr_pct_baseline != null')" = "true" ]
  [ "$(jqf '.daily.atr_vs_baseline != null')" = "true" ]
  [ "$(jqf '.daily.atr_vs_baseline < 1')" = "true" ]
}

# 単調減少 (下げのみ) 15 本 → RSI=0。
@test "daily: monotonic fall gives rsi 0" {
  FETCH_DAILY_JSON="$(ramp_rows 15 -10)" run_judge 285A 2026-06-20
  [ "$(jqf '.daily.rsi_14')" = "0" ]
}

# atr_pct = atr_14 / close * 100。単調増加 (step10, 15本) は最新 close=240, ATR=15 → 6.2%。
@test "daily: atr_pct is atr over close" {
  FETCH_DAILY_JSON="$(ramp_rows 15 10)" run_judge 285A 2026-06-20
  # 240 close, ATR 15 → 15/240*100 = 6.25 → floor(62.5)/10 = 6.2
  [ "$(jqf '.daily.atr_pct')" = "6.2" ]
}

# 20日レンジは n=70 で引いても直近20本に窓を絞る (古い安値/高値を拾わない)。
# 30本ランプ: 古い 10 本は窓外。直近20本の low=close[10]-5, high=close[29]+5。
@test "daily: 20d range window stays at 20 even with more rows" {
  # ramp_rows 30 10 → close[10]=200,low=195 / close[29]=390,high=395。range_high/low が窓内に収まる。
  FETCH_DAILY_JSON="$(ramp_rows 30 10)" run_judge 285A 2026-06-20
  [ "$(jqf '.daily.range_low_20d')" = "195" ]
  [ "$(jqf '.daily.range_high_20d')" = "395" ]
}

# === 全体 ===================================================================

# 出力は ticker/today を含む単一 JSON オブジェクト
@test "output: single JSON object carrying ticker and today" {
  FETCH_DAILY_JSON='' run_judge 7203 2026-06-20
  [ "$(jqf '.ticker')" = "7203" ]
  [ "$(jqf '.today')" = "2026-06-20" ]
  # トップレベルキーが揃っている
  [ "$(jqf '. | has("earnings") and has("premarket") and has("daily") and has("prices") and has("margin")')" = "true" ]
}
