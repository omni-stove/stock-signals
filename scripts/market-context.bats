#!/usr/bin/env bats
# scripts/market-context.bats
# market-context.sh の正規化ロジック (market_phase / premarket 鮮度・unavailable フォールバック /
# event 同梱 / sectors 要約・非配列の unavailable フォールバック / 全体 JSON 形) を検証する。
#
# 実行: pnpm run test:sh   (ローカルは gdate が要る → setup() で自動的に DATE=gdate を差す)
#       CI (ubuntu) は GNU date が素の `date` なので DATE 不要。
#
# 設計 (judge-context.bats と同じ):
#   - Worker /latest への curl は fetch() が見る FETCH_<KIND>_JSON 環境変数で差し替える。地合いで
#     使う KIND は premarket のみ。
#   - event-context.sh の呼び出しは EVENT_TEXT 環境変数で差し替える (curl/date を叩かせない)。
#   - sector.ts (node) の呼び出しは SECTORS_JSON 環境変数で差し替える (node を叩かせない)。
#   - WORKER_URL は必須チェックがあるのでダミー値を渡す (注入があるので curl は走らない)。
#   - market_phase の境界は NOW 注入で固定する。
#   - @test の説明は ASCII のみ (bats 1.13 は非ASCIIのテスト名を実行できない)。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  SCRIPT="$ROOT/scripts/market-context.sh"
  if [[ -z "${DATE:-}" ]] && command -v gdate >/dev/null 2>&1; then
    export DATE=gdate
  fi
}

# 基準日を渡して market-context.sh を実行し、JSON を $output に得る。
# 各注入は呼び出し側で export 済みのものを引き継ぐ。
run_market() {
  local today="$1"
  run env \
    WORKER_URL="http://test.invalid" \
    SYNC_TOKEN="" \
    NOW="${NOW:-}" \
    EVENT_TEXT="${EVENT_TEXT:-}" \
    SECTORS_JSON="${SECTORS_JSON:-}" \
    FETCH_PREMARKET_JSON="${FETCH_PREMARKET_JSON:-}" \
    bash "$SCRIPT" "$today"
  [ "$status" -eq 0 ]
}

# $output (JSON) から jq でフィールドを取り出す。
jqf() { printf '%s' "$output" | jq -r "$1"; }

# 鮮度判定が常に ok になる新しめの premarket 行を作る (fetched_at = 基準日 09:00Z)。
fresh_premarket() {
  local date="$1"
  printf '{"rows":[{"date":"%s","fetched_at":"%sT09:00:00Z","sox_change_pct":%s,"nasdaq_change_pct":%s,"dow_change_pct":%s,"nikkei_futures_price":%s,"nikkei_contract":"2026-06","us_indexes":[]}]}' \
    "$date" "$date" "$2" "$3" "$4" "$5"
}

@test "premarket fields and event line pass through; top-level shape is asof/phase/event/premarket/sectors" {
  export NOW="2026-06-23 08:00"
  export EVENT_TEXT="需給イベント: メジャーSQ週 / FOMC 6/24"
  export FETCH_PREMARKET_JSON="$(fresh_premarket 2026-06-23 -3.2 -1.8 -0.9 38500)"
  export SECTORS_JSON='[]'
  run_market 2026-06-23
  [ "$(jqf '.asof')" = "2026-06-23" ]
  [ "$(jqf '.event_context')" = "需給イベント: メジャーSQ週 / FOMC 6/24" ]
  [ "$(jqf '.premarket.status')" = "ok" ]
  [ "$(jqf '.premarket.sox_change_pct')" = "-3.2" ]
  [ "$(jqf '.premarket.nikkei_futures_price')" = "38500" ]
  # 空配列の sectors は status:ok で sectors:[] になる (非配列ではないため)。
  [ "$(jqf '.sectors.status')" = "ok" ]
  [ "$(jqf '.sectors.sectors | length')" = "0" ]
}

@test "market_phase: before 09:00 JST on a weekday is premarket" {
  export NOW="2026-06-23 08:30"
  export FETCH_PREMARKET_JSON='{}'
  run_market 2026-06-23
  [ "$(jqf '.market_phase')" = "premarket" ]
}

@test "market_phase: 13:00 JST on a weekday is afternoon_session" {
  export NOW="2026-06-23 13:00"
  export FETCH_PREMARKET_JSON='{}'
  run_market 2026-06-23
  [ "$(jqf '.market_phase')" = "afternoon_session" ]
}

@test "market_phase: weekend is closed" {
  # 2026-06-20 は土曜。
  export NOW="2026-06-20 10:00"
  export FETCH_PREMARKET_JSON='{}'
  run_market 2026-06-20
  [ "$(jqf '.market_phase')" = "closed" ]
}

@test "premarket fetch failure ({}) normalizes to status:unavailable" {
  export NOW="2026-06-23 08:00"
  export FETCH_PREMARKET_JSON='{}'
  run_market 2026-06-23
  [ "$(jqf '.premarket.status')" = "unavailable" ]
}

@test "sectors: non-array input falls back to status:unavailable with empty list" {
  export NOW="2026-06-23 08:00"
  export FETCH_PREMARKET_JSON='{}'
  export SECTORS_JSON='not-an-array'
  run_market 2026-06-23
  [ "$(jqf '.sectors.status')" = "unavailable" ]
  [ "$(jqf '.sectors.sectors | length')" = "0" ]
}

@test "sectors: summary keeps tone/avg and per-name rel_strength" {
  export NOW="2026-06-23 08:00"
  export FETCH_PREMARKET_JSON='{}'
  export SECTORS_JSON='[{"sector":"semiconductor","backdrop":{"sox_change_pct":-3.2,"nasdaq_change_pct":-1.8,"nikkei_futures":38500,"premarket_date":"2026-06-23","tone":"risk-off"},"avg_change_pct":-2.1,"avg_ret_5d_pct":-4.5,"rows":[{"code":"6920","name":"laser","sector_role":"inspection","last_date":"2026-06-22","change_pct":-3.5,"ret_5d_pct":-8.0,"vol_ratio":1.8,"rel_strength_pct":-3.5,"note":""}]}]'
  run_market 2026-06-23
  [ "$(jqf '.sectors.status')" = "ok" ]
  [ "$(jqf '.sectors.sectors[0].sector')" = "semiconductor" ]
  [ "$(jqf '.sectors.sectors[0].tone')" = "risk-off" ]
  [ "$(jqf '.sectors.sectors[0].avg_ret_5d_pct')" = "-4.5" ]
  [ "$(jqf '.sectors.sectors[0].rows[0].rel_strength_pct')" = "-3.5" ]
  # 要約は地合い判定に不要なフィールド (sector_role/note/last_date) を落とす。
  [ "$(jqf '.sectors.sectors[0].rows[0] | has("sector_role")')" = "false" ]
}
