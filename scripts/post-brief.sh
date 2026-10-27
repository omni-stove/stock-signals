#!/usr/bin/env bash
# scripts/post-brief.sh
# ticker-brief の材料ブリーフを Slack に投稿し、briefs テーブルに保存させる。
#
# 設計:
#   - skill 本体に curl を叩かせない。投稿経路 (Worker /slack/post, Bearer 認証, kind 付与,
#     channel 省略, 503=Bot未設定→stdout フォールバック) は決定論的なのでこのスクリプトが持つ。
#     skill は「材料・分析・強気/弱気」を構造化出力で渡すだけ。
#   - 注目水準 (現値/MA5/MA25/20日レンジ/ATR) とテクニカル指標 (MA25乖離/RSI/レンジ位置/出来高倍率/
#     ATR平常比/OBV/CMF) は LLM に出させず、numctx の実在値からここで決定論で 1 行ずつ組んで本文末尾に
#     貼る。LLM が水準・指標の数値を創作する余地を残さない (LLM はテクニカルの読みだけを返す)。
#   - 強制決済スコア (追証売り/踏み上げ) は eod cron が D1 に算出済み。ここで D1 から最新行を引き、
#     stance!=none のときだけ「観測事実」として本文末尾に 1 行貼る。fetch 失敗/該当なしは何も足さない。
#
# 入力:
#   $1 = ticker          (必須)
#   $2 = brief-file      (必須。ticker-brief スキルの構造化出力 (structured_output) を書いた JSON の
#                         パス。{status, headline, materials[], technical[], bull[], bear[], watch[]} を持つ。
#                         status=no_update なら投稿も保存もせず正常終了する)
#   $3 = rebalance-file  (任意。前段ステップが /index-rebalance を並行取得して書いた JSON のパス。
#                         LLM には渡さない観測事実なので numctx とは別ファイルで運ぶ。
#                         未指定/不在/空/窓外 (note 空) なら何も貼らない)
#   $4 = numctx-file     (任意。LLM に渡したのと同じ /judge-context JSON のパス。注目水準行・
#                         テクニカル指標行に使う。未指定/不在ならどちらもスキップ)
# 環境変数: WORKER_URL (必須), SYNC_TOKEN (任意)。
#
# 出力 (stdout): "slack ok" / "slack skipped" / "no update — skip" の 1 行。
# テスト/オフライン用の注入口: POST_BRIEF_DRYRUN=1 で curl を叩かず、組み立てた JSON
#   ペイロードを stderr に "POST <url> <json>" 形式で出すだけにする (bats が blocks を検証できる)。
#   FETCH_FORCED_JSON があれば /latest?kind=forced の curl を叩かずそれを使う (bats 用)。
#   FETCH_REBALANCE_JSON があれば rebalance-file を読まずそれを使う (bats 用)。

set -euo pipefail

TICKER="${1:?usage: post-brief.sh <ticker> <brief-file> [rebalance-file] [numctx-file]}"
BRIEF_FILE="${2:?brief-file required}"
REBAL_FILE="${3:-}"
NUMCTX_FILE="${4:-}"

: "${WORKER_URL:?WORKER_URL is required}"
[[ -f "$BRIEF_FILE" ]] || { echo "post-brief.sh: brief-file not found: $BRIEF_FILE" >&2; exit 1; }

# structured_output JSON を読む。空/不正 JSON はブリーフ不成立として落とす (投稿も保存もしない)。
BRIEF_JSON="$(cat "$BRIEF_FILE")"
printf '%s' "$BRIEF_JSON" | jq -e . >/dev/null 2>&1 || {
  echo "post-brief.sh: brief-file is not valid JSON: $BRIEF_FILE" >&2; exit 1; }
BRIEF_JSON="$(printf '%s' "$BRIEF_JSON" | jq -c .)"

# status=no_update は「新着も特筆事項も無し」の正常出口。投稿も保存もしない。
STATUS="$(printf '%s' "$BRIEF_JSON" | jq -r '.status // "brief"')"
if [[ "$STATUS" == "no_update" ]]; then
  echo "no update — skip"
  exit 0
fi

# headline = Slack 1 行目。brief のとき必須。
HEADLINE="$(printf '%s' "$BRIEF_JSON" | jq -r '.headline // ""')"
[[ -n "$HEADLINE" && "$HEADLINE" != "null" ]] || {
  echo "post-brief.sh: empty headline in $BRIEF_FILE" >&2; exit 1; }

# 本文行を組む: 材料 (🆕 タイトル + ・分析行) → テクニカルの読み (📈) → 強気 (🐂) → 弱気 (🐻) → 注視点 (👀)。
# 1 行 1 section に split するので、ここでは改行区切りの 1 文字列にする。
BODY="$(printf '%s' "$BRIEF_JSON" | jq -r '
  ([ (.materials // [])[] | (["🆕 " + .title] + ((.analysis // []) | map("・" + .))) ] | flatten)
  + ((.technical // []) | map("📈 " + .))
  + ((.bull // []) | map("🐂 " + .))
  + ((.bear // []) | map("🐻 " + .))
  + ((.watch // []) | map("👀 " + .))
  | join("\n")')"
[[ -n "$BODY" ]] || { echo "post-brief.sh: empty body in $BRIEF_FILE" >&2; exit 1; }

# briefs テーブルに保存する本文 = LLM 由来の内容のみ (観測行・注目水準・指標はここから導出可能なので
# 含めない)。position-report が建玉銘柄の最新材料としてこれを読む。
BRIEF_BODY="$BODY"

# --- 注目水準・テクニカル指標 (決定論): numctx の実在値から組んで本文末尾に貼る ----
# 現値 (prices.latest.price、closed なら daily.close) / MA5 / MA25 / 20日レンジ / ATR% のうち
# 値があるものだけを " / " 連結。全部 null なら行ごとスキップ。
if [[ -n "$NUMCTX_FILE" && -s "$NUMCTX_FILE" ]] && jq -e . "$NUMCTX_FILE" >/dev/null 2>&1; then
  LEVEL_LINE="$(jq -r '
    [ ((.prices.latest.price // .daily.close) as $v | if $v != null then "現値 \($v)" else empty end),
      (.daily.ma5  as $v | if $v != null then "MA5 \($v)" else empty end),
      (.daily.ma25 as $v | if $v != null then "MA25 \($v)" else empty end),
      (if (.daily.range_low_20d != null and .daily.range_high_20d != null)
       then "20日レンジ \(.daily.range_low_20d)〜\(.daily.range_high_20d)" else empty end),
      (.daily.atr_pct as $v | if $v != null then "ATR \($v)%" else empty end) ]
    | if length == 0 then "" else "📏 注目水準: " + join(" / ") end' "$NUMCTX_FILE")"
  if [[ -n "$LEVEL_LINE" ]]; then
    BODY="${BODY}
${LEVEL_LINE}"
  fi

  # テクニカル指標 (決定論): daily の最新確定足の指標を 1 行。値があるものだけを " / " 連結。
  # daily が insufficient/stale、または値が 1 つも無ければ行ごとスキップ。出来高はザラ場中なら
  # 当日ペース換算 (vol_x_20d_intraday) を優先する。
  TECH_LINE="$(jq -r '
    (.daily // {}) as $d
    | if ($d.status // "ok") != "ok" then "" else
      [ ($d.ma25_dev_pct as $v | if $v != null then "MA25乖離 \(if $v > 0 then "+" else "" end)\($v)%" else empty end),
        ($d.rsi_14 as $v | if $v != null then "RSI14 \($v)" else empty end),
        ($d.range_pct as $v | if $v != null then "20日レンジ位置 \($v)%" else empty end),
        (if $d.vol_x_20d_intraday != null then "出来高 当日ペース\($d.vol_x_20d_intraday)倍"
         elif $d.vol_x_20d != null then "出来高 \($d.vol_x_20d)倍" else empty end),
        ($d.atr_vs_baseline as $v | if $v != null then "ATR 平常比\($v)倍" else empty end),
        ($d.obv_trend as $v | if $v != null then "OBV \({rising:"上向き",flat:"横ばい",falling:"下向き"}[$v])" else empty end),
        ($d.cmf_20d as $v | if $v != null then "CMF20 \($v)" else empty end) ]
      | if length == 0 then ""
        else "📐 テクニカル (\($d.latest_date // "最新") 確定足): " + join(" / ") end
      end' "$NUMCTX_FILE")"
  if [[ -n "$TECH_LINE" ]]; then
    BODY="${BODY}
${TECH_LINE}"
  fi
fi

# --- 強制決済スコアの観測行を D1 から引く (LLM には渡さない。投稿末尾に貼るだけ) -----
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
# body 末尾に観測行を足す (空なら何もしない)。ブリーフ本文と視覚的に分けるため接頭辞を付ける。
if [[ -n "$FORCED_LINE" ]]; then
  BODY="${BODY}
🧱 強制フロー観測: ${FORCED_LINE}"
fi

# --- 指数リバランス窓の観測行 (LLM には渡さない。投稿末尾に貼るだけ) ----------
# リバランスは「その日の値動きと無関係に引けへパッシブ売買が集中する」時間アノマリー。forced と同じく
# LLM には渡さず、窓に入っていれば観測事実として本文末尾に貼る。
# 日付計算は Worker /index-rebalance (event-context.ts) が JST 今日で行う。取得はこのスクリプトでは
# なく前段ステップが judge-context と並行に済ませ、その JSON を rebalance-file 経由で受け取る。
# ここで curl は叩かない (numctx と保存場所を分けて LLM に混ざらないようにするため)。
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
# body は配列を改行で繋いだ後に観測行 (注目水準/テクニカル/forced/rebalance) を足したものなので、split の前に
# gsub でリテラル "\n" を本物の改行へ正規化する (どちらで来ても同じ結果になる)。
# brief_body は LLM 由来の本文素テキスト。Worker /slack/post が briefs テーブルに upsert する。
PAYLOAD="$(jq -n \
  --arg ticker "$TICKER" \
  --arg headline "$HEADLINE" \
  --arg body "$BODY" \
  --arg brief_body "$BRIEF_BODY" \
  '{
    ticker: $ticker,
    kind: "ticker-brief",
    text: $headline,
    brief_body: $brief_body,
    blocks: ([{type:"section", text:{type:"mrkdwn", text:$headline}}]
      + ([$body | gsub("\\\\n"; "\n") | split("\n")[] | select(length > 0)
          | {type:"section", text:{type:"mrkdwn", text:.}}]))
  }')"

# テスト/オフライン用の注入口: POST_BRIEF_DRYRUN=1 で curl を叩かず、組み立てた payload を
# stderr に出して "slack skipped" を返す。本物の呼び出しでは curl を使う。
if [[ "${POST_BRIEF_DRYRUN:-}" == "1" ]]; then
  printf 'POST %s %s\n' "${WORKER_URL%/}/slack/post" "$(jq -c . <<<"$PAYLOAD")" >&2
  echo "slack skipped"
  exit 0
fi

# /slack/post は SLACK_BOT_TOKEN 未設定なら 503 (スレッド機能オフ)。その場合は投稿せず
# headline+本文を stdout に出して "slack skipped" を返す (ブリーフ自体は失わない)。
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
