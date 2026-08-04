#!/usr/bin/env bash
# scripts/post-position-report.sh
# position-report の事実レポートを対象ユーザーへ DM (Slack) で投稿する。
#
# 設計:
#   - skill 本体に curl を叩かせない。投稿経路 (Worker /slack/post, Bearer 認証, kind 付与,
#     channel=userId で DM 自動オープン, 503=Bot未設定→stdout フォールバック) は決定論的なので
#     このスクリプトが持つ。skill は「ポートフォリオの事実 1 行・建玉ごとの材料メモ」を構造化出力で返すだけ。
#   - 建玉の事実行 (口座区分/建玉方向/建値/現値/含み損益) は LLM に出させず、posctx の実在値から
#     ここで決定論で組む。LLM 由来は notes (材料の紐付け) だけ。
#   - blocks は事実 1 section + 建玉ごと 1 section (事実行 + notes) の素直な整形。装飾はしない。
#
# 入力:
#   $1 = userId       (必須。DM 先の Slack user_id。/slack/post の channel に渡すと DM が開く)
#   $2 = report-file  (必須。position-report skill の構造化出力 (structured_output) を書いた JSON の
#                      パス。{ portfolio, positions:[{ticker,notes[]}] } を持つ)
#   $3 = posctx-file  (必須。LLM に渡したのと同じ /position-context JSON のパス。
#                      { positions:[{ticker,name,account,side,avgPrice,price,pnlPct}] } を持つ。
#                      建玉の事実行はここから組む)
# 環境変数: WORKER_URL (必須), SYNC_TOKEN (任意)。
#
# 出力 (stdout): "slack ok" または "slack skipped" の 1 行。
# テスト/オフライン用の注入口: POST_REPORT_DRYRUN=1 で curl を叩かず、組み立てた JSON
#   ペイロードを stderr に "POST <url> <json>" 形式で出すだけにする (bats が blocks を検証できる)。

set -euo pipefail

USER_ID="${1:?usage: post-position-report.sh <userId> <report-file> <posctx-file>}"
REPORT_FILE="${2:?report-file required}"
POSCTX_FILE="${3:?posctx-file required}"

: "${WORKER_URL:?WORKER_URL is required}"
[[ -f "$REPORT_FILE" ]] || { echo "post-position-report.sh: report-file not found: $REPORT_FILE" >&2; exit 1; }
[[ -f "$POSCTX_FILE" ]] || { echo "post-position-report.sh: posctx-file not found: $POSCTX_FILE" >&2; exit 1; }

# structured_output / posctx JSON を読む。空/不正 JSON はレポート不成立として落とす (投稿しない)。
REPORT_JSON="$(cat "$REPORT_FILE")"
printf '%s' "$REPORT_JSON" | jq -e . >/dev/null 2>&1 || {
  echo "post-position-report.sh: report-file is not valid JSON: $REPORT_FILE" >&2; exit 1; }
REPORT_JSON="$(printf '%s' "$REPORT_JSON" | jq -c .)"
POSCTX_JSON="$(cat "$POSCTX_FILE")"
printf '%s' "$POSCTX_JSON" | jq -e . >/dev/null 2>&1 || {
  echo "post-position-report.sh: posctx-file is not valid JSON: $POSCTX_FILE" >&2; exit 1; }
POSCTX_JSON="$(printf '%s' "$POSCTX_JSON" | jq -c .)"

# portfolio = ポートフォリオの事実 (1 行)。必須。
PORTFOLIO="$(printf '%s' "$REPORT_JSON" | jq -r '.portfolio // ""')"
[[ -n "$PORTFOLIO" ]] || { echo "post-position-report.sh: empty portfolio in $REPORT_FILE" >&2; exit 1; }

# 見出し + ポートフォリオ事実 + 建玉ごと 1 section に組む。建玉の事実行は posctx から決定論で
# "*<ticker> <name>* <現物|信用><買建|売建> 建値 <avg> → 現値 <price> (<±pnl%>)" を組み、
# その銘柄の notes (LLM の材料メモ) を "・" 行で下にぶら下げる。同一銘柄で現物/信用の 2 行が
# あるときは notes は最初の行にだけ付ける。
PAYLOAD="$(jq -n \
  --arg user "$USER_ID" \
  --arg portfolio "$PORTFOLIO" \
  --argjson report "$REPORT_JSON" \
  --argjson posctx "$POSCTX_JSON" \
  '
  def acct: if . == "margin" then "信用" else "現物" end;
  def bside: if . == "short" then "売建" else "買建" end;
  def pnl: if . == null then "—" elif . >= 0 then "+\(.)%" else "\(.)%" end;
  ($posctx.positions // []) as $rows |
  (($report.positions // []) | map({key: .ticker, value: (.notes // [])}) | from_entries) as $notes |
  {
    channel: $user,
    kind: "position-report",
    text: "📋 保有ポジション事実レポート (引け後)",
    blocks: ([
      {type:"section", text:{type:"mrkdwn", text:"*📋 保有ポジション事実レポート (引け後)*"}},
      {type:"section", text:{type:"mrkdwn", text:$portfolio}}
    ] + ($rows | to_entries | map(
      .key as $i | .value as $r |
      ("*\($r.ticker) \($r.name // $r.ticker)* \($r.account | acct)\($r.side | bside) 建値 \($r.avgPrice) → 現値 \($r.price // "—") (\($r.pnlPct | pnl))") as $fact |
      # notes はその銘柄の最初の行にだけ付ける (現物/信用の 2 行持ちでも重複させない)。
      (if ($rows[:$i] | map(.ticker) | index($r.ticker)) == null
       then ($notes[$r.ticker] // []) else [] end) as $n |
      {type:"section", text:{type:"mrkdwn",
        text: ($fact + (if ($n | length) > 0 then "\n" + ($n | map("・" + .) | join("\n")) else "" end))}}
    )))
  }')"

AUTH=()
[[ -n "${SYNC_TOKEN:-}" ]] && AUTH=(-H "Authorization: Bearer ${SYNC_TOKEN}")

# テスト/オフライン用の注入口: POST_REPORT_DRYRUN=1 で curl を叩かず、組み立てた payload を
# stderr に出して "slack skipped" を返す。
if [[ "${POST_REPORT_DRYRUN:-}" == "1" ]]; then
  printf 'POST %s %s\n' "${WORKER_URL%/}/slack/post" "$(jq -c . <<<"$PAYLOAD")" >&2
  echo "slack skipped"
  exit 0
fi

# /slack/post は SLACK_BOT_TOKEN 未設定なら 503。その場合は投稿せず事実行を stdout に出して
# "slack skipped" を返す (レポート自体は失わない)。
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "${WORKER_URL%/}/slack/post" \
  "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "$PAYLOAD" 2>/dev/null || echo "000")"

if [[ "$HTTP_CODE" == "200" ]]; then
  echo "slack ok"
else
  printf '%s\n' "$PORTFOLIO"
  echo "slack skipped (HTTP ${HTTP_CODE})"
fi
