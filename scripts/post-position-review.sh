#!/usr/bin/env bash
# scripts/post-position-review.sh
# position-review の評価結果を対象ユーザーへ DM (Slack) で投稿する。
#
# 設計:
#   - skill 本体に curl を叩かせない。投稿経路 (Worker /slack/post, Bearer 認証, kind 付与,
#     channel=userId で DM 自動オープン, 503=Bot未設定→stdout フォールバック) は決定論的なので
#     このスクリプトが持つ。skill は「ポートフォリオ所見・各建玉のアクション」を構造化出力で返すだけ。
#   - blocks は所見 1 section + 建玉ごと 1 section の素直な整形。装飾はしない。
#
# 入力:
#   $1 = userId       (必須。DM 先の Slack user_id。/slack/post の channel に渡すと DM が開く)
#   $2 = review-file  (必須。position-review skill の構造化出力 (structured_output) を書いた JSON の
#                      パス。{ portfolio, positions:[{ticker,name,action,urgency,reason}] } を持つ)
# 環境変数: WORKER_URL (必須), SYNC_TOKEN (任意)。
#
# 出力 (stdout): "slack ok" または "slack skipped" の 1 行。
# テスト/オフライン用の注入口: POST_REVIEW_DRYRUN=1 で curl を叩かず、組み立てた JSON
#   ペイロードを stderr に "POST <url> <json>" 形式で出すだけにする (bats が blocks を検証できる)。

set -euo pipefail

USER_ID="${1:?usage: post-position-review.sh <userId> <review-file>}"
REVIEW_FILE="${2:?review-file required}"

: "${WORKER_URL:?WORKER_URL is required}"
[[ -f "$REVIEW_FILE" ]] || { echo "post-position-review.sh: review-file not found: $REVIEW_FILE" >&2; exit 1; }

# structured_output JSON を読む。空/不正 JSON は評価不成立として落とす (投稿しない)。
REVIEW_JSON="$(cat "$REVIEW_FILE")"
printf '%s' "$REVIEW_JSON" | jq -e . >/dev/null 2>&1 || {
  echo "post-position-review.sh: review-file is not valid JSON: $REVIEW_FILE" >&2; exit 1; }
REVIEW_JSON="$(printf '%s' "$REVIEW_JSON" | jq -c .)"

# portfolio = ポートフォリオ所見 (1 行)、positions[] = 建玉ごとの評価。portfolio は必須。
PORTFOLIO="$(printf '%s' "$REVIEW_JSON" | jq -r '.portfolio // ""')"
[[ -n "$PORTFOLIO" ]] || { echo "post-position-review.sh: empty portfolio in $REVIEW_FILE" >&2; exit 1; }

# 見出し + ポートフォリオ所見 + 建玉ごと 1 section に組む。建玉行は
# "*<ticker> <name>* [urgency] action — reason" を 1 mrkdwn にする。
PAYLOAD="$(jq -n \
  --arg user "$USER_ID" \
  --arg portfolio "$PORTFOLIO" \
  --argjson review "$REVIEW_JSON" \
  '{
    channel: $user,
    kind: "position-review",
    text: "📋 保有ポジション評価 (引け後)",
    blocks: ([
      {type:"section", text:{type:"mrkdwn", text:"*📋 保有ポジション評価 (引け後)*"}},
      {type:"section", text:{type:"mrkdwn", text:$portfolio}}
    ] + ([$review.positions // []
      | .[]
      | {type:"section", text:{type:"mrkdwn",
          text:("*\(.ticker) \(.name // .ticker)* [\(.urgency // "—")] \(.action // "")"
            + (if (.reason // "") != "" then "\n\(.reason)" else "" end))}}]))
  }')"

AUTH=()
[[ -n "${SYNC_TOKEN:-}" ]] && AUTH=(-H "Authorization: Bearer ${SYNC_TOKEN}")

# テスト/オフライン用の注入口: POST_REVIEW_DRYRUN=1 で curl を叩かず、組み立てた payload を
# stderr に出して "slack skipped" を返す。
if [[ "${POST_REVIEW_DRYRUN:-}" == "1" ]]; then
  printf 'POST %s %s\n' "${WORKER_URL%/}/slack/post" "$(jq -c . <<<"$PAYLOAD")" >&2
  echo "slack skipped"
  exit 0
fi

# /slack/post は SLACK_BOT_TOKEN 未設定なら 503。その場合は投稿せず所見を stdout に出して
# "slack skipped" を返す (評価自体は失わない)。
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
