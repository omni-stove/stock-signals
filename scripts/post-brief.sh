#!/usr/bin/env bash
# scripts/post-brief.sh
# ticker-brief の材料ブリーフを Slack に投稿し、briefs テーブルに保存させる。
#
# 設計:
#   - skill 本体に curl を叩かせない。投稿経路 (Worker /slack/post, Bearer 認証, kind 付与,
#     channel 省略, 503=Bot未設定→stdout フォールバック) は決定論的なのでこのスクリプトが持つ。
#     skill は「材料・分析・強気/弱気」を構造化出力で渡すだけ。
#   - 太字の headline と数値行をサマリーとして親に投稿し、本文・観測行は details として親のスレッドに
#     1 通でぶら下げる (チャンネルにはサマリーだけが流れる)。
#   - 数値行 (現在の現値・出来高ペース / 確定足の MA・レンジ・RSI・ATR・出来高倍率・OBV・CMF /
#     中期の MA75・52週高値安値・TOPIX比・予想PER) は LLM に
#     出させず、numctx の実在値からここで決定論で組んで親の context block に貼る。LLM が水準・指標の
#     数値を創作する余地を残さない (LLM はテクニカルの読みだけを返す)。
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
#   $4 = numctx-file     (任意。LLM に渡したのと同じ /judge-context JSON のパス。数値行に
#                         使う。未指定/不在ならスキップ)
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

# 本文を emoji 見出しのセクションごとの文字列に組む: 🆕 新着 (見出しのみ) / 📈 テクニカル /
# 🐂 強気 / 🐻 弱気 / 👀 注視。項目が無いセクションは出さず、1 セクション 1 section block になる。
SECTIONS_JSON="$(printf '%s' "$BRIEF_JSON" | jq -c '
  def group($heading): if length == 0 then empty else ([$heading] + .) | join("\n") end;
  def bullets: map("・" + .);
  [ ((.materials // []) | bullets | group("🆕 *新着*")),
    ((.technical // []) | bullets | group("📈 *テクニカル*")),
    ((.bull // []) | bullets | group("🐂 *強気*")),
    ((.bear // []) | bullets | group("🐻 *弱気*")),
    ((.watch // []) | bullets | group("👀 *注視*")) ]')"
BODY="$(printf '%s' "$SECTIONS_JSON" | jq -r 'join("\n")')"
[[ -n "$BODY" ]] || { echo "post-brief.sh: empty body in $BRIEF_FILE" >&2; exit 1; }

# briefs テーブルに保存する本文 = LLM 由来の内容のみ (数値行・観測行はここから導出可能なので含めない)。
# position-report が建玉銘柄の最新材料としてこれを読む。
BRIEF_BODY="$BODY"

# --- 数値行 (決定論): numctx の実在値から組み、親の context block に貼る ----
# 📐 数値 の見出しの下に 3 行。現在 = 現値 (prices.latest.price、closed なら daily.close) と当日ペース出来高。
# 確定足 = daily の最新確定足の指標。ザラ場中は前営業日の足なので、当日の値とは行を分ける。
# 中期 = MA75 と乖離 / 52週高値・安値と現値からの距離 / TOPIX 比 20 日超過リターン / 予想 PER。
# どちらも値があるものだけを " / " 連結し、値が 1 つも無ければ行ごとスキップする。
# daily が insufficient/stale なら確定足の行は出さない。
NUMBERS=""
if [[ -n "$NUMCTX_FILE" && -s "$NUMCTX_FILE" ]] && jq -e . "$NUMCTX_FILE" >/dev/null 2>&1; then
  CURRENT_LINE="$(jq -r '
    [ ((.prices.latest.price // .daily.close) as $v | if $v != null then "現値 \($v)" else empty end),
      (.daily.vol_x_20d_intraday as $v | if $v != null then "出来高 当日ペース\($v)倍" else empty end) ]
    | if length == 0 then "" else "現在: " + join(" / ") end' "$NUMCTX_FILE")"

  CONFIRMED_LINE="$(jq -r '
    def signed: "\(if . > 0 then "+" else "" end)\(.)";
    (.daily // {}) as $d
    | if ($d.status // "ok") != "ok" then "" else
      [ ($d.ma5 as $v | if $v != null then "MA5 \($v)" else empty end),
        (if $d.ma25 != null
         then "MA25 \($d.ma25)" + (if $d.ma25_dev_pct != null then "（乖離 \($d.ma25_dev_pct | signed)%）" else "" end)
         elif $d.ma25_dev_pct != null then "MA25乖離 \($d.ma25_dev_pct | signed)%" else empty end),
        (if ($d.range_low_20d != null and $d.range_high_20d != null)
         then "20日レンジ \($d.range_low_20d)〜\($d.range_high_20d)" + (if $d.range_pct != null then "（位置 \($d.range_pct)%）" else "" end)
         elif $d.range_pct != null then "20日レンジ位置 \($d.range_pct)%" else empty end),
        ($d.rsi_14 as $v | if $v != null then "RSI14 \($v)" else empty end),
        (if $d.atr_pct != null
         then "ATR \($d.atr_pct)%" + (if $d.atr_vs_baseline != null then "（平常比 \($d.atr_vs_baseline)倍）" else "" end)
         elif $d.atr_vs_baseline != null then "ATR 平常比\($d.atr_vs_baseline)倍" else empty end),
        (if $d.vol_x_20d_intraday == null and $d.vol_x_20d != null then "出来高 \($d.vol_x_20d)倍" else empty end),
        ($d.obv_trend as $v | if $v != null then "OBV \({rising:"上向き",flat:"横ばい",falling:"下向き"}[$v])" else empty end),
        ($d.cmf_20d as $v | if $v != null then "CMF20 \($v)" else empty end) ]
      | if length == 0 then ""
        else "\($d.latest_date // "最新") 確定足: " + join(" / ") end
      end' "$NUMCTX_FILE")"

  MEDIUM_LINE="$(jq -r '
    def signed: "\(if . > 0 then "+" else "" end)\(.)";
    (if (.trend.status // "") == "ok" then .trend else {} end) as $t
    | ((.relative.returns // []) | map(select(.days == 20)) | .[0]) as $r20
    | [ (if $t.ma75 != null
         then "MA75 \($t.ma75)" + (if $t.ma75_dev_pct != null then "（乖離 \($t.ma75_dev_pct | signed)%）" else "" end)
         else empty end),
        (if $t.high_52w != null then "52週高値 \($t.high_52w)（\($t.from_high_52w_pct | signed)%）" else empty end),
        (if $t.low_52w != null then "52週安値 \($t.low_52w)（\($t.from_low_52w_pct | signed)%）" else empty end),
        (if $r20 != null then "TOPIX比 20日 \($r20.excess_pct | signed)%" else empty end),
        (if (.valuation.status // "") == "ok" and .valuation.per != null then "予想PER \(.valuation.per)倍" else empty end) ]
    | if length == 0 then "" else "中期: " + join(" / ") end' "$NUMCTX_FILE")"

  NUMBERS="$(printf '%s\n%s\n%s\n' "$CURRENT_LINE" "$CONFIRMED_LINE" "$MEDIUM_LINE" | sed '/^$/d')"
  NUMBERS="${NUMBERS:+📐 *数値*
${NUMBERS}}"
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
# 観測行を足す (空なら何もしない)。ブリーフ本文と視覚的に分けるため接頭辞を付ける。
OBSERVATIONS=""
if [[ -n "$FORCED_LINE" ]]; then
  OBSERVATIONS="🧱 *強制フロー観測*: ${FORCED_LINE}"
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
  OBSERVATIONS="${OBSERVATIONS:+${OBSERVATIONS}
}📅 *リバランス窓*: ${REBAL_LINE}"
fi

# 親 = 太字の headline → 数値行 (context block)。details = 本文グループ → 観測行 (1 行 1 section)。
# LLM 由来の文字列はリテラル "\n" を本物の改行へ正規化する (どちらで来ても同じ結果になる)。
# brief_body は LLM 由来の本文素テキスト。Worker /slack/post が briefs テーブルに upsert する。
DETAILS_TEXT="$(printf '%s\n' "$BODY" "$OBSERVATIONS" | sed '/^$/d')"
PAYLOAD="$(jq -n \
  --arg ticker "$TICKER" \
  --arg headline "$HEADLINE" \
  --argjson sections "$SECTIONS_JSON" \
  --arg observations "$OBSERVATIONS" \
  --arg numbers "$NUMBERS" \
  --arg brief_body "$BRIEF_BODY" \
  --arg details_text "$DETAILS_TEXT" \
  'def section: {type:"section", text:{type:"mrkdwn", text:.}};
  def bold: "*" + gsub("\\*"; "") + "*";
  {
    ticker: $ticker,
    kind: "ticker-brief",
    text: $headline,
    brief_body: $brief_body,
    blocks: ([$headline | bold | section]
      + (if $numbers == "" then [] else [{type:"context", elements:[{type:"mrkdwn", text:$numbers}]}] end)),
    details: {
      text: $details_text,
      blocks: (($sections | map(gsub("\\\\n"; "\n") | section))
        + [$observations | gsub("\\\\n"; "\n") | split("\n")[] | select(length > 0) | section])
    }
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
  printf '%s\n' "$HEADLINE" "$NUMBERS" "$DETAILS_TEXT" | sed '/^$/d'
  echo "slack skipped (HTTP ${HTTP_CODE})"
fi
