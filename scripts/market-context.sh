#!/usr/bin/env bash
# scripts/market-context.sh
# market-check に「渡す」ための地合い (market regime) 数値コンテキストを 1 つの JSON にまとめる。
#
# 設計 (judge-context.sh / event-context.sh と同じ思想):
#   - skill 本体に curl/node を叩かせない。決定論的な fetch + 正規化はこのスクリプト
#     (= workflow step) が担い、結果を 1 つの JSON として prompt 引数に埋める。skill は数値解釈と
#     地合い判定だけに集中する。
#   - judge-context.sh は「1 銘柄」のコンテキストだったが、地合いは銘柄非依存なので引数を取らない。
#     材料は 3 つ:
#       ① premarket  … SOX / NASDAQ / Dow / 日経先物 (前夜 NY の追い風/逆風)。全銘柄共通で 1 回。
#       ② event      … SQ週/SQ明け + FOMC/日銀の近接イベント (event-context.sh の 1 行をそのまま同梱)。
#       ③ sectors    … scripts/sector.ts --json (セクター内の値動きの広がり = 地合いの実勢確認)。
#
# 前提: GNU coreutils date + jq + node (GitHub Actions ubuntu-latest)。ローカル検証は
#       `DATE=gdate bash scripts/market-context.sh`。
#
# 入力: なし (第1引数で基準日 YYYY-MM-DD を上書き可。省略時は今日=JST)。
#       WORKER_URL / SYNC_TOKEN は環境変数。
# 出力: 正規化済み JSON 1 つを stdout に。fetch 失敗フィールドは null / *_status で示す。
# 実行: bash scripts/market-context.sh           (今日=JST)
#       DATE=gdate bash scripts/market-context.sh 2026-06-23

set -euo pipefail

DATE="${DATE:-date}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $# -ge 1 && -n "${1:-}" ]]; then
  TODAY="$1"
else
  TODAY="$(TZ=Asia/Tokyo "$DATE" +%F)"
fi

: "${WORKER_URL:?WORKER_URL is required}"
AUTH=(-H "Authorization: Bearer ${SYNC_TOKEN:-}")

# --- market_phase: 今が JST で東証のどのフェーズか (judge-context.sh と同一ロジック) -------
# 寄り前/場中/昼休み/引け後を 1 フィールドで渡す。テスト用注入口: NOW (= "YYYY-MM-DD HH:MM" JST)。
NOW_JST="${NOW:-$(TZ=Asia/Tokyo "$DATE" '+%F %H:%M')}"
JST_HM="$(printf '%s' "$NOW_JST" | sed -n 's/^[0-9-]* \([0-9][0-9]\):\([0-9][0-9]\).*/\1\2/p')"
JST_DOW="$(TZ=Asia/Tokyo "$DATE" -d "$NOW_JST" '+%u')"  # 1=月 .. 7=日
hm=$((10#${JST_HM:-0000}))
if [[ "$JST_DOW" -ge 6 ]]; then
  MARKET_PHASE="closed"
elif [[ "$hm" -lt 900 ]]; then
  MARKET_PHASE="premarket"
elif [[ "$hm" -lt 1130 ]]; then
  MARKET_PHASE="morning_session"
elif [[ "$hm" -lt 1230 ]]; then
  MARKET_PHASE="lunch_break"
elif [[ "$hm" -lt 1530 ]]; then
  MARKET_PHASE="afternoon_session"
else
  MARKET_PHASE="closed"
fi

# --- fetch: Worker /latest を引く (judge-context.sh と同一の注入口つき) ----------------------
# テスト/オフライン用: FETCH_<KIND>_JSON 環境変数があれば curl を叩かずそれを返す。
fetch() {
  local query="$1"
  local kind; kind="$(printf '%s' "$query" | sed -n 's/^kind=\([a-z]*\).*/\1/p')"
  if [[ -n "$kind" ]]; then
    local var; var="FETCH_$(printf '%s' "$kind" | tr '[:lower:]' '[:upper:]')_JSON"
    if [[ -n "${!var:-}" ]]; then
      printf '%s' "${!var}"
      return 0
    fi
  fi
  local out; out="$(curl -sf "${AUTH[@]}" "$WORKER_URL/latest?$query" 2>/dev/null || true)"
  if [[ -z "$out" ]] || ! echo "$out" | jq -e . >/dev/null 2>&1; then
    echo "{}"
  else
    echo "$out"
  fi
}

# --- ① premarket: SOX / NASDAQ / Dow / 日経先物 + 鮮度 (judge-context.sh と同じ判定) ---------
PREMARKET="$(fetch "kind=premarket&n=1")"
PM_FETCHED="$(echo "$PREMARKET" | jq -r '.rows[0].fetched_at // empty' 2>/dev/null || echo "")"
if [[ -n "$PM_FETCHED" ]]; then
  age_h=$(( ( $("$DATE" +%s) - $("$DATE" -d "$PM_FETCHED" +%s) ) / 3600 ))
  if [[ "$age_h" -gt 20 ]]; then pm_status="stale"; else pm_status="ok"; fi
  PREMARKET_JSON="$(echo "$PREMARKET" | jq --arg st "$pm_status" --argjson age "$age_h" \
    '.rows[0] | {status:$st, age_hours:$age, date, sox_change_pct, nasdaq_change_pct, dow_change_pct, nikkei_futures_price, nikkei_contract, us_indexes}')"
else
  PREMARKET_JSON='{"status":"unavailable"}'
fi

# --- ② event: 需給イベント文脈 (SQ/FOMC/日銀)。event-context.sh の 1 行をそのまま同梱 ---------
# event-context.sh は WORKER_URL を見るが、取得失敗でも SQ/リバランスは出るので失敗は無視する。
# テスト用注入口: EVENT_TEXT があれば event-context.sh を叩かずそれを使う。
if [[ -n "${EVENT_TEXT:-}" ]]; then
  EVENT_LINE="$EVENT_TEXT"
else
  EVENT_LINE="$(DATE="$DATE" bash "$ROOT/scripts/event-context.sh" "$TODAY" 2>/dev/null || echo "需給イベント: 特になし")"
fi

# --- ③ sectors: セクター内の値動きの広がり (sector.ts --json) -------------------------------
# 地合いの「実勢」確認。premarket は前夜 NY の予兆、sectors は手元の保有群が実際にどう動いているか。
# テスト用注入口: SECTORS_JSON があれば node を叩かずそれを使う。node 不在/失敗時は status:unavailable。
if [[ -n "${SECTORS_JSON:-}" ]]; then
  SECTORS_RAW="$SECTORS_JSON"
elif command -v node >/dev/null 2>&1; then
  SECTORS_RAW="$(WORKER_URL="$WORKER_URL" SYNC_TOKEN="${SYNC_TOKEN:-}" node "$ROOT/scripts/sector.ts" --json 2>/dev/null || echo "")"
else
  SECTORS_RAW=""
fi
if [[ -n "$SECTORS_RAW" ]] && echo "$SECTORS_RAW" | jq -e 'type == "array"' >/dev/null 2>&1; then
  # 地合い判定に効く要約だけ抜く: セクターごとの平均前日比 / 平均5日リターン / backdrop tone と、
  # セクター内で「独り負け」している銘柄 (rel_strength_pct がマイナスに大きい) を拾う材料。
  SECTORS_JSON_OUT="$(echo "$SECTORS_RAW" | jq '{
    status: "ok",
    sectors: [ .[] | {
      sector,
      tone: .backdrop.tone,
      avg_change_pct,
      avg_ret_5d_pct,
      rows: [ .rows[] | {code, name, change_pct, ret_5d_pct, rel_strength_pct, vol_ratio} ]
    } ]
  }')"
else
  SECTORS_JSON_OUT='{"status":"unavailable","sectors":[]}'
fi

# --- 1 つの JSON にまとめて stdout へ --------------------------------------------------------
jq -n \
  --arg today "$TODAY" \
  --arg phase "$MARKET_PHASE" \
  --arg event "$EVENT_LINE" \
  --argjson premarket "$PREMARKET_JSON" \
  --argjson sectors "$SECTORS_JSON_OUT" \
  '{
    asof: $today,
    market_phase: $phase,
    event_context: $event,
    premarket: $premarket,
    sectors: $sectors
  }'
