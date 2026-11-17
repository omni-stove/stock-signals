#!/usr/bin/env bash
# scripts/notify-failure.sh
# 失敗した GitHub Actions の run を Slack (SLACK_WEBHOOK_URL) に 1 行で警告する。
# 呼び出し元は .github/workflows/workflow-failure.yml (workflow_run で失敗した run を受ける)。
#
# 入力:
#   $1 = workflow 名 (必須。例 ticker-brief)
#   $2 = run の表示タイトル (任意。run-name。例 "ticker-brief 6857"。push 起動ならコミットメッセージ)
#   $3 = run の URL (必須)
#   $4 = 失敗ステップ (任意。"job / step" を改行区切り)
# 環境変数: SLACK_WEBHOOK_URL (未設定なら投稿せず "slack skipped")。
#
# 出力 (stdout): "slack ok" または "slack skipped" の 1 行。
# テスト/オフライン用の注入口: NOTIFY_FAILURE_DRYRUN=1 で curl を叩かず、組み立てた JSON
#   ペイロードを stderr に "POST <json>" 形式で出すだけにする。

set -euo pipefail

NAME="${1:?usage: notify-failure.sh <workflow-name> <run-title> <run-url> [failed-steps]}"
TITLE="${2:-}"
URL="${3:?usage: notify-failure.sh <workflow-name> <run-title> <run-url> [failed-steps]}"
STEPS="${4:-}"

# 対象: run-name が workflow 名で始まればそれ (銘柄コード付き)、違えば workflow 名 + タイトル 1 行目 (60 字まで)。
TITLE="$(printf '%s' "$TITLE" | head -n 1)"
if [[ -z "$TITLE" || "$TITLE" == "$NAME" ]]; then
  TARGET="$NAME"
elif [[ "$TITLE" == "$NAME "* ]]; then
  TARGET="$TITLE"
else
  TARGET="$NAME ($(printf '%s' "$TITLE" | cut -c1-60))"
fi

TEXT="⚠️ Actions 失敗: *${TARGET}* — <${URL}|ログ>"
if [[ -n "$STEPS" ]]; then
  TEXT+=$'\n'"$(printf '%s\n' "$STEPS" | sed '/^$/d; s/^/・/')"
fi

PAYLOAD="$(jq -cn --arg text "$TEXT" '{text: $text}')"

if [[ "${NOTIFY_FAILURE_DRYRUN:-}" == "1" ]]; then
  echo "POST $PAYLOAD" >&2
  echo "slack ok"
  exit 0
fi

if [[ -z "${SLACK_WEBHOOK_URL:-}" ]]; then
  echo "slack skipped"
  exit 0
fi

curl -fsS -X POST -H "Content-Type: application/json" --data "$PAYLOAD" "$SLACK_WEBHOOK_URL" >/dev/null
echo "slack ok"
