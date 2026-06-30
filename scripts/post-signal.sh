#!/usr/bin/env bash
# scripts/post-signal.sh
# signal-judge の判定結果を Slack に投稿する。
#
# 設計:
#   - skill 本体に curl を叩かせない。投稿経路 (Worker /slack/post, Bearer 認証, kind 付与,
#     channel 省略, 503=Bot未設定→stdout フォールバック) は決定論的なのでこのスクリプトが持つ。
#     skill は「方向・水準・本文行」を引数で渡すだけ。
#   - blocks は本文行 (改行区切り) を section に詰めるだけの素直な整形。装飾はしない。
#   - 強制決済スコア (追証売り/踏み上げ) は eod cron が D1 に算出済み。判定 (judge=LLM) には
#     一切渡さない (daily 指標から自前で読めるので判断材料としては冗長)。代わりにここで D1 から
#     最新行を引き、stance!=none のときだけ「観測事実」として本文末尾に 1 行貼る。judge の方向判断
#     とは独立した強制フローの観測を、投稿にだけ相乗りさせる。fetch 失敗/該当なしは何も足さない。
#
# 入力:
#   $1 = ticker          (必須)
#   $2 = signal-file     (必須。signal-judge スキルの構造化出力 (structured_output) を書いた JSON の
#                         パス。{side, line, stop, rr, headline, body[]} を持つ。skill は curl を一切
#                         叩かず判定するだけ。投稿/保存はこのスクリプト = workflow の後続ステップが行う。
#                         headline+body を Slack blocks に組み、判定 (side/line/stop/rr) は /slack/post に
#                         signal フィールドとして渡して signals テーブルに保存させる)
#   $3 = rebalance-file  (任意。前段ステップが /index-rebalance を並行取得して書いた JSON のパス。
#                         judge には渡さない観測事実なので numctx とは別ファイルで運ぶ。
#                         未指定/不在/空/窓外 (note 空) なら何も貼らない)
# 環境変数: WORKER_URL (必須), SYNC_TOKEN (任意)。
#
# 出力 (stdout): "slack ok" または "slack skipped" の 1 行。skill の stdout 行はこれを使う。
# テスト/オフライン用の注入口: POST_SIGNAL_DRYRUN=1 で curl を叩かず、組み立てた JSON
#   ペイロードを stderr に "POST <url> <json>" 形式で出すだけにする (bats が blocks を検証できる)。
#   FETCH_FORCED_JSON があれば /latest?kind=forced の curl を叩かずそれを使う (bats 用)。
#   FETCH_REBALANCE_JSON があれば rebalance-file を読まずそれを使う (bats 用)。

set -euo pipefail

TICKER="${1:?usage: post-signal.sh <ticker> <signal-file> [rebalance-file]}"
SIGNAL_FILE="${2:?signal-file required}"
REBAL_FILE="${3:-}"

: "${WORKER_URL:?WORKER_URL is required}"
[[ -f "$SIGNAL_FILE" ]] || { echo "post-signal.sh: signal-file not found: $SIGNAL_FILE" >&2; exit 1; }

# structured_output JSON を読む。空/不正 JSON は判定不成立として落とす (投稿も保存もしない)。
SIGNAL_JSON="$(cat "$SIGNAL_FILE")"
printf '%s' "$SIGNAL_JSON" | jq -e . >/dev/null 2>&1 || {
  echo "post-signal.sh: signal-file is not valid JSON: $SIGNAL_FILE" >&2; exit 1; }
SIGNAL_JSON="$(printf '%s' "$SIGNAL_JSON" | jq -c .)"

# headline = Slack 1 行目、body[] = 本文行。headline は必須。
HEADLINE="$(printf '%s' "$SIGNAL_JSON" | jq -r '.headline // ""')"
[[ -n "$HEADLINE" ]] || { echo "post-signal.sh: empty headline in $SIGNAL_FILE" >&2; exit 1; }
# body 配列を改行区切りの 1 文字列にする (後段で観測行を末尾に足し、split で blocks に戻す)。
BODY="$(printf '%s' "$SIGNAL_JSON" | jq -r '(.body // []) | join("\n")')"

# --- 強制決済スコアの観測行を D1 から引く (judge には渡さない。投稿末尾に貼るだけ) -----
# stance!=none の最新行があれば summary を取り出す。fetch 失敗・行なし・stance==none は空文字。
# AUTH 配列は SYNC_TOKEN があるときだけ要素を持つ。空配列を "${A[@]}" 展開すると set -u で落ち、
# "${A[@]:-}" だと空文字引数を curl に渡して blank-argument エラーになる。よって非空のときだけ展開する。
AUTH=()
[[ -n "${SYNC_TOKEN:-}" ]] && AUTH=(-H "Authorization: Bearer ${SYNC_TOKEN}")
if [[ -n "${FETCH_FORCED_JSON:-}" ]]; then
  FORCED_RAW="$FETCH_FORCED_JSON"
elif [[ ${#AUTH[@]} -gt 0 ]]; then
  FORCED_RAW="$(curl -sf "${AUTH[@]}" "${WORKER_URL%/}/latest?kind=forced&code=$TICKER&n=1" 2>/dev/null || true)"
else
  FORCED_RAW="$(curl -sf "${WORKER_URL%/}/latest?kind=forced&code=$TICKER&n=1" 2>/dev/null || true)"
fi
FORCED_LINE=""
if printf '%s' "$FORCED_RAW" | jq -e . >/dev/null 2>&1; then
  FORCED_LINE="$(printf '%s' "$FORCED_RAW" | jq -r '
    (.rows[0] // {}) as $r |
    if ($r.stance // "none") != "none" then ($r.summary // "") else "" end')"
fi
# body 末尾に観測行を足す (空なら何もしない)。judge 本文と視覚的に分けるため接頭辞を付ける。
if [[ -n "$FORCED_LINE" ]]; then
  BODY="${BODY}
🧱 強制フロー観測: ${FORCED_LINE}"
fi

# --- 指数リバランス窓の観測行 (judge には渡さない。投稿末尾に貼るだけ) ----------
# リバランスは「その日の値動きと無関係に引けへパッシブ売買が集中する」時間アノマリー。forced と同じく
# 方向判断 (judge=LLM) には効かないので渡さず、窓に入っていれば観測事実として本文末尾に貼る。
# 日付計算は Worker /index-rebalance (event-context.ts) が JST 今日で行う。取得はこのスクリプトでは
# なく前段ステップが judge-context と並行に済ませ、その JSON を rebalance-file 経由で受け取る。
# ここで curl は叩かない (numctx と保存場所を分けて judge に混ざらないようにするため)。
if [[ -n "${FETCH_REBALANCE_JSON:-}" ]]; then
  REBAL_RAW="$FETCH_REBALANCE_JSON"
elif [[ -n "$REBAL_FILE" && -s "$REBAL_FILE" ]]; then
  REBAL_RAW="$(cat "$REBAL_FILE")"
else
  REBAL_RAW=""
fi
REBAL_LINE=""
if printf '%s' "$REBAL_RAW" | jq -e . >/dev/null 2>&1; then
  REBAL_LINE="$(printf '%s' "$REBAL_RAW" | jq -r '.note // ""')"
fi
if [[ -n "$REBAL_LINE" ]]; then
  BODY="${BODY}
📅 リバランス窓: ${REBAL_LINE}"
fi

# headline + 本文行を section blocks に組み立てる。本文は改行区切りで 1 行 1 section。
# body は配列を改行で繋いだ後に観測行 (forced/rebalance) を足したものなので、split の前に
# gsub でリテラル "\n" を本物の改行へ正規化する (どちらで来ても同じ結果になる)。
# signal は skill の構造化判定 (side/line/stop/rr 同梱) をそのまま渡す。Worker /slack/post が
# signals テーブルに upsert する。
PAYLOAD="$(jq -n \
  --arg ticker "$TICKER" \
  --arg headline "$HEADLINE" \
  --arg body "$BODY" \
  --argjson signal "$SIGNAL_JSON" \
  '{
    ticker: $ticker,
    kind: "signal-judge",
    text: $headline,
    signal: $signal,
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
