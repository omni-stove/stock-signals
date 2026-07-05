#!/usr/bin/env bash
# scripts/post-context.sh
# context-builder が再生成した本文を確定させる後処理 2 つを 1 本にまとめる。
#
# 設計:
#   - skill 本体に curl/jq を叩かせない。本文を再生成しファイルに書いた後の
#     決定論的な後処理 (Worker /context へ upsert、context チャンネルへ全文投稿) は
#     このスクリプトが持つ。skill は ticker・本文ファイル・次カーソル 2 つを渡すだけ。
#   - 「保存したら → Slack に区切り投稿する」という決定論的フロー。各経路 (Bearer 認証、
#     空カーソルは null、channel 明示、SLACK_CONTEXT_CHANNEL 空ならスキップ) を 1 か所に閉じ込める。
#   - 整形 (sections → 保存テキスト / Slack blocks) は Worker (lib/context-format.ts) に集約する。
#     skill は Markdown 記号を持たない sections (見出し+行) を返し、このスクリプトは title+sections を
#     /context (保存) と /slack/post (context_sections で blocks 投稿) にそのまま渡すだけ。
#   - signal-judge の発火はここでは行わない。新規 0 (no-update) の日でも判定だけは毎営業日
#     回せるよう、発火は context-builder ワークフローの独立ステップ (scripts/dispatch-judge.sh)
#     に一本化した。post-context.sh は「新規があったときのコンテキスト確定」だけに責務を絞る。
#
# 入力:
#   $1 = ticker          (必須)
#   $2 = signal-file     (必須。context-builder の structured_output JSON のパス。
#                         {status, title, sections, ir_cursor, news_cursor}。status="no-update" なら
#                         本文を書かず即終了する (upsert も投稿もしない)。status="ok" なら title + sections
#                         (見出し+行。Markdown 記号なし) を再生成コンテキスト、ir_cursor/news_cursor を
#                         進めたカーソル (null 可) として使う。skill は curl を叩かず判定するだけで、
#                         upsert と Slack 投稿はこのスクリプト = workflow の後続が行う)
# 環境変数: WORKER_URL (必須), SYNC_TOKEN (任意), SLACK_CONTEXT_CHANNEL (任意),
#           POST_CONTEXT_MAX_LINES / POST_CONTEXT_MAX_CHARS (任意。本文総量の上限。既定 35 行 / 2600 字)。
#
# 出力 (stdout): 各ステップの状態を 1 行ずつ (context posted / slack ok|skipped)。
#   status="no-update" のときは "no update — skip upsert/post" の 1 行だけ。
# テスト/オフライン用の注入口: POST_CONTEXT_DRYRUN=1 で curl を叩かず、組み立てた
#   JSON ペイロードを stderr に "POST <url> <json>" 形式で出すだけにする。
#   curl を差し替えたいときは POST_CONTEXT_CURL も使える。

set -euo pipefail

TICKER="${1:?usage: post-context.sh <ticker> <signal-file>}"
SIGNAL_FILE="${2:?signal-file required}"

: "${WORKER_URL:?WORKER_URL is required}"
[[ -f "$SIGNAL_FILE" ]] || { echo "post-context.sh: signal-file not found: $SIGNAL_FILE" >&2; exit 1; }
jq -e . "$SIGNAL_FILE" >/dev/null 2>&1 || {
  echo "post-context.sh: signal-file is not valid JSON: $SIGNAL_FILE" >&2; exit 1; }

# status="no-update" なら本文を書かず即終了 (新規 0 の日。判定だけは別ステップで回す)。
STATUS="$(jq -r '.status // ""' "$SIGNAL_FILE")"
if [[ "$STATUS" == "no-update" ]]; then
  echo "$TICKER: no update — skip upsert/post"
  exit 0
fi

# status="ok": title + sections を読み、進めたカーソルを読む (null/欠落は空文字 → 後段で null)。
# title (見出しタイトル) と sections (見出し+行の配列) が両方そろっていることを要求する。
TITLE="$(jq -r '.title // ""' "$SIGNAL_FILE")"
[[ -n "$TITLE" ]] || { echo "post-context.sh: empty title in $SIGNAL_FILE" >&2; exit 1; }
jq -e '(.sections | type) == "array" and (.sections | length) > 0' "$SIGNAL_FILE" >/dev/null 2>&1 \
  || { echo "post-context.sh: missing/empty sections in $SIGNAL_FILE" >&2; exit 1; }
SECTIONS="$(jq -c '.sections' "$SIGNAL_FILE")"
IR_CURSOR="$(jq -r '.ir_cursor // ""' "$SIGNAL_FILE")"
NEWS_CURSOR="$(jq -r '.news_cursor // ""' "$SIGNAL_FILE")"

# 本文の総量バックストップ。1 行 100 字・1 セクション 10 行は workflow の --json-schema が縛るが、
# 合計は schema で縛れないのでここで検証する。超過は fail させて膨張した本文を D1 に入れない
# (カーソルも進まないので次回 dispatch で同じ材料から再生成される)。上限は env で差し替え可 (テスト用)。
TOTAL_LINES="$(jq '[.sections[].lines[]] | length' "$SIGNAL_FILE")"
TOTAL_CHARS="$(jq '[.sections[].lines[]] | join("") | length' "$SIGNAL_FILE")"
MAX_LINES="${POST_CONTEXT_MAX_LINES:-35}"
MAX_CHARS="${POST_CONTEXT_MAX_CHARS:-2600}"
if (( TOTAL_LINES > MAX_LINES || TOTAL_CHARS > MAX_CHARS )); then
  echo "post-context.sh: context too large: ${TOTAL_LINES} lines / ${TOTAL_CHARS} chars (max ${MAX_LINES} lines / ${MAX_CHARS} chars)" >&2
  exit 1
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

# --- 1. Worker /context へ upsert (title + sections + 進めたカーソル) ----------
# 空カーソルは null として送る (初回 backlog を引いた後など)。保存テキストは Worker が sections から組む。
"$CURL" -sf -X POST "${WORKER_URL%/}/context" \
  "${AUTH[@]}" \
  --data @<(jq -n --arg code "$TICKER" --arg title "$TITLE" --argjson sections "$SECTIONS" \
    --arg ir "$IR_CURSOR" --arg news "$NEWS_CURSOR" \
    '{code:$code, title:$title, sections:$sections,
      ir_cursor:(if $ir=="" then null else $ir end),
      news_cursor:(if $news=="" then null else $news end)}') >/dev/null
echo "context posted (D1)"

# --- 2. context チャンネルへ区切り投稿 ---------------------------------------
# SLACK_CONTEXT_CHANNEL 未設定ならスキップ (run は失敗させない)。thread_ts / ticker は付けない。
# context_sections を渡し、blocks への整形は Worker (/slack/post) に任せる。
if [[ -n "${SLACK_CONTEXT_CHANNEL:-}" ]]; then
  "$CURL" -sf -X POST "${WORKER_URL%/}/slack/post" \
    "${AUTH[@]}" \
    --data @<(jq -n --arg ch "$SLACK_CONTEXT_CHANNEL" --arg title "$TITLE" --argjson sections "$SECTIONS" \
      '{channel:$ch, context_sections:{title:$title, sections:$sections}}') >/dev/null \
    && echo "slack ok" || echo "slack skipped (post failed)"
else
  echo "slack skipped (no channel)"
fi

# signal-judge の発火はここでは行わない (scripts/dispatch-judge.sh に一本化)。
# 理由はファイル冒頭の設計コメントを参照。
