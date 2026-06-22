#!/usr/bin/env bash
# scripts/judge-context.sh
# signal-judge に「渡す」ための数値コンテキストを 1 つの JSON にまとめる。
#
# 設計 (event-context.sh と同じ思想):
#   - skill 本体に curl/gh を叩かせない。決定論的な fetch + 正規化 (鮮度判定・レンジ位置・
#     MA 位置・出来高倍率・days_to_earnings) は workflow step (= このスクリプト) が担い、
#     結果を 1 つの JSON として prompt 引数に埋める。skill は数値解釈と判断だけに集中する。
#   - 銘柄コンテキスト (living document) も Worker /context (D1) から引いて context_body として
#     同梱する。従来は skill が直接 `gh issue list` で Issue 本文を読んでいたが、context は D1 に
#     移したため、この決定論的 read もこのスクリプトに集約する (skill の curl/gh 依存を外す)。
#     正規化は不要なので本文は文字列のまま渡す。行が無い銘柄は context_body=null。
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

# --- market_phase: 今が JST で東証のどのフェーズか (寄り前/場中/昼休み/引け後) -----
# quote_status (prices の鮮度) は「最新の取得値がライブか引け値か」しか分からず、寄り前と
# 引け後がどちらも closed になり両者を区別できない。skill が市場フェーズを直接読めるよう、
# JST の現在時刻と曜日から東証の場立てフェーズを 1 フィールドで渡す。
#   premarket          : 平日 〜09:00     (寄り前。前夜 NY を消化中)
#   morning_session    : 平日 09:00-11:30 (前場ザラ場)
#   lunch_break        : 平日 11:30-12:30 (昼休み)
#   afternoon_session  : 平日 12:30-15:30 (後場ザラ場)
#   closed             : 平日 15:30〜 / 土日 (引け後・休場)
# テスト用注入口: NOW (= "YYYY-MM-DD HH:MM" の JST 文字列) があれば現在時刻の代わりに使う。
NOW_JST="${NOW:-$(TZ=Asia/Tokyo "$DATE" '+%F %H:%M')}"
JST_HM="$(printf '%s' "$NOW_JST" | sed -n 's/^[0-9-]* \([0-9][0-9]\):\([0-9][0-9]\).*/\1\2/p')"
JST_DOW="$(TZ=Asia/Tokyo "$DATE" -d "$NOW_JST" '+%u')"  # 1=月 .. 7=日
# 先頭ゼロ付きの時刻 (例 0900) は 8 進数とみなされ 08/09 で落ちるため 10# で 10 進数に固定する。
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

# Worker /latest を引く。失敗 (非200/空) は "{}" を返す。空文字を jq に渡すと parse error で
# 落ちるため、ここで必ず有効な JSON ("{}") に正規化しておく (以降の jq は安全に走る)。
#
# テスト/オフライン用の注入口: FETCH_<KEY>_JSON 環境変数があればそれを最優先で返す
# (curl を一切叩かない)。<KEY> はクエリ先頭の kind を大文字化したもの
# (例: kind=earnings → FETCH_EARNINGS_JSON, kind=daily → FETCH_DAILY_JSON)。
# event-context.sh の MACRO_EVENTS_JSON と同じ思想で、bats から決定論的に固定 JSON を流せる。
fetch() {
  local query="$1"
  # query 先頭の "kind=xxx" から注入用の env 名を組み立てる。
  local kind; kind="$(printf '%s' "$query" | sed -n 's/^kind=\([a-z]*\).*/\1/p')"
  if [[ -n "$kind" ]]; then
    # ${kind^^} は bash 4+ 専用 (macOS の bash 3.2 で落ちる) ので tr で大文字化する。
    local var; var="FETCH_$(printf '%s' "$kind" | tr '[:lower:]' '[:upper:]')_JSON"
    if [[ -n "${!var:-}" ]]; then
      printf '%s' "${!var}"
      return 0
    fi
  fi
  local out; out="$(curl -sf "${AUTH[@]}" "$WORKER_URL/latest?$query" 2>/dev/null || true)"
  # 失敗 (空) でも、タイムアウトで途中まで返った非 JSON でも "{}" に正規化する。
  if [[ -z "$out" ]] || ! echo "$out" | jq -e . >/dev/null 2>&1; then
    echo "{}"
  else
    echo "$out"
  fi
}

# --- 銘柄コンテキスト (living document) を /context から引く ------------------
# 本文は正規化不要なので文字列のまま context_body に載せる。行が無い (初回未生成) 銘柄や
# fetch 失敗は context_body=null とし、skill 側で "context: unavailable" に倒す。
# テスト/オフライン用の注入口: CONTEXT_JSON があれば curl を叩かずそれを使う。
if [[ -n "${CONTEXT_JSON:-}" ]]; then
  CTX="$CONTEXT_JSON"
else
  CTX="$(curl -sf "${AUTH[@]}" "$WORKER_URL/context?code=$TICKER" 2>/dev/null || true)"
fi
echo "$CTX" | jq -e . >/dev/null 2>&1 || CTX='{}'
CONTEXT_BODY="$(echo "$CTX" | jq -r '.body // empty')"

EARNINGS="$(fetch "kind=earnings&code=$TICKER")"
PRICES="$(fetch "kind=prices&code=$TICKER&n=20")"
# RSI14 / ATR14 は直近14本の「前日比」が要る = close 15本以上。さらに ATR の「平時比」(SKILL: heat 判定) を
# 出すには ATR14 系列を複数本作って中央値を取る必要があるため、レンジ位置 (20日) より大きく
# n=70 で引く (ATR14 を約56本分。日足が足りなければ baseline は null になる)。
DAILY="$(fetch "kind=daily&code=$TICKER&n=70")"
PREMARKET="$(fetch "kind=premarket&n=1")"
MARGIN="$(fetch "kind=margin&code=$TICKER&n=4")"

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

# --- margin: 信用残の前週比 (需給) を正規化。判断は skill (SKILL 4c) ----------
# rows は date DESC。最新週 (rows[0]) と前週 (rows[1]) から WoW 増減 (千株) と信用倍率を渡す。
MARGIN_ROWS="$(echo "$MARGIN" | jq '.rows // []' 2>/dev/null || echo "[]")"
MARGIN_N="$(echo "$MARGIN_ROWS" | jq 'length')"
if [[ "$MARGIN_N" -ge 1 ]]; then
  MARGIN_JSON="$(echo "$MARGIN_ROWS" | jq '
    .[0] as $cur |
    (.[1] // null) as $prev |
    {
      status: "ok",
      rows_n: length,
      latest_date: $cur.date,
      long_qty: $cur.long_qty,
      short_qty: $cur.short_qty,
      ratio: $cur.ratio,
      long_chg:  (if $prev != null and $cur.long_qty  != null and $prev.long_qty  != null then (($cur.long_qty  - $prev.long_qty)  * 10 | floor / 10) else null end),
      short_chg: (if $prev != null and $cur.short_qty != null and $prev.short_qty != null then (($cur.short_qty - $prev.short_qty) * 10 | floor / 10) else null end),
      prev_date: ($prev.date // null)
    }')"
else
  MARGIN_JSON='{"status":"unavailable"}'
fi

# --- daily: 20日レンジ位置 / MA位置 / 出来高倍率 / RSI / ATR を正規化 ----------
# rows は新しい順。最新行 (rows[0]) を「現在地」とし、range_pct = (close-low)/(high-low)*100
# (0=安値圏 / 100=高値圏)、MA位置 (above/between/below)、vol_x = 最新volume / 平均volume。
#
# モメンタム指標 (過熱/失速の判別用、SKILL「モメンタムのステージ」参照):
#   rsi_14   買われすぎ/売られすぎ。close の前日比 14本を単純平均した RSI (Wilder ではなく
#            SMA 版 = bash で軽い近似。閾値の読みは普段の RSI と同じく ~70 過熱 / ~30 売られすぎ)。
#   atr_14   値動きの荒さ (True Range の 14日平均)。atr_pct = atr_14/close*100。
#            銘柄横断 (他銘柄比) でも、その銘柄の平時比でも読める。SKILL の heat 判定は後者を使うので、
#            ATR14 をローリング系列として作り、過去の中央値 (atr_pct_baseline) と最新比 (atr_vs_baseline)
#            も渡す。atr_vs_baseline > 1 = 平時より荒い (= 燃えている) サイン。
#
# 注意: range_pct / range_high/low は「20日」レンジ。daily は ATR ベースライン用に n=70 で引くので、
#       レンジ計算は必ず直近20本に窓を絞る (全70本だと "20日レンジ" の意味が壊れる)。
DAILY_ROWS="$(echo "$DAILY" | jq '.rows // []' 2>/dev/null || echo "[]")"
DAILY_N="$(echo "$DAILY_ROWS" | jq 'length')"
if [[ "$DAILY_N" -ge 5 ]]; then
  DAILY_JSON="$(echo "$DAILY_ROWS" | jq '
    # rows は新しい順 (DESC)。古い順 (ASC) に直すと「前日との差」が素直に取れる。
    (sort_by(.date)) as $asc |
    # 20日レンジ・出来高倍率は直近20本 (= $asc の末尾20本) に窓を絞る。
    ($asc[-20:]) as $win20 |
    ($win20 | map(.high) | max) as $hi |
    ($win20 | map(.low)  | min) as $lo |
    ($win20 | map(.volume) | add / ($win20 | length)) as $avgvol |
    .[0] as $cur |

    # --- RSI14 (SMA版) : 直近14本の前日比 close 差から up/down 平均を取る ---------
    # close 15本以上 (= 差分14本) で計算可能。足りなければ null。
    ([ range(1; ($asc|length)) as $i | ($asc[$i].close - $asc[$i-1].close) ]) as $diffs |
    (if ($diffs | length) >= 14
       then ($diffs[-14:]) as $d14 |
            ([ $d14[] | if . > 0 then .   else 0 end ] | add / 14) as $gain |
            ([ $d14[] | if . < 0 then -.  else 0 end ] | add / 14) as $loss |
            (if $loss == 0 then 100
             else (100 - 100 / (1 + $gain / $loss)) end | floor)
       else null end) as $rsi |

    # --- ATR14 ローリング系列 : True Range = max(high-low, |high-prevClose|, |low-prevClose|) ---
    # まず TR 系列 (ASC, 各日1本) を作り、14本窓の移動平均で ATR14 系列を作る。
    ([ range(1; ($asc|length)) as $i |
        ($asc[$i].high - $asc[$i].low) as $hl |
        (($asc[$i].high - $asc[$i-1].close) | if . < 0 then -. else . end) as $hc |
        (($asc[$i].low  - $asc[$i-1].close) | if . < 0 then -. else . end) as $lc |
        [$hl, $hc, $lc] | max
     ]) as $trs |
    # ATR14 を atr_pct (= ATR14/その日のclose*100) の系列として作る。ATR の絶対値は価格水準に
    # 依存するので、平時比は必ず atr_pct ベースで取る (close 0 の日は除外)。
    # j は $trs のインデックス。$trs[j] は $asc[j+1] の TR に対応するので close は $asc[j+1].close。
    ([ range(13; ($trs|length)) as $j |
        ($trs[($j-13):($j+1)] | add / 14) as $a |
        ($asc[$j+1].close) as $c |
        (if $c > 0 then ($a / $c * 1000 | floor / 10) else null end)
     ] | map(select(. != null))) as $atr_pct_series |
    (if ($atr_pct_series | length) >= 1 then $atr_pct_series[-1] else null end) as $atr_pct |
    # baseline = 最新を除いた過去 ATR% の中央値。系列が短い (最新1本のみ) なら null。
    ($atr_pct_series[0:-1] | sort) as $hist |
    (if ($hist | length) >= 5
       then (($hist[ (($hist|length)/2 | floor) ]) * 10 | floor / 10)
       else null end) as $atr_baseline |

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
      # 平均線からの乖離率。傾斜(立ち上がり)の鋭さを数値化する。ma25_dev_pct が大きいのに
      # ma5_dev_pct が小さい (close が ma5 に張り付き) = 放物線的な垂直加速のサイン。SKILL 4b 参照。
      ma25_dev_pct: (if $cur.ma25 != null and $cur.ma25 > 0 then (($cur.close - $cur.ma25) / $cur.ma25 * 1000 | floor / 10) else null end),
      ma5_dev_pct:  (if $cur.ma5  != null and $cur.ma5  > 0 then (($cur.close - $cur.ma5)  / $cur.ma5  * 1000 | floor / 10) else null end),
      vol_x_20d: (if $avgvol > 0 then ($cur.volume / $avgvol * 10 | floor / 10) else null end),
      rsi_14: $rsi,
      atr_pct: $atr_pct,
      # 平時 (過去) の atr_pct 中央値と、最新がその何倍か。SKILL の heat 判定はこの倍率を使う。
      atr_pct_baseline: $atr_baseline,
      atr_vs_baseline: (if $atr_pct != null and $atr_baseline != null and $atr_baseline > 0
                        then ($atr_pct / $atr_baseline * 100 | floor / 100) else null end)
    }')"
else
  DAILY_JSON="$(jq -n --argjson n "$DAILY_N" '{status:"insufficient", rows_n:$n}')"
fi

# --- prices: トレンドの素材だけ渡す (判断は skill) ---------------------------
# pts_price は skill 側で無視する方針なので JSON には載せるが「使うな」は SKILL 側に明記。
#
# 鮮度ラベル (premarket と同じ思想): 日中足は引け後に新しい slot が積まれず、引け後の judge は
# 引け値を「最新」と見てしまう。最新行の fetched_at が >~2h なら quote_status="closed" を渡す。
PRICE_FETCHED="$(echo "$PRICES" | jq -r '.rows[0].fetched_at // empty' 2>/dev/null || echo "")"
if [[ -n "$PRICE_FETCHED" ]]; then
  price_age_h=$(( ( $("$DATE" +%s) - $("$DATE" -d "$PRICE_FETCHED" +%s) ) / 3600 ))
  if [[ "$price_age_h" -gt 2 ]]; then quote_status="closed"; else quote_status="live"; fi
else
  price_age_h=0
  quote_status="unavailable"
fi
if [[ -n "$PRICES" ]]; then
  PRICES_JSON="$(echo "$PRICES" | jq --arg qs "$quote_status" --argjson age "$price_age_h" '
    (.rows // []) as $r |
    if ($r | length) > 0
    then {status:"ok", quote_status:$qs, age_hours:$age, rows_n:($r|length), latest:$r[0], series:($r | map({slot, change_pct, volume, quote_time}))}
    else {status:"unavailable"} end')"
else
  PRICES_JSON='{"status":"unavailable"}'
fi

# --- 組み立て ----------------------------------------------------------------
jq -n \
  --arg ticker "$TICKER" \
  --arg today "$TODAY" \
  --arg market_phase "$MARKET_PHASE" \
  --arg context_body "${CONTEXT_BODY:-}" \
  --argjson earnings "$EARNINGS_JSON" \
  --argjson premarket "$PREMARKET_JSON" \
  --argjson daily "$DAILY_JSON" \
  --argjson prices "$PRICES_JSON" \
  --argjson margin "$MARGIN_JSON" \
  '{ticker:$ticker, today:$today, market_phase:$market_phase, context_body:(if $context_body=="" then null else $context_body end), earnings:$earnings, premarket:$premarket, daily:$daily, prices:$prices, margin:$margin}'
