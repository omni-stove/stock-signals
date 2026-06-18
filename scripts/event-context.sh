#!/usr/bin/env bash
# scripts/event-context.sh
# signal-judge / context-builder に「渡す」ための需給イベント文脈を1行で組み立てる。
#
# 設計:
#   - skill 本体にカレンダーを読ませない。決定論的な算出は workflow step (= このスクリプト) が
#     担い、結果を 1 行の文字列として prompt 引数に埋め込む。skill は渡された文字列を解釈するだけ。
#   - SQ は日付から計算で出る (install / yaml メンテ不要):
#       日本SQ = 各月 第2金曜 / 米SQ = 各月 第3金曜 / 3・6・9・12月 = メジャーSQ
#     2つの窓を出す: 「SQ週 (当日を含む月〜金)」= 建玉調整で歪む / 「SQ明け (翌週 月〜金)」=
#     清算が抜けて実勢が見えやすい (歪みの戻りに注意)。明けは月初に前月SQ分が来るため当月+前月を計算。
#   - FOMC / 日銀 / CPI 等は計算できないので config/events.yaml を grep で拾う。
#     公式が年初に全日程を出すので yaml は年1回手動転記する運用 (events.yaml 冒頭参照)。
#
# 前提: GNU date (GitHub Actions ubuntu-latest)。ローカル(BSD date)では動かないので、
#       人間の確認には scripts/events.ts を使う。
#
# 出力: イベント文脈を 1 行で stdout に出す。該当が無ければ "需給イベント: 特になし"。
# 実行: bash scripts/event-context.sh [YYYY-MM-DD]   (引数省略時は今日=JST)

set -euo pipefail

# CI (ubuntu) は GNU date がそのまま `date`。macOS でローカル検証する場合は
# `DATE=gdate bash scripts/event-context.sh ...` で coreutils の gdate を差せる。
DATE="${DATE:-date}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVENTS_YAML="$ROOT/config/events.yaml"

# 基準日 (JST)。CI の TZ は UTC のことが多いので明示的に JST に寄せる。
if [[ $# -ge 1 && -n "${1:-}" ]]; then
  TODAY="$1"
else
  TODAY="$(TZ=Asia/Tokyo "$DATE" +%F)"
fi

# --- SQ 算出 -----------------------------------------------------------------
# 当該月の「第 N 金曜」を YYYY-MM-DD で返す。
nth_friday() {
  local ym="$1" n="$2"           # ym=YYYY-MM, n=何番目の金曜か
  local first="${ym}-01"
  local dow                       # 月初の曜日 (1=月 .. 7=日)
  dow="$("$DATE" -d "$first" +%u)"
  # 月初から最初の金曜(5)までのオフセット
  local off=$(( (5 - dow + 7) % 7 ))
  local day=$(( 1 + off + (n - 1) * 7 ))
  "$DATE" -d "${ym}-01 +$(( day - 1 )) days" +%F
}

# 指定日と SQ 日の位置関係を「同じ週(=SQ週)」「翌週(=SQ明け)」「それ以外」に分類する。
# echo で classify する: "week" / "post" / "" を返す。
sq_phase() {
  local today="$1" sq="$2" monday="$3" friday="$4"
  # 今週(月〜金)に SQ 日が入る → SQ週。
  if [[ "$sq" > "$("$DATE" -d "$monday -1 day" +%F)" && "$sq" < "$("$DATE" -d "$friday +1 day" +%F)" ]]; then
    echo "week"; return
  fi
  # 先週(=SQ週)の SQ で、今週がその翌週 → SQ明け。先週金曜が SQ週金曜なら今週は明け。
  local last_friday; last_friday="$("$DATE" -d "$monday -3 days" +%F)"   # 今週月曜の3日前=先週金曜
  local last_monday; last_monday="$("$DATE" -d "$monday -7 days" +%F)"
  if [[ "$sq" > "$("$DATE" -d "$last_monday -1 day" +%F)" && "$sq" < "$("$DATE" -d "$last_friday +1 day" +%F)" ]]; then
    echo "post"; return
  fi
  echo ""
}

# 指定日が属する週 (月〜金) に SQ 日が入る / その翌週かを判定する。
# 戻り値を介さず、グローバル変数 SQ_NOTE に文脈断片を積む。
SQ_NOTE=""
check_sq() {
  local today="$1"

  # today が属する週の月曜と金曜 (ISO週: 月曜起点)。
  local dow; dow="$("$DATE" -d "$today" +%u)"
  local monday; monday="$("$DATE" -d "$today -$(( dow - 1 )) days" +%F)"
  local friday; friday="$("$DATE" -d "$monday +4 days" +%F)"

  # 当月と前月の SQ を両方計算する (月初は前月 SQ の「明け」が今週に来るため)。
  # 日本SQ = 第2金曜 / 米SQ = 第3金曜。
  local this_ym; this_ym="$("$DATE" -d "$today" +%Y-%m)"
  local prev_ym; prev_ym="$("$DATE" -d "${this_ym}-01 -1 day" +%Y-%m)"

  # SQ 日 → 「その SQ が属する月」でメジャー判定 (3/6/9/12月)。明け週は別月になりうるので
  # today の月ではなく SQ 日の月で判定する。
  local d
  for d in "$(nth_friday "$this_ym" 2):jp" "$(nth_friday "$prev_ym" 2):jp" \
           "$(nth_friday "$this_ym" 3):us" "$(nth_friday "$prev_ym" 3):us"; do
    local sq="${d%:*}" mkt="${d#*:}"
    local phase; phase="$(sq_phase "$today" "$sq" "$monday" "$friday")"
    [[ -z "$phase" ]] && continue
    local sq_month; sq_month="$("$DATE" -d "$sq" +%-m)"
    local is_major="no"; case "$sq_month" in 3|6|9|12) is_major="yes";; esac

    if [[ "$mkt" == "jp" ]]; then
      if [[ "$phase" == "week" ]]; then
        if [[ "$is_major" == "yes" ]]; then
          SQ_NOTE+="日本メジャーSQ週(${sq_month}月限, SQ=${sq}/直接需給イベント・建玉清算で寄り値歪み); "
        else
          SQ_NOTE+="日本SQ週(${sq_month}月限オプションのみ, SQ=${sq}/需給やや歪み); "
        fi
      else  # post
        if [[ "$is_major" == "yes" ]]; then
          SQ_NOTE+="日本メジャーSQ明け(${sq_month}月限, SQ=${sq}/建玉清算が抜け実勢が見えやすい・歪み剥落の戻りに注意); "
        fi
        # マイナーSQの明けはノイズ小さく波及無視。
      fi
    else  # us
      # 米SQは日本個別へ SOX/米指数経由の間接(マクロ)要因。米マイナーSQは波及無視 (メジャーのみ積む)。
      [[ "$is_major" != "yes" ]] && continue
      if [[ "$phase" == "week" ]]; then
        SQ_NOTE+="米メジャーSQ週(${sq_month}月, SQ=${sq}/SOX・米指数経由のマクロ要因・SQ清算由来の振れは持続性低い); "
      else  # post
        SQ_NOTE+="米メジャーSQ明け(${sq_month}月, SQ=${sq}/SOX清算の歪みが抜けた後・地合いは素直に読んでよい); "
      fi
    fi
  done
}

# --- config/events.yaml から近接イベントを拾う ------------------------------
# yaml はフラットな配列。1イベント = "- date:" で始まるブロック。
# 想定キー (date/kind/label/impact/jst_effect_date) だけ拾い、未知キーは無視する
# (フィールド追加で壊れないように)。effect_date = jst_effect_date があればそれ、なければ date。
# 今日から 0〜DAYS 日以内のものを「近接」として出す。
DAYS=5
YAML_NOTE=""
collect_yaml_events() {
  [[ -f "$EVENTS_YAML" ]] || return 0
  local today_epoch; today_epoch="$("$DATE" -d "$TODAY" +%s)"
  local horizon_epoch; horizon_epoch="$("$DATE" -d "$TODAY +$DAYS days" +%s)"

  local date="" kind="" label="" impact="" jst=""
  flush() {
    [[ -z "$date" ]] && return 0
    # SQ は計算側で出すので yaml の jp-sq/us-sq はここでは無視 (二重計上回避)。
    case "$kind" in jp-sq|us-sq) date=""; kind=""; label=""; impact=""; jst=""; return 0;; esac
    local eff="${jst:-$date}"
    local eff_epoch; eff_epoch="$("$DATE" -d "$eff" +%s 2>/dev/null || echo 0)"
    if [[ "$eff_epoch" -ge "$today_epoch" && "$eff_epoch" -le "$horizon_epoch" ]]; then
      local days_until=$(( (eff_epoch - today_epoch) / 86400 ))
      local when; if [[ "$days_until" -eq 0 ]]; then when="本日"; else when="${days_until}日後"; fi
      local imp=""; [[ -n "$impact" ]] && imp="[${impact}]"
      YAML_NOTE+="${label:-$kind}(${eff}/${when})${imp}; "
    fi
    date=""; kind=""; label=""; impact=""; jst=""
  }

  # コメント(#)と空行を除去しつつ走査。値は引用符を剥がす。
  while IFS= read -r line; do
    # 行頭の "- date:" で新ブロック開始 → 直前ブロックを確定。
    if [[ "$line" =~ ^[[:space:]]*-[[:space:]]*date:[[:space:]]*(.*)$ ]]; then
      flush
      date="${BASH_REMATCH[1]//\"/}"; date="${date//\'/}"; date="$(echo "$date" | xargs)"
    elif [[ "$line" =~ ^[[:space:]]*kind:[[:space:]]*(.*)$ ]]; then
      kind="${BASH_REMATCH[1]//\"/}"; kind="${kind//\'/}"; kind="$(echo "$kind" | xargs)"
    elif [[ "$line" =~ ^[[:space:]]*label:[[:space:]]*(.*)$ ]]; then
      label="${BASH_REMATCH[1]//\"/}"; label="${label//\'/}"; label="$(echo "$label" | xargs)"
    elif [[ "$line" =~ ^[[:space:]]*impact:[[:space:]]*(.*)$ ]]; then
      impact="${BASH_REMATCH[1]//\"/}"; impact="${impact//\'/}"; impact="$(echo "$impact" | xargs)"
    elif [[ "$line" =~ ^[[:space:]]*jst_effect_date:[[:space:]]*(.*)$ ]]; then
      jst="${BASH_REMATCH[1]//\"/}"; jst="${jst//\'/}"; jst="$(echo "$jst" | xargs)"
    fi
  done < <(grep -v '^[[:space:]]*#' "$EVENTS_YAML")
  flush
}

# --- 組み立て ----------------------------------------------------------------
check_sq "$TODAY"
collect_yaml_events

OUT="${SQ_NOTE}${YAML_NOTE}"
OUT="$(echo "$OUT" | sed 's/; *$//')"   # 末尾の "; " を除去
if [[ -z "$OUT" ]]; then
  echo "需給イベント(${TODAY}): 特になし"
else
  echo "需給イベント(${TODAY}): ${OUT}"
fi
