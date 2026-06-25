#!/usr/bin/env bash
# scripts/post-market.sh
# market-check の地合い判定を Slack に投稿する。
#
# 設計:
#   - skill 本体に curl を叩かせない。投稿経路 (Worker /slack/post, Bearer 認証, kind 付与,
#     503=Bot未設定→stdout フォールバック) は決定論的なのでこのスクリプトが持つ。
#     skill は「ヘッドライン・本文行」を引数で渡すだけ。
#   - 地合いは銘柄非依存なので ticker は固定で "market"。blocks は本文行 (改行区切り) を
#     section に詰めるだけ。
#
# 入力:
#   $1 = body-file  (必須。skill が書いた出力ファイルのパス。1 行目 = headline、
#                    2 行目以降 = Slack 本文。skill は curl を一切叩かず判定結果をこのファイルに
#                    書くだけ。投稿はこのスクリプト = workflow の後続ステップが行う)
# 環境変数: WORKER_URL (必須), SYNC_TOKEN (任意)。
#
# 出力 (stdout): "slack ok" または "slack skipped" の 1 行。skill の stdout 行はこれを使う。
# テスト/オフライン用の注入口: POST_MARKET_DRYRUN=1 で curl を叩かず、組み立てた JSON
#   ペイロードを stderr に "POST <url> <json>" 形式で出すだけにする (bats が blocks を検証できる)。

set -euo pipefail

BODY_FILE="${1:?usage: post-market.sh <body-file>}"

: "${WORKER_URL:?WORKER_URL is required}"
[[ -f "$BODY_FILE" ]] || { echo "post-market.sh: body-file not found: $BODY_FILE" >&2; exit 1; }

# 1 行目 = headline、2 行目以降 = 本文。skill が curl を叩かず書いたファイルをここで読む。
HEADLINE="$(head -n1 "$BODY_FILE")"
BODY="$(tail -n +2 "$BODY_FILE")"
[[ -n "$HEADLINE" ]] || { echo "post-market.sh: empty headline (line 1) in $BODY_FILE" >&2; exit 1; }

# headline + 本文行を section blocks に組み立てる。リテラル "\n" も実改行も
# どちらで渡されても同じになるよう gsub で正規化してから split する。
PAYLOAD="$(jq -n \
  --arg headline "$HEADLINE" \
  --arg body "$BODY" \
  '{
    ticker: "market",
    kind: "market-check",
    text: $headline,
    blocks: ([{type:"section", text:{type:"mrkdwn", text:$headline}}]
      + ([$body | gsub("\\\\n"; "\n") | split("\n")[] | select(length > 0)
          | {type:"section", text:{type:"mrkdwn", text:.}}]))
  }')"

if [[ "${POST_MARKET_DRYRUN:-}" == "1" ]]; then
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
  printf '%s\n%s\n' "$HEADLINE" "$BODY"
  echo "slack skipped (HTTP ${HTTP_CODE})"
fi
