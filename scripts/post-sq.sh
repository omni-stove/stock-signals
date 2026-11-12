#!/usr/bin/env bash
# scripts/post-sq.sh
# sq-brief の SQ週ブリーフを Slack に投稿する。
#
# 設計:
#   - skill 本体に curl を叩かせない。投稿経路 (Worker /slack/post, Bearer 認証, 503=Bot未設定→stdout
#     フォールバック) はこのスクリプトが持つ。
#   - 太字の headline と数値行をサマリーとして親に投稿し、シナリオ・SQ連動度・注視は details として
#     親のスレッドに 1 通でぶら下げる。
#   - 数値行 (SQ日・残り日数 / 日経225・TOPIX・各銘柄の今週リターンと TOPIX比 / NT倍率 / 過去の SQ連動度) は LLM に出させず、
#     sqctx の実在値からここで決定論で組む。
#
# 入力:
#   $1 = signal-file (必須。sq-brief の構造化出力 {headline, scenarios[], sensitivity[], watch[]} の JSON)
#   $2 = sqctx-file  (任意。LLM に渡したのと同じ /sq-context JSON。数値行に使う。未指定/不在ならスキップ)
# 環境変数: WORKER_URL (必須), SYNC_TOKEN (任意)。
#
# 出力 (stdout): "slack ok" または "slack skipped" の 1 行。
# テスト/オフライン用の注入口: POST_SQ_DRYRUN=1 で curl を叩かず、組み立てた JSON
#   ペイロードを stderr に "POST <url> <json>" 形式で出すだけにする。

set -euo pipefail

SIGNAL_FILE="${1:?usage: post-sq.sh <signal-file> [sqctx-file]}"
SQCTX_FILE="${2:-}"

: "${WORKER_URL:?WORKER_URL is required}"
[[ -f "$SIGNAL_FILE" ]] || { echo "post-sq.sh: signal-file not found: $SIGNAL_FILE" >&2; exit 1; }

SIGNAL_JSON="$(cat "$SIGNAL_FILE")"
printf '%s' "$SIGNAL_JSON" | jq -e . >/dev/null 2>&1 || {
  echo "post-sq.sh: signal-file is not valid JSON: $SIGNAL_FILE" >&2; exit 1; }
HEADLINE="$(printf '%s' "$SIGNAL_JSON" | jq -r '.headline // ""')"
[[ -n "$HEADLINE" ]] || { echo "post-sq.sh: empty headline in $SIGNAL_FILE" >&2; exit 1; }

# 本文を emoji 見出しのセクションに組む: 🧭 シナリオ (・名前（確度）: きっかけ + →経路) /
# 🔗 SQ連動度 / 👀 注視。項目が無いセクションは出さない。
SECTIONS_JSON="$(printf '%s' "$SIGNAL_JSON" | jq -c '
  def group($heading): if length == 0 then empty else ([$heading] + .) | join("\n") end;
  [ ([ (.scenarios // [])[] | ["・*\(.name)*（確度 \(.likelihood)）: \(.trigger)", "　→ \(.path)"] ] | flatten | group("🧭 *シナリオ*")),
    ((.sensitivity // []) | map("・" + .) | group("🔗 *SQ連動度*")),
    ((.watch // []) | map("・" + .) | group("👀 *注視*")) ]')"

# --- 数値行 (決定論) ----------------------------------------------------------
# 1 行目 = SQ日・限月・残り日数、日経225 (TOPIX比) と TOPIX の今週リターン、NT倍率 (前週末比)。2 行目以降 = 銘柄ごとの今週リターン (TOPIX比) と
# 過去の SQ連動度 (SQ日の寄りギャップ・SQ週の値幅が平常の何倍か / SQ日の出来高倍率 / 明けの反転率)。
NUMBERS=""
if [[ -n "$SQCTX_FILE" && -s "$SQCTX_FILE" ]] && jq -e . "$SQCTX_FILE" >/dev/null 2>&1; then
  NUMBERS="$(jq -r '
    def signed: "\(if . > 0 then "+" else "" end)\(.)";
    def wtd: if (.status // "") == "ok" and .days > 0
      then "今週 \(.ret_pct | signed)%" + (if .excess_pct != null then "（TOPIX比 \(.excess_pct | signed)%）" else "" end)
      else empty end;
    def sens: if (.status // "") == "ok" then
      (.sensitivity // {}) as $s | (.all.n // 0) as $n
      | [ ($s.sq_gap_abs_x as $v | if $v != null then "寄りギャップ \($v)倍" else empty end),
          ($s.sq_week_abs_x as $v | if $v != null then "週の値幅 \($v)倍" else empty end),
          ($s.sq_vol_x as $v | if $v != null then "出来高 \($v)倍" else empty end),
          ($s.reversal_rate as $v | if $v != null then "明け反転 \($v * 100 | round)%" else empty end) ]
      | if length == 0 then empty else "SQ連動 " + join(" / ") + "（n=\($n)）" end
      else empty end;
    .sq as $sq
    | [ ( [ "SQ \($sq.date)（\($sq.month)月限・\(if $sq.major then "メジャー" else "オプションのみ" end)）"
          + (if $sq.days_to_sq != null then " あと\($sq.days_to_sq)日" else "" end) ]
          + [ .market.nikkei225.week_to_date // {} | wtd | "日経225 " + . ]
          + [ .market.topix.week_to_date // {} | wtd | "TOPIX " + . ]
          + [ .market.nt_ratio // {} | select(.status == "ok")
              | "NT倍率 \(.nt)" + (if .prev_week_end != null then "（前週末 \(.prev_week_end)）" else "" end) ]
        | join(" / ") ),
        ( .tickers[]? | [ (.week_to_date // {} | wtd), (.history // {} | sens) ] as $parts
          | if ($parts | length) == 0 then empty else "\(.code) \(.name): " + ($parts | join(" / ")) end ) ]
    | join("\n")' "$SQCTX_FILE")"
  NUMBERS="${NUMBERS:+📐 *数値*
${NUMBERS}}"
fi

PAYLOAD="$(jq -n \
  --arg headline "$HEADLINE" \
  --arg numbers "$NUMBERS" \
  --argjson sections "$SECTIONS_JSON" \
  'def section: {type:"section", text:{type:"mrkdwn", text:.}};
  def bold: "*" + gsub("\\*"; "") + "*";
  {
    kind: "sq-brief",
    text: $headline,
    blocks: ([$headline | bold | section]
      + (if $numbers == "" then [] else [{type:"context", elements:[{type:"mrkdwn", text:$numbers}]}] end))
  }
  + (if ($sections | length) > 0
     then {details: {text: ($sections | join("\n")), blocks: ($sections | map(section))}}
     else {} end)')"

if [[ "${POST_SQ_DRYRUN:-}" == "1" ]]; then
  printf 'POST %s %s\n' "${WORKER_URL%/}/slack/post" "$(jq -c . <<<"$PAYLOAD")" >&2
  echo "slack skipped"
  exit 0
fi

AUTH=()
[[ -n "${SYNC_TOKEN:-}" ]] && AUTH=(-H "Authorization: Bearer ${SYNC_TOKEN}")

HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "${WORKER_URL%/}/slack/post" \
  "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "$PAYLOAD" 2>/dev/null || echo "000")"

if [[ "$HTTP_CODE" == "200" ]]; then
  echo "slack ok"
else
  printf '%s\n%s\n%s\n' "$HEADLINE" "$NUMBERS" "$(jq -r 'join("\n")' <<<"$SECTIONS_JSON")"
  echo "slack skipped (HTTP ${HTTP_CODE})"
fi
