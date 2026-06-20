#!/usr/bin/env bash
# scripts/post-signal.sh
# signal-judge の判定結果を Slack に投稿する。
#
# 設計 (event-context.sh / judge-context.sh と同じ思想):
#   - skill 本体に curl を叩かせない。投稿経路 (Worker /slack/post, Bearer 認証, kind 付与,
#     channel 省略, 503=Bot未設定→stdout フォールバック) は決定論的なのでこのスクリプトが持つ。
#     skill は「方向・水準・本文行」を引数で渡すだけ。
#   - blocks は本文行 (改行区切り) を section に詰めるだけの素直な整形。装飾はしない。
#
# 入力:
#   $1 = ticker          (必須)
#   $2 = headline        (必須。例 "🧭 285A キオクシア signal: buy・押し目")
#   $3 = body            (必須。Slack 本文。改行で複数行可)
# 環境変数: WORKER_URL (必須), SYNC_TOKEN (任意)。
#
# 出力 (stdout): "slack ok" または "slack skipped" の 1 行。skill の stdout 行はこれを使う。
# テスト/オフライン用の注入口: POST_SIGNAL_DRYRUN=1 で curl を叩かず、組み立てた JSON
#   ペイロードを stderr に "POST <url> <json>" 形式で出すだけにする (bats が blocks を検証できる)。

set -euo pipefail

TICKER="${1:?usage: post-signal.sh <ticker> <headline> <body>}"
HEADLINE="${2:?headline required}"
BODY="${3:?body required}"

: "${WORKER_URL:?WORKER_URL is required}"

# headline + 本文行を section blocks に組み立てる。本文は改行区切りで 1 行 1 section。
# skill がリテラル "\n" (バックスラッシュ+n) を渡してくることがあるので、split の前に
# gsub で本物の改行へ正規化する。実改行・リテラル \n のどちらで渡されても同じ結果になる。
PAYLOAD="$(jq -n \
  --arg ticker "$TICKER" \
  --arg headline "$HEADLINE" \
  --arg body "$BODY" \
  '{
    ticker: $ticker,
    kind: "signal-judge",
    text: $headline,
    blocks: ([{type:"section", text:{type:"mrkdwn", text:$headline}}]
      + ([$body | gsub("\\\\n"; "\n") | split("\n")[] | select(length > 0)
          | {type:"section", text:{type:"mrkdwn", text:.}}]))
  }')"

# テスト/オフライン用の注入口: POST_SIGNAL_DRYRUN=1 で curl を叩かず、組み立てた payload を
# stderr に出して "slack skipped" を返す。本物の呼び出しでは curl を使う。
if [[ "${POST_SIGNAL_DRYRUN:-}" == "1" ]]; then
  printf 'POST %s %s\n' "${WORKER_URL%/}/slack/post" "$(jq -c . <<<"$PAYLOAD")" >&2
  echo "slack skipped"
  exit 0
fi

AUTH=()
[[ -n "${SYNC_TOKEN:-}" ]] && AUTH=(-H "Authorization: Bearer ${SYNC_TOKEN}")

# /slack/post は SLACK_BOT_TOKEN 未設定なら 503 (スレッド機能オフ)。その場合は投稿せず
# headline+本文を stdout に出して "slack skipped" を返す (判定自体は失わない)。
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "${WORKER_URL%/}/slack/post" \
  "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "$PAYLOAD" 2>/dev/null || echo "000")"

if [[ "$HTTP_CODE" == "200" ]]; then
  echo "slack ok"
else
  printf '%s\n%s\n' "$HEADLINE" "$BODY"
  echo "slack skipped (HTTP ${HTTP_CODE})"
fi
