#!/usr/bin/env bash
# scripts/event-context.sh
# signal-judge / context-builder に「渡す」ための需給イベント文脈を1行で組み立てる。
#
# 設計:
#   - skill 本体にカレンダーを読ませない。決定論的な算出は workflow step (= このスクリプト) が
#     担い、結果を 1 行の文字列として prompt 引数に埋め込む。skill は渡された文字列を解釈するだけ。
#   - SQ は日付から計算で出る (install / yaml メンテ不要):
#       日本SQ = 各月 第2金曜 / 米SQ = 各月 第3金曜 / 3・6・9・12月 = メジャーSQ
#     窓は「SQ週全体 (月〜金)」。週前半から先物・オプションの建玉調整で需給が歪むため。
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

# 指定日が属する週 (月〜金) に SQ 日が入るか判定する。
# 戻り値を介さず、グローバル変数 SQ_NOTE に文脈断片を積む。
SQ_NOTE=""
check_sq() {
  local today="$1"
  local ym; ym="$("$DATE" -d "$today" +%Y-%m)"
  local month; month="$("$DATE" -d "$today" +%-m)"

  # today が属する週の月曜と金曜 (ISO週: 月曜起点)。
  local dow; dow="$("$DATE" -d "$today" +%u)"
  local monday; monday="$("$DATE" -d "$today -$(( dow - 1 )) days" +%F)"
  local friday; friday="$("$DATE" -d "$monday +4 days" +%F)"

  # メジャー判定 (3/6/9/12月)。
  local is_major="no"
  case "$month" in 3|6|9|12) is_major="yes";; esac

  # 日本SQ = 第2金曜 / 米SQ = 第3金曜。今月分を計算し、今週の月〜金レンジに入るか見る。
  local jp_sq; jp_sq="$(nth_friday "$ym" 2)"
  local us_sq; us_sq="$(nth_friday "$ym" 3)"

  if [[ "$jp_sq" > "$("$DATE" -d "$monday -1 day" +%F)" && "$jp_sq" < "$("$DATE" -d "$friday +1 day" +%F)" ]]; then
    if [[ "$is_major" == "yes" ]]; then
      SQ_NOTE+="日本メジャーSQ週(${month}月限, SQ=${jp_sq}/直接需給イベント・建玉清算で寄り値歪み・確信度を一段抑制); "
    else
      SQ_NOTE+="日本SQ週(${month}月限オプションのみ, SQ=${jp_sq}/需給やや歪み); "
    fi
  fi

  if [[ "$us_sq" > "$("$DATE" -d "$monday -1 day" +%F)" && "$us_sq" < "$("$DATE" -d "$friday +1 day" +%F)" ]]; then
    if [[ "$is_major" == "yes" ]]; then
      # 米メジャーSQ = トリプル/クアドルプル・ウィッチング。日本の個別銘柄には SOX/米指数経由の
      # 間接(マクロ)要因として効く。個別判定に直結させず、SOX の振れの持続性に注記。
      SQ_NOTE+="米メジャーSQ週(${month}月, SQ=${us_sq}/SOX・米指数経由のマクロ要因・SQ清算由来の振れは持続性低い); "
    fi
    # 米マイナーSQはノイズが小さく日本個別への波及は無視できるため積まない。
  fi
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
