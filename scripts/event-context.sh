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
#   - FOMC / 日銀は計算できないので Worker が公式サイトをスクレープして D1 に持つ。ここでは
#     Worker /latest?kind=macro-events で「今日以降の未来イベント」を引き、近接 (直近 DAYS 日) を拾う。
#     yaml への手動転記は廃止 (Worker が月初 cron で自動更新する。worker/src/lib/macro-events.ts)。
#     WORKER_URL 未設定/取得失敗時はマクロイベント無しで続行する (SQ/指数リバランスは出る)。
#
# 前提: GNU date (GitHub Actions ubuntu-latest) + curl + jq。ローカル(BSD date)では動かないので、
#       人間の確認には DATE=gdate を差す。マクロイベントの取得には WORKER_URL (+任意で SYNC_TOKEN) が要る。
#
# 出力: イベント文脈を 1 行で stdout に出す。該当が無ければ "需給イベント: 特になし"。
# 実行: bash scripts/event-context.sh [YYYY-MM-DD]   (引数省略時は今日=JST)

set -euo pipefail

# CI (ubuntu) は GNU date がそのまま `date`。macOS でローカル検証する場合は
# `DATE=gdate bash scripts/event-context.sh ...` で coreutils の gdate を差せる。
DATE="${DATE:-date}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 基準日 (JST)。CI の TZ は UTC のことが多いので明示的に JST に寄せる。
if [[ $# -ge 1 && -n "${1:-}" ]]; then
  TODAY="$1"
else
  TODAY="$(TZ=Asia/Tokyo "$DATE" +%F)"
fi

# --- 日付ヘルパー ------------------------------------------------------------
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

# 当該月の「最終営業日 (土日を除く)」を YYYY-MM-DD で返す。
# 祝日は考慮しない (祝日カレンダー非保持) ので、最終営業日が祝日なら最大2日ずれうる近似。
# リバランスは「最終営業日±数日の窓」で見るので、この近似で実用上問題ない。
last_business_day() {
  local ym="$1"                  # ym=YYYY-MM
  # 翌月1日の前日 = 当月末日。そこから土(6)/日(7)なら前へ寄せる。
  local eom; eom="$("$DATE" -d "${ym}-01 +1 month -1 day" +%F)"
  local dow; dow="$("$DATE" -d "$eom" +%u)"
  case "$dow" in
    6) "$DATE" -d "$eom -1 day" +%F ;;   # 土 → 金
    7) "$DATE" -d "$eom -2 day" +%F ;;   # 日 → 金
    *) echo "$eom" ;;
  esac
}

# 当該月の「第 N 営業日 (土日を除く, 月初から数える)」を YYYY-MM-DD で返す。祝日は非考慮の近似。
nth_business_day() {
  local ym="$1" n="$2"
  local d="${ym}-01" count=0
  while :; do
    local dow; dow="$("$DATE" -d "$d" +%u)"
    if [[ "$dow" -le 5 ]]; then
      count=$(( count + 1 ))
      [[ "$count" -ge "$n" ]] && { echo "$d"; return; }
    fi
    d="$("$DATE" -d "$d +1 day" +%F)"
  done
}

# 2つの YYYY-MM-DD の暦日差 (b - a)。
days_diff() {
  echo $(( ( $("$DATE" -d "$2" +%s) - $("$DATE" -d "$1" +%s) ) / 86400 ))
}

# --- SQ 算出 -----------------------------------------------------------------

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

# --- 指数リバランス算出 ------------------------------------------------------
# パッシブ資金の機械的な売買が実施日 (リバランス当日) のクロージングに集中する。SQ と同じく
# 日付から計算で出せる「スケジュール型」イベントなので yaml メンテ不要。発表日ではなく実施日基準
# (需給が最も歪むのは実施日)。実施日の前後 IDX_WINDOW 営業日相当 (暦日) を「近接」として積む。
#
# 各指数の実施日規則 (祝日は非考慮の近似。窓で見るので実用上問題ない):
#   MSCI  : 2・5・8・11月の最終営業日のクローズ (Semi-Annual=5/11, Quarterly=2/8)
#   FTSE  : 3・6・9・12月の第3金曜 (= 既存 SQ と同日)
#   日経225: 定期入替の実施は4月初・10月初 (近似: 第1営業日)。臨時入替は別途 (ここでは非対象)
#   TOPIX : 浮動株比率の定期見直し実施は10月末 (近似: 最終営業日)
#
# 監視4銘柄 (285A/6857/6920/6981) は主要指数の常連なので、新規採用より「ウェイト変更/リバランス
# 当日の需給」が効く。除外リスクは突発イベントなのでスケジュール型では拾えない (別途ニュース型で)。
IDX_WINDOW=5
INDEX_NOTE=""

# today と実施日 d の暦日差を見て、|diff| <= IDX_WINDOW なら note を積む。
# 前(=近接)/当日/後(=実施直後の歪み剥落)を文言で出し分ける。
emit_index() {
  local today="$1" d="$2" name="$3"   # name=指数名+補足
  [[ -z "$d" ]] && return 0
  local diff; diff="$(days_diff "$today" "$d")"
  local ad=$(( diff < 0 ? -diff : diff ))
  [[ "$ad" -gt "$IDX_WINDOW" ]] && return 0
  if [[ "$diff" -gt 0 ]]; then
    INDEX_NOTE+="${name}(実施=${d}/${diff}日後・パッシブ需給がクローズに集中, リバランス当日へ向けた歪みに注意); "
  elif [[ "$diff" -eq 0 ]]; then
    INDEX_NOTE+="${name}(実施=本日${d}/引けにパッシブ売買集中・寄りと引けで需給が大きく振れうる); "
  else
    INDEX_NOTE+="${name}(実施=${d}/${ad}日前に通過・リバランス由来の振れは剥落、実勢に戻る局面); "
  fi
}

# today を含む前後 IDX_WINDOW 日に実施日が入りうる指数を、当月+前後月ぶん計算して判定する。
check_index_rebalance() {
  local today="$1"
  local this_ym; this_ym="$("$DATE" -d "$today" +%Y-%m)"
  local prev_ym; prev_ym="$("$DATE" -d "${this_ym}-01 -1 day" +%Y-%m)"
  local next_ym; next_ym="$("$DATE" -d "${this_ym}-01 +1 month" +%Y-%m)"

  # 候補となる (実施日, ラベル) を当月/前月/翌月ぶん列挙し、窓に入るものだけ emit する。
  # case の fall-through を避け、月ごとに該当イベントを素直に列挙する (10月は2件あるため)。
  local ym m
  for ym in "$prev_ym" "$this_ym" "$next_ym"; do
    m="$("$DATE" -d "${ym}-01" +%-m)"
    case "$m" in
      2|8)  emit_index "$today" "$(last_business_day "$ym")" "MSCI四半期リバランス" ;;
      5|11) emit_index "$today" "$(last_business_day "$ym")" "MSCI半期リバランス" ;;
      4)    emit_index "$today" "$(nth_business_day "$ym" 1)" "日経225定期入替" ;;
      10)
        # 10月は TOPIX (月末) と 日経225定期 (月初) が同月内で両方ありうる。
        emit_index "$today" "$(last_business_day "$ym")"  "TOPIX定期見直し"
        emit_index "$today" "$(nth_business_day "$ym" 1)" "日経225定期入替"
        ;;
    esac
    # FTSE/Russell は 3・6・9・12月の第3金曜 (SQ と同日)。
    case "$m" in
      3|6|9|12) emit_index "$today" "$(nth_friday "$ym" 3)" "FTSE/Russellリバランス" ;;
    esac
  done
}

# --- マクロイベント (FOMC/日銀) を Worker /latest?kind=macro-events から拾う ---
# DAYS = 近接窓 (今日から 0〜DAYS 日以内の effect_date を「近接」として積む)。
DAYS=5

# macro-events の JSON を取得する。テスト/オフライン用に MACRO_EVENTS_JSON が与えられて
# いればそれを返す (注入口)。無ければ WORKER_URL から curl する。
# 返す JSON は Worker の {ok, kind, rows:[{date,kind,label,impact,jst_effect_date,note}]}。
# 取得不能 (WORKER_URL 未設定 / curl 失敗 / 非JSON) のときは空文字を返し、呼び出し側はスキップする。
fetch_macro_events_json() {
  if [[ -n "${MACRO_EVENTS_JSON:-}" ]]; then
    printf '%s' "$MACRO_EVENTS_JSON"
    return 0
  fi
  [[ -n "${WORKER_URL:-}" ]] || { return 0; }
  local auth=()
  [[ -n "${SYNC_TOKEN:-}" ]] && auth=(-H "Authorization: Bearer ${SYNC_TOKEN}")
  # ?all=1 で過去含む全件を取り (基準日 TODAY は引数で過去日も渡されうるため)、絞りは下で行う。
  curl -fsS --max-time 20 "${auth[@]}" \
    "${WORKER_URL%/}/latest?kind=macro-events&all=1" 2>/dev/null || return 0
}

# 取得した macro-events を近接 (TODAY 〜 TODAY+DAYS) で絞り、MACRO_NOTE に積む。
# effect_date = jst_effect_date があればそれ、無ければ date。SQ/指数リバランスは計算側で
# 出すのでここには無い (D1 には fomc/boj のみ保存される)。
MACRO_NOTE=""
collect_macro_events() {
  command -v jq >/dev/null 2>&1 || { echo "event-context: jq 不在のためマクロイベントをスキップ" >&2; return 0; }
  local json; json="$(fetch_macro_events_json)"
  [[ -n "$json" ]] || return 0
  local today_epoch; today_epoch="$("$DATE" -d "$TODAY" +%s)"
  local horizon_epoch; horizon_epoch="$("$DATE" -d "$TODAY +$DAYS days" +%s)"

  # rows[] を "effect_date<TAB>label<TAB>impact" の行に展開 (effect_date は coalesce)。
  # 非JSON や rows 欠落は jq が空を返すのでループは回らない。
  local line eff label impact
  while IFS=$'\t' read -r eff label impact; do
    [[ -n "$eff" ]] || continue
    local eff_epoch
    if ! eff_epoch="$("$DATE" -d "$eff" +%s 2>/dev/null)"; then
      echo "event-context: 日付パース失敗 '${eff}' (label=${label:-?}) → このイベントを無視" >&2
      continue
    fi
    if [[ "$eff_epoch" -ge "$today_epoch" && "$eff_epoch" -le "$horizon_epoch" ]]; then
      local days_until=$(( (eff_epoch - today_epoch) / 86400 ))
      local when; if [[ "$days_until" -eq 0 ]]; then when="本日"; else when="${days_until}日後"; fi
      local imp=""; [[ -n "$impact" && "$impact" != "null" ]] && imp="[${impact}]"
      MACRO_NOTE+="${label}(${eff}/${when})${imp}; "
    fi
  done < <(printf '%s' "$json" | jq -r '
    (.rows // [])[]
    | [ (.jst_effect_date // .date), .label, (.impact // "") ]
    | @tsv' 2>/dev/null)
}

# --- 組み立て ----------------------------------------------------------------
# このファイルが `source` されたとき (bats のユニットテスト等) は本体を実行せず、
# 上で定義したヘルパー関数だけを呼び出し側へ提供する。直接実行 (bash ...) のときだけ走る。
# 判定: 実行中スクリプトのパス ($0) と BASH_SOURCE が一致すれば「直接実行」。
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  check_sq "$TODAY"
  check_index_rebalance "$TODAY"
  collect_macro_events

  OUT="${SQ_NOTE}${INDEX_NOTE}${MACRO_NOTE}"
  OUT="$(echo "$OUT" | sed 's/; *$//')"   # 末尾の "; " を除去
  if [[ -z "$OUT" ]]; then
    echo "需給イベント(${TODAY}): 特になし"
  else
    echo "需給イベント(${TODAY}): ${OUT}"
  fi
fi
