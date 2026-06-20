#!/usr/bin/env bash
# scripts/post-context.sh
# context-builder が再生成した本文を確定させる後処理 3 つを 1 本にまとめる。
#
# 設計 (post-signal.sh / context-input.sh と同じ思想):
#   - skill 本体に curl/gh/jq を叩かせない。本文を再生成しファイルに書いた後の
#     決定論的な後処理 (Worker /context へ upsert、context チャンネルへ全文投稿、
#     signal-judge を repository_dispatch で発火) はこのスクリプトが持つ。
#     skill は ticker・本文ファイル・次カーソル 2 つを引数で渡すだけ。
#   - 3 つは「保存したら → Slack に流して → signal-judge を発火」という一連の
#     決定論的フロー。順序と各経路 (Bearer 認証、空カーソルは null、channel 明示、
#     SLACK_CONTEXT_CHANNEL 空ならスキップ) を 1 か所に閉じ込める。
#
# 入力:
#   $1 = ticker          (必須)
#   $2 = body-file       (必須。再生成済み本文のパス。例 /tmp/285A-context.md)
#   $3 = ir-cursor-next  (任意。空文字なら null として送る)
#   $4 = news-cursor-next(任意。空文字なら null として送る)
# 環境変数: WORKER_URL (必須), SYNC_TOKEN (任意), SLACK_CONTEXT_CHANNEL (任意),
#           GITHUB_REPOSITORY (signal-judge 発火に必要。未設定なら dispatch スキップ)。
#
# 出力 (stdout): 各ステップの状態を 1 行ずつ (context posted / slack ok|skipped /
#   signal-judge dispatched|skipped)。
# テスト/オフライン用の注入口: POST_CONTEXT_DRYRUN=1 で curl/gh を叩かず、組み立てた
#   JSON ペイロードを stderr に "POST <url> <json>" / "GH <args>" 形式で出すだけにする。
#   curl/gh 単体を差し替えたいときは POST_CONTEXT_CURL / POST_CONTEXT_GH も使える。

set -euo pipefail

TICKER="${1:?usage: post-context.sh <ticker> <body-file> <ir-cursor-next> <news-cursor-next>}"
BODY_FILE="${2:?body-file required}"
IR_CURSOR="${3:-}"
NEWS_CURSOR="${4:-}"

: "${WORKER_URL:?WORKER_URL is required}"
[[ -f "$BODY_FILE" ]] || { echo "post-context.sh: body-file not found: $BODY_FILE" >&2; exit 1; }

# SYNC_TOKEN があれば Bearer ヘッダを足す。無ければ Content-Type だけ。
# (空配列 "${AUTH[@]}" は bash 3.2 + set -u で unbound になるため、必ず 1 要素以上持たせる。)
AUTH=(-H 'Content-Type: application/json')
[[ -n "${SYNC_TOKEN:-}" ]] && AUTH=(-H "Authorization: Bearer ${SYNC_TOKEN}" "${AUTH[@]}")

# curl / gh はテストから差し替えられるよう変数化する (注入口)。
# POST_CONTEXT_DRYRUN=1 のとき: curl/gh を叩かず、組み立てた JSON ペイロードを stderr に
# 出すだけにする (bats がペイロードを検証できる)。本物の呼び出しでは実コマンドを使う。
CURL="${POST_CONTEXT_CURL:-curl}"
GH="${POST_CONTEXT_GH:-gh}"
if [[ "${POST_CONTEXT_DRYRUN:-}" == "1" ]]; then
  CURL="dryrun_curl"
  GH="dryrun_gh"
fi
# data @<(...) で渡る JSON を取り出して "POST <url> <payload>" 形式で stderr に出す。
dryrun_curl() {
  local url="" data_file=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --data) data_file="${2#@}"; shift 2;;   # curl の @file 記法。@ を剥がして読む
      http*|"${WORKER_URL%/}"/*) url="$1"; shift;;
      *) shift;;
    esac
  done
  # payload は 1 行に潰して出す (bats が 1 行で grep/jq できるように)。
  printf 'POST %s %s\n' "$url" "$(jq -c . "$data_file")" >&2
}
dryrun_gh() { printf 'GH %s\n' "$*" >&2; }

# --- 1. Worker /context へ upsert (本文 + 進めたカーソル) ----------------------
# 空カーソルは null として送る (初回 backlog を引いた後など)。
"$CURL" -sf -X POST "${WORKER_URL%/}/context" \
  "${AUTH[@]}" \
  --data @<(jq -n --arg code "$TICKER" --rawfile body "$BODY_FILE" \
    --arg ir "$IR_CURSOR" --arg news "$NEWS_CURSOR" \
    '{code:$code, body:$body,
      ir_cursor:(if $ir=="" then null else $ir end),
      news_cursor:(if $news=="" then null else $news end)}') >/dev/null
echo "context posted (D1)"

# --- 2. context チャンネルへ全文投稿 -----------------------------------------
# SLACK_CONTEXT_CHANNEL 未設定ならスキップ (run は失敗させない)。thread_ts / ticker は付けない。
if [[ -n "${SLACK_CONTEXT_CHANNEL:-}" ]]; then
  "$CURL" -sf -X POST "${WORKER_URL%/}/slack/post" \
    "${AUTH[@]}" \
    --data @<(jq -n --arg ch "$SLACK_CONTEXT_CHANNEL" --rawfile text "$BODY_FILE" \
      '{channel:$ch, text:$text}') >/dev/null \
    && echo "slack ok" || echo "slack skipped (post failed)"
else
  echo "slack skipped (no channel)"
fi

# --- 3. signal-judge を発火 --------------------------------------------------
# repository_dispatch。GITHUB_REPOSITORY 未設定 (ローカル等) なら発火しない。
if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
  "$GH" api "repos/${GITHUB_REPOSITORY}/dispatches" \
    -f event_type=signal-judge \
    -F "client_payload[ticker]=${TICKER}" \
    && echo "signal-judge dispatched" || echo "signal-judge dispatch failed"
else
  echo "signal-judge skipped (no GITHUB_REPOSITORY)"
fi
