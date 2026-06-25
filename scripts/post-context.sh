#!/usr/bin/env bash
# scripts/post-context.sh
# context-builder が再生成した本文を確定させる後処理 2 つを 1 本にまとめる。
#
# 設計:
#   - skill 本体に curl/jq を叩かせない。本文を再生成しファイルに書いた後の
#     決定論的な後処理 (Worker /context へ upsert、context チャンネルへ全文投稿) は
#     このスクリプトが持つ。skill は ticker・本文ファイル・次カーソル 2 つを渡すだけ。
#   - 「保存したら → Slack に全文を流す」という決定論的フロー。各経路 (Bearer 認証、
#     空カーソルは null、channel 明示、SLACK_CONTEXT_CHANNEL 空ならスキップ) を 1 か所に閉じ込める。
#   - signal-judge の発火はここでは行わない。新規 0 (no-update) の日でも判定だけは毎営業日
#     回せるよう、発火は context-builder ワークフローの独立ステップ (scripts/dispatch-judge.sh)
#     に一本化した。post-context.sh は「新規があったときのコンテキスト確定」だけに責務を絞る。
#
# 入力:
#   $1 = ticker          (必須)
#   $2 = body-file       (必須。再生成済み本文のパス。例 /tmp/285A-context.md)
#   $3 = cursor-file     (任意。skill が書いた進めたカーソルのファイル。1 行目 = ir-cursor-next、
#                         2 行目 = news-cursor-next。各行が空 (または file 自体が無い) なら
#                         そのカーソルは null として送る。skill は curl を叩かず本文とこのファイルを
#                         書くだけで、upsert と Slack 投稿はこのスクリプト = workflow の後続ステップが行う)
# 環境変数: WORKER_URL (必須), SYNC_TOKEN (任意), SLACK_CONTEXT_CHANNEL (任意)。
#
# 出力 (stdout): 各ステップの状態を 1 行ずつ (context posted / slack ok|skipped)。
# テスト/オフライン用の注入口: POST_CONTEXT_DRYRUN=1 で curl を叩かず、組み立てた
#   JSON ペイロードを stderr に "POST <url> <json>" 形式で出すだけにする。
#   curl を差し替えたいときは POST_CONTEXT_CURL も使える。

set -euo pipefail

TICKER="${1:?usage: post-context.sh <ticker> <body-file> <cursor-file>}"
BODY_FILE="${2:?body-file required}"
CURSOR_FILE="${3:-}"

: "${WORKER_URL:?WORKER_URL is required}"
[[ -f "$BODY_FILE" ]] || { echo "post-context.sh: body-file not found: $BODY_FILE" >&2; exit 1; }

# 進めたカーソルを skill が書いたファイルから読む。1 行目 = ir-next、2 行目 = news-next。
# ファイルが無い・行が空ならそのカーソルは空文字 (後段で null に変換) のまま。
IR_CURSOR=""
NEWS_CURSOR=""
if [[ -n "$CURSOR_FILE" && -f "$CURSOR_FILE" ]]; then
  IR_CURSOR="$(sed -n '1p' "$CURSOR_FILE")"
  NEWS_CURSOR="$(sed -n '2p' "$CURSOR_FILE")"
fi

# SYNC_TOKEN があれば Bearer ヘッダを足す。無ければ Content-Type だけ。
# (空配列 "${AUTH[@]}" は bash 3.2 + set -u で unbound になるため、必ず 1 要素以上持たせる。)
AUTH=(-H 'Content-Type: application/json')
[[ -n "${SYNC_TOKEN:-}" ]] && AUTH=(-H "Authorization: Bearer ${SYNC_TOKEN}" "${AUTH[@]}")

# curl はテストから差し替えられるよう変数化する (注入口)。
# POST_CONTEXT_DRYRUN=1 のとき: curl を叩かず、組み立てた JSON ペイロードを stderr に
# 出すだけにする (bats がペイロードを検証できる)。本物の呼び出しでは実コマンドを使う。
CURL="${POST_CONTEXT_CURL:-curl}"
if [[ "${POST_CONTEXT_DRYRUN:-}" == "1" ]]; then
  CURL="dryrun_curl"
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

# signal-judge の発火はここでは行わない (scripts/dispatch-judge.sh に一本化)。
# 理由はファイル冒頭の設計コメントを参照。
