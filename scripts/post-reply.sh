#!/usr/bin/env bash
# scripts/post-reply.sh
# Worker /slack/post へのスレッド系投稿 2 種 (crash-scenario の新規ポスト、slack-reply の
# スレッド返信) をまとめる。skill には curl を叩かせない。skill は中身を出力ファイルに書くだけで、
# 投稿はこのスクリプト (= workflow の後続ステップ) が行う:
#   - crash: ticker / name / scenario+総括 blocks をファイルで (ヘッダと配列長 N は script が組む)。
#   - reply: thread-json のパスと返信本文ファイル (channel/thread_ts は script が抜く)。
#
# 使い方:
#   post-reply.sh crash <ticker> <name> <signal-file>
#     $4 = crash-scenario の structured_output JSON ({blocks:[...]}) のパス。blocks = scenario +
#          総括の section 配列。N = 配列長 - 1。
#   post-reply.sh reply <thread-json> <signal-file>
#     $2 = {channel, thread_ts, ...} を持つ JSON ファイルのパス。$3 = slack-reply の
#          structured_output JSON ({reply:"…"}) のパス。
#
# 環境変数: WORKER_URL (必須), SYNC_TOKEN (任意)。
# 出力 (stdout): "slack ok"。投稿が失敗 (Bot 未設定の 503 含む) したら本文を stdout に出して
#   "slack skipped" を返す (分析自体は失わない)。
# テスト用: POST_REPLY_DRYRUN=1 で curl を叩かず payload を stderr に "POST <url> <json>" で出す。

set -euo pipefail

MODE="${1:?usage: post-reply.sh <crash|reply> ...}"
: "${WORKER_URL:?WORKER_URL is required}"

case "$MODE" in
  crash)
    TICKER="${2:?usage: post-reply.sh crash <ticker> <name> <signal-file>}"
    NAME="${3:?name required}"
    SIGNAL_FILE="${4:?signal-file required}"
    [[ -f "$SIGNAL_FILE" ]] || { echo "post-reply.sh: signal-file not found: $SIGNAL_FILE" >&2; exit 1; }
    # skill の structured_output ({blocks:[...]}) を読む。不正 JSON / blocks 不在なら即 fail。
    jq -e '.blocks | type == "array"' "$SIGNAL_FILE" >/dev/null 2>&1 || {
      echo "post-reply.sh: signal-file lacks blocks array: $SIGNAL_FILE" >&2; exit 1; }
    PAYLOAD="$(jq \
      --arg ticker "$TICKER" --arg name "$NAME" \
      '.blocks as $blocks
       | def hdr: "⚠️ \($ticker) \($name) 暴落プリモーテム (\(($blocks|length)-1) scenarios)";
         {ticker:$ticker, kind:"crash-scenario", text:hdr,
          blocks:([{type:"section",text:{type:"mrkdwn",text:hdr}}] + $blocks)}' "$SIGNAL_FILE")"
    ;;
  reply)
    THREAD_JSON="${2:?usage: post-reply.sh reply <thread-json> <signal-file>}"
    SIGNAL_FILE="${3:?signal-file required}"
    [[ -f "$THREAD_JSON" ]] || { echo "post-reply.sh: thread-json not found: $THREAD_JSON" >&2; exit 1; }
    [[ -f "$SIGNAL_FILE" ]] || { echo "post-reply.sh: signal-file not found: $SIGNAL_FILE" >&2; exit 1; }
    # skill の structured_output ({reply:"…"}) を読む。空 reply は投稿しない。
    REPLY_TEXT="$(jq -r '.reply // ""' "$SIGNAL_FILE")"
    [[ -n "$REPLY_TEXT" ]] || { echo "post-reply.sh: empty reply in $SIGNAL_FILE" >&2; exit 1; }
    PAYLOAD="$(jq --arg text "$REPLY_TEXT" \
      '{channel, thread_ts, text:$text}' "$THREAD_JSON")"
    ;;
  *)
    echo "post-reply.sh: unknown mode: $MODE (want crash|reply)" >&2; exit 1;;
esac

AUTH=()
[[ -n "${SYNC_TOKEN:-}" ]] && AUTH=(-H "Authorization: Bearer ${SYNC_TOKEN}")

if [[ "${POST_REPLY_DRYRUN:-}" == "1" ]]; then
  printf 'POST %s %s\n' "${WORKER_URL%/}/slack/post" "$(printf '%s' "$PAYLOAD" | jq -c .)" >&2
  echo "slack skipped (dryrun)"
  exit 0
fi

# 投げて失敗 (Bot 未設定の 503 含む) したら本文を stdout に出して skip。
if curl -sf -X POST "${WORKER_URL%/}/slack/post" \
    "${AUTH[@]}" -H 'Content-Type: application/json' -d "$PAYLOAD" >/dev/null 2>&1; then
  echo "slack ok"
else
  printf '%s\n' "$PAYLOAD" | jq -r '.text // (.blocks | tostring)'
  echo "slack skipped"
fi
