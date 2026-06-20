#!/usr/bin/env bash
# scripts/post-reply.sh
# Worker /slack/post へのスレッド系投稿 2 種 (crash-scenario の新規ポスト、slack-reply の
# スレッド返信) をまとめる。post-signal.sh / post-context.sh と同じ思想で skill に curl を
# 叩かせない。skill が渡すのは LLM が生んだ中身だけ:
#   - crash: ticker / name / scenario+総括 blocks (ヘッダと配列長 N は script が組む)。
#   - reply: thread-json のパスと返信本文 (channel/thread_ts は script が抜く)。
#
# 使い方:
#   post-reply.sh crash <ticker> <name> <blocks-json>
#     $4 = scenario ブロック + 総括ブロックの JSON 配列。N = 配列長 - 1。
#   post-reply.sh reply <thread-json> <text>
#     $2 = {channel, thread_ts, ...} を持つ JSON ファイルのパス。$3 = 返信本文。
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
    TICKER="${2:?usage: post-reply.sh crash <ticker> <name> <blocks-json>}"
    NAME="${3:?name required}"
    BLOCKS="${4:?blocks-json required}"
    PAYLOAD="$(jq -n \
      --arg ticker "$TICKER" --arg name "$NAME" --argjson blocks "$BLOCKS" \
      'def hdr: "⚠️ \($ticker) \($name) 暴落プリモーテム (\(($blocks|length)-1) scenarios)";
       {ticker:$ticker, kind:"crash-scenario", text:hdr,
        blocks:([{type:"section",text:{type:"mrkdwn",text:hdr}}] + $blocks)}')"
    ;;
  reply)
    THREAD_JSON="${2:?usage: post-reply.sh reply <thread-json> <text>}"
    TEXT="${3:?text required}"
    [[ -f "$THREAD_JSON" ]] || { echo "post-reply.sh: thread-json not found: $THREAD_JSON" >&2; exit 1; }
    PAYLOAD="$(jq --arg text "$TEXT" \
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
