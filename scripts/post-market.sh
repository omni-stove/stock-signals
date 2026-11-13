#!/usr/bin/env bash
# scripts/post-market.sh
# market-brief の朝のマーケットブリーフを Slack に投稿し、briefs (ticker='market') に保存させる。
#
# 設計:
#   - skill 本体に curl を叩かせない。投稿経路 (Worker /slack/post, Bearer 認証, kind 付与,
#     503=Bot未設定→stdout フォールバック) は決定論的なのでこのスクリプトが持つ。
#     skill は「ヘッドライン・本文行」を引数で渡すだけ。
#   - ブリーフは銘柄非依存なので ticker は固定で "market"。太字の headline と数値行をサマリーとして親に投稿し、
#     本文行 (改行区切り) は section に詰めて details として親のスレッドに 1 通でぶら下げる。
#   - 数値行 (前夜米国の指数・ドル円・米10年債・VIX / 場中の日経225・KOSPI / セクター平均 / 空売り比率・
#     海外投資家の売買) は LLM に出させず、marketctx の実在値からここで決定論で組む。
#
# 入力:
#   $1 = signal-file (必須。market-brief スキルの構造化出力 (structured_output) を書いた JSON の
#                    パス。{headline, body[]} を持つ。skill は curl を一切叩かず要約するだけ。
#                    投稿はこのスクリプト = workflow の後続ステップが行う)
#   $2 = marketctx-file (任意。LLM に渡したのと同じ /market-context JSON。数値行に使う。未指定/不在ならスキップ)
# 環境変数: WORKER_URL (必須), SYNC_TOKEN (任意)。
#
# 出力 (stdout): "slack ok" または "slack skipped" の 1 行。skill の stdout 行はこれを使う。
# テスト/オフライン用の注入口: POST_MARKET_DRYRUN=1 で curl を叩かず、組み立てた JSON
#   ペイロードを stderr に "POST <url> <json>" 形式で出すだけにする (bats が blocks を検証できる)。

set -euo pipefail

SIGNAL_FILE="${1:?usage: post-market.sh <signal-file> [marketctx-file]}"
MARKETCTX_FILE="${2:-}"

: "${WORKER_URL:?WORKER_URL is required}"
[[ -f "$SIGNAL_FILE" ]] || { echo "post-market.sh: signal-file not found: $SIGNAL_FILE" >&2; exit 1; }

# structured_output JSON を読む。空/不正 JSON はブリーフ不成立として落とす (投稿しない)。
SIGNAL_JSON="$(cat "$SIGNAL_FILE")"
printf '%s' "$SIGNAL_JSON" | jq -e . >/dev/null 2>&1 || {
  echo "post-market.sh: signal-file is not valid JSON: $SIGNAL_FILE" >&2; exit 1; }
# headline = Slack 1 行目、body[] = 本文行。headline は必須。
HEADLINE="$(printf '%s' "$SIGNAL_JSON" | jq -r '.headline // ""')"
BODY="$(printf '%s' "$SIGNAL_JSON" | jq -r '(.body // []) | join("\n")')"
[[ -n "$HEADLINE" ]] || { echo "post-market.sh: empty headline in $SIGNAL_FILE" >&2; exit 1; }

# --- 数値行 (決定論) ----------------------------------------------------------
# 1 行目 = 前夜米国 (SOX/NASDAQ/Dow/日経先物/ドル円/米10年債/VIX。休場明け・stale は日付の横に添える)、
# 2 行目 = 場中の指数 (status=ok のものだけ)、3 行目 = セクター平均 (前日比・5日)、
# 4 行目 = 空売り比率 (5日平均) と海外投資家の週次売買 (連続週)。値の無い項目・行は出さない。
NUMBERS=""
if [[ -n "$MARKETCTX_FILE" && -s "$MARKETCTX_FILE" ]] && jq -e . "$MARKETCTX_FILE" >/dev/null 2>&1; then
  NUMBERS="$(jq -r '
    def signed: "\(if . > 0 then "+" else "" end)\(.)";
    def pct($label): if . != null then "\($label) \(signed)%" else empty end;
    def withchg($label; $chg; $suffix):
      if . != null then "\($label) \(.)" + (if $chg != null then "（\($chg | signed)\($suffix)）" else "" end) else empty end;
    def us:
      (.premarket // {}) as $p
      | select(($p.status // "unavailable") != "unavailable")
      | [ ($p.sox_change_pct | pct("SOX")), ($p.nasdaq_change_pct | pct("NASDAQ")), ($p.dow_change_pct | pct("Dow")),
          ($p.nikkei_futures_price | if . != null then "日経先物 \(.)" else empty end),
          ($p.usdjpy_price | withchg("ドル円"; $p.usdjpy_change; "")),
          ($p.us10y_yield | if . != null then "米10年 \(.)%" + (if $p.us10y_change_bp != null then "（\($p.us10y_change_bp | signed)bp）" else "" end) else empty end),
          ($p.vix_price | withchg("VIX"; $p.vix_change_pct; "%")) ] as $items
      | select($items | length > 0)
      | [ $p.date, (if $p.us_session == "carried_over" then "休場明けの前回終値" else empty end),
          (if $p.status == "stale" then "stale" else empty end) ] | map(select(. != null)) as $tags
      | "前夜米国" + (if ($tags | length) > 0 then "（" + ($tags | join("・")) + "）" else "" end) + ": " + ($items | join(" / "));
    def live:
      [ (.live_indexes.indexes // [])[] | select(.status == "ok" and .price != null)
        | "\(.label) \(.price)" + (if .change_pct != null then "（\(.change_pct | signed)%）" else "" end) ]
      | select(length > 0) | "場中: " + join(" / ");
    def sectors:
      [ (.sectors.sectors // [])[] | select(.avg_change_pct != null or .avg_ret_5d_pct != null)
        | "\(.sector) " + ([ (.avg_change_pct | pct("前日比")), (.avg_ret_5d_pct | pct("5日")) ] | join("・")) ]
      | select(length > 0) | "セクター平均: " + join(" / ");
    def flows:
      [ (.market_short_ratio // {} | select(.status == "ok" and .ratio_pct != null)
          | "空売り比率 \(.ratio_pct)%" + (if .avg_5d_pct != null then "（5日平均 \(.avg_5d_pct)%）" else "" end)),
        (.investor_flows // {} | select(.status == "ok" and .net.foreigners != null)
          | "海外投資家 \(.net.foreigners | signed)億円（\(.week_start)〜\(.week_end)"
            + (.foreigners_streak_weeks // 0 | if . > 0 then "・\(.)週連続買い越し" elif . < 0 then "・\(-.)週連続売り越し" else "" end) + "）") ]
      | select(length > 0) | join(" / ");
    [ us, live, sectors, flows ] | join("\n")' "$MARKETCTX_FILE")"
  NUMBERS="${NUMBERS:+📐 *数値*
${NUMBERS}}"
fi

# 親 = 太字の headline → 数値行 (context block)、details = 本文行の section blocks。リテラル "\n" も実改行も
# どちらで渡されても同じになるよう gsub で正規化してから split する。
# brief_body は本文素テキスト。Worker /slack/post が briefs (ticker='market') に upsert し、
# judge-context が market_brief として個別ブリーフに同梱する。
PAYLOAD="$(jq -n \
  --arg headline "$HEADLINE" \
  --arg body "$BODY" \
  --arg numbers "$NUMBERS" \
  'def section: {type:"section", text:{type:"mrkdwn", text:.}};
  def bold: "*" + gsub("\\*"; "") + "*";
  [$body | gsub("\\\\n"; "\n") | split("\n")[] | select(length > 0)] as $lines
  | {
      ticker: "market",
      kind: "market-brief",
      text: $headline,
      brief_body: $body,
      blocks: ([$headline | bold | section]
        + (if $numbers == "" then [] else [{type:"context", elements:[{type:"mrkdwn", text:$numbers}]}] end))
    }
    + (if ($lines | length) > 0
       then {details: {text: ($lines | join("\n")), blocks: ($lines | map(section))}}
       else {} end)')"

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
  printf '%s\n' "$HEADLINE" "$NUMBERS" "$BODY" | sed '/^$/d'
  echo "slack skipped (HTTP ${HTTP_CODE})"
fi
