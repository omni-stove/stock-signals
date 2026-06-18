#!/usr/bin/env bash
# scripts/judge-context.sh
# signal-judge に「渡す」ための数値コンテキストを 1 つの JSON にまとめる。
#
# 設計 (event-context.sh と同じ思想):
#   - skill 本体に curl/gh を叩かせない。決定論的な fetch + 正規化 (鮮度判定・レンジ位置・
#     MA 位置・出来高倍率・days_to_earnings) は workflow step (= このスクリプト) が担い、
#     結果を 1 つの JSON として prompt 引数に埋める。skill は数値解釈と判断だけに集中する。
#   - Issue 本文 (コンテキスト) はここでは扱わない。巨大かつ ticker ラベルで gh が引くだけで
#     正規化不要なので、skill が直接 `gh issue list` で読む (step 2 のまま)。このスクリプトは
#     Worker の数値データ (earnings/prices/daily/premarket) だけを担当する。
#
# 前提: GNU coreutils date + jq (GitHub Actions ubuntu-latest)。ローカル検証は
#       `DATE=gdate bash scripts/judge-context.sh 285A`。
#
# 入力: $1 = ticker (必須)。WORKER_URL / SYNC_TOKEN は環境変数。
# 出力: 正規化済み JSON 1 つを stdout に。fetch 失敗フィールドは null / *_status で示す。
# 実行: bash scripts/judge-context.sh 285A [YYYY-MM-DD]   (第2引数省略時は今日=JST)

set -euo pipefail

DATE="${DATE:-date}"
TICKER="${1:?usage: judge-context.sh <ticker> [YYYY-MM-DD]}"

if [[ $# -ge 2 && -n "${2:-}" ]]; then
  TODAY="$2"
else
  TODAY="$(TZ=Asia/Tokyo "$DATE" +%F)"
fi

: "${WORKER_URL:?WORKER_URL is required}"
AUTH=(-H "Authorization: Bearer ${SYNC_TOKEN:-}")

# Worker /latest を引く。失敗 (非200/空) は "{}" を返す。空文字を jq に渡すと parse error で
# 落ちるため、ここで必ず有効な JSON ("{}") に正規化しておく (以降の jq は安全に走る)。
fetch() {
  local out; out="$(curl -sf "${AUTH[@]}" "$WORKER_URL/latest?$1" 2>/dev/null || true)"
  if [[ -z "$out" ]]; then echo "{}"; else echo "$out"; fi
}

EARNINGS="$(fetch "kind=earnings&code=$TICKER")"
PRICES="$(fetch "kind=prices&code=$TICKER&n=20")"
DAILY="$(fetch "kind=daily&code=$TICKER&n=20")"
PREMARKET="$(fetch "kind=premarket&n=1")"

# --- earnings: days_to_earnings を計算 --------------------------------------
NEXT_DATE="$(echo "$EARNINGS" | jq -r '.rows[0].next_date // empty' 2>/dev/null || echo "")"
if [[ -n "$NEXT_DATE" ]]; then
  d2e=$(( ( $("$DATE" -d "$NEXT_DATE" +%s) - $("$DATE" -d "$TODAY" +%s) ) / 86400 ))
  EARNINGS_JSON="$(jq -n --argjson d "$d2e" --arg nd "$NEXT_DATE" \
    '{status:"ok", next_date:$nd, days_to_earnings:$d}')"
else
  EARNINGS_JSON='{"status":"unknown","next_date":null,"days_to_earnings":null}'
fi

# --- premarket: fetched_at の鮮度を判定 (>~20h で stale = 前夜NY引け前) ------
PM_FETCHED="$(echo "$PREMARKET" | jq -r '.rows[0].fetched_at // empty' 2>/dev/null || echo "")"
if [[ -n "$PM_FETCHED" ]]; then
  age_h=$(( ( $("$DATE" +%s) - $("$DATE" -d "$PM_FETCHED" +%s) ) / 3600 ))
  if [[ "$age_h" -gt 20 ]]; then pm_status="stale"; else pm_status="ok"; fi
  PREMARKET_JSON="$(echo "$PREMARKET" | jq --arg st "$pm_status" --argjson age "$age_h" \
    '.rows[0] | {status:$st, age_hours:$age, sox_change_pct, nasdaq_change_pct, dow_change_pct, nikkei_futures_price, nikkei_contract}')"
else
  PREMARKET_JSON='{"status":"unavailable"}'
fi

# --- daily: 20日レンジ位置 / MA位置 / 出来高倍率を正規化 ----------------------
# rows は新しい順。最新行 (rows[0]) を「現在地」とし、range_pct = (close-low)/(high-low)*100
# (0=安値圏 / 100=高値圏)、MA位置 (above/between/below)、vol_x = 最新volume / 平均volume。
DAILY_ROWS="$(echo "$DAILY" | jq '.rows // []' 2>/dev/null || echo "[]")"
DAILY_N="$(echo "$DAILY_ROWS" | jq 'length')"
if [[ "$DAILY_N" -ge 5 ]]; then
  DAILY_JSON="$(echo "$DAILY_ROWS" | jq '
    (map(.high) | max) as $hi |
    (map(.low)  | min) as $lo |
    (map(.volume) | add / length) as $avgvol |
    .[0] as $cur |
    {
      status: "ok",
      rows_n: length,
      latest_date: $cur.date,
      close: $cur.close,
      range_high_20d: $hi,
      range_low_20d: $lo,
      range_pct: (if ($hi - $lo) > 0 then (($cur.close - $lo) / ($hi - $lo) * 100 | floor) else null end),
      ma5: $cur.ma5,
      ma25: $cur.ma25,
      ma_position: (
        if   $cur.ma5 != null and $cur.ma25 != null and $cur.close > $cur.ma5 and $cur.close > $cur.ma25 then "above"   # uptrend
        elif $cur.ma5 != null and $cur.ma25 != null and $cur.close < $cur.ma5 and $cur.close < $cur.ma25 then "below"   # downtrend
        else "between" end),                                                                                            # chop
      vol_x_20d: (if $avgvol > 0 then ($cur.volume / $avgvol * 10 | floor / 10) else null end)
    }')"
else
  DAILY_JSON="$(jq -n --argjson n "$DAILY_N" '{status:"insufficient", rows_n:$n}')"
fi

# --- prices: トレンドの素材だけ渡す (判断は skill) ---------------------------
# pts_price は skill 側で無視する方針なので JSON には載せるが「使うな」は SKILL 側に明記。
if [[ -n "$PRICES" ]]; then
  PRICES_JSON="$(echo "$PRICES" | jq '
    (.rows // []) as $r |
    if ($r | length) > 0
    then {status:"ok", rows_n:($r|length), latest:$r[0], series:($r | map({slot, change_pct, volume, quote_time}))}
    else {status:"unavailable"} end')"
else
  PRICES_JSON='{"status":"unavailable"}'
fi

# --- 組み立て ----------------------------------------------------------------
jq -n \
  --arg ticker "$TICKER" \
  --arg today "$TODAY" \
  --argjson earnings "$EARNINGS_JSON" \
  --argjson premarket "$PREMARKET_JSON" \
  --argjson daily "$DAILY_JSON" \
  --argjson prices "$PRICES_JSON" \
  '{ticker:$ticker, today:$today, earnings:$earnings, premarket:$premarket, daily:$daily, prices:$prices}'
