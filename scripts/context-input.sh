#!/usr/bin/env bash
# scripts/context-input.sh
# context-builder に「渡す」ための入力 (既存 Issue + カーソル以降の新規 IR/ニュース) を
# 1 つの JSON にまとめる。
#
# 設計 (judge-context.sh / event-context.sh と同じ思想):
#   - skill 本体に curl/gh を叩かせない。決定論的な read + fetch (Issue 取得・カーソル抽出・
#     /pull /pull-news の since 付き取得・新規0判定・次カーソル算出) は workflow step
#     (= このスクリプト) が担い、結果を 1 つの JSON として渡す。skill は新規アイテムの
#     取捨選択と本文の再生成・上書きだけに集中する。
#   - Issue 本文 (コンテキスト) はここでも JSON に同梱して渡す。skill が再度 gh で引かずに
#     済むようにするため (judge-context は本文を扱わないが、こちらは本文を「書き換える」
#     ために必ず読むので、入力として渡してしまう方が skill の curl/gh 依存を完全に外せる)。
#
# 前提: jq + gh (GitHub Actions ubuntu-latest)。gh は GH_TOKEN で認証。
#       ローカル検証は `GH_TOKEN=$(gh auth token) bash scripts/context-input.sh 285A`。
#
# 入力: $1 = ticker (必須)。WORKER_URL / SYNC_TOKEN / GH_TOKEN は環境変数。
# 出力: JSON 1 つを stdout に。status で skill の分岐を決める:
#         "no-issue"  … 対象 Issue が無い → skill は何もせず終了
#         "no-update" … Issue はあるが新規 IR/ニュースが両方 0 → skill は本文も dispatch も触らない
#         "ok"        … 新規あり → skill は items を読んで本文を再生成・上書きし dispatch する
# 実行: bash scripts/context-input.sh 285A

set -euo pipefail

TICKER="${1:?usage: context-input.sh <ticker>}"

: "${WORKER_URL:?WORKER_URL is required}"
AUTH=(-H "Authorization: Bearer ${SYNC_TOKEN:-}")

# --- Issue 取得 --------------------------------------------------------------
# ticker ラベルで開いている ir-report Issue を 1 件引く。無ければ status=no-issue で即返す
# (Issue は out-of-band で provision される前提。skill は勝手に作らない)。
ISSUE="$(gh issue list --label ir-report --label "ticker:$TICKER" --state open \
  --json number,body --limit 1 2>/dev/null || echo '[]')"
ISSUE_N="$(echo "$ISSUE" | jq 'length')"
if [[ "$ISSUE_N" -eq 0 ]]; then
  jq -n --arg t "$TICKER" '{ticker:$t, status:"no-issue"}'
  exit 0
fi

ISSUE_NUMBER="$(echo "$ISSUE" | jq '.[0].number')"
BODY="$(echo "$ISSUE" | jq -r '.[0].body')"

# 本文末尾の 2 カーソルを抽出。未確立 (初回) は空文字 → since 省略 = 直近 backlog を引く。
IR_CURSOR="$(printf '%s' "$BODY" | grep -oE 'ir_last_fetched_at=[^ ]+' | head -1 | cut -d= -f2- || true)"
NEWS_CURSOR="$(printf '%s' "$BODY" | grep -oE 'news_last_fetched_at=[^ ]+' | head -1 | cut -d= -f2- || true)"
IR_CURSOR="${IR_CURSOR%% -->}"
NEWS_CURSOR="${NEWS_CURSOR%% -->}"

# --- 新規 IR / ニュースを Worker から引く ------------------------------------
# /pull は IR (ir:/tdnet:/rating:)、/pull-news はニュース (kabutan:)。since があれば
# fetched_at > since で絞る (= カーソル以降の新規だけ)。失敗/空は "{}" に正規化して
# 以降の jq を安全に走らせる (judge-context.sh の fetch() と同じ作法)。
pull() {
  local path="$1" cursor="$2"
  local q="code=$TICKER&limit=20"
  [[ -n "$cursor" ]] && q+="&since=$cursor"
  local out; out="$(curl -sf "${AUTH[@]}" "$WORKER_URL/$path?$q" 2>/dev/null || true)"
  if [[ -z "$out" ]]; then echo "{}"; else echo "$out"; fi
}

IR="$(pull "pull" "$IR_CURSOR")"
NEWS="$(pull "pull-news" "$NEWS_CURSOR")"

IR_ROWS="$(echo "$IR" | jq '.rows // []')"
NEWS_ROWS="$(echo "$NEWS" | jq '.rows // []')"
IR_N="$(echo "$IR_ROWS" | jq 'length')"
NEWS_N="$(echo "$NEWS_ROWS" | jq 'length')"

# 両方 0 → 新規なし。skill は本文も dispatch も触らない。
if [[ "$IR_N" -eq 0 && "$NEWS_N" -eq 0 ]]; then
  jq -n --arg t "$TICKER" --argjson n "$ISSUE_NUMBER" \
    '{ticker:$t, status:"no-update", issue_number:$n, ir_count:0, news_count:0}'
  exit 0
fi

# --- 次カーソル算出 ----------------------------------------------------------
# 引いた行の max fetched_at が次カーソル。0 件の kind は現行カーソルを据え置く (skill が
# 本文を再生成する際にそのまま埋める)。rows は fetched_at ASC なので末尾が最大。
ir_next="$(echo "$IR_ROWS"   | jq -r 'if length>0 then (max_by(.fetched_at).fetched_at) else null end')"
news_next="$(echo "$NEWS_ROWS" | jq -r 'if length>0 then (max_by(.fetched_at).fetched_at) else null end')"
[[ "$ir_next"   == "null" ]] && ir_next="$IR_CURSOR"
[[ "$news_next" == "null" ]] && news_next="$NEWS_CURSOR"

# --- 組み立て ----------------------------------------------------------------
# body は巨大なので --arg で文字列として渡す。skill はこの body を起点に書き換える。
jq -n \
  --arg ticker "$TICKER" \
  --argjson issue_number "$ISSUE_NUMBER" \
  --arg body "$BODY" \
  --arg ir_cursor "${IR_CURSOR:-}" \
  --arg news_cursor "${NEWS_CURSOR:-}" \
  --arg ir_next "${ir_next:-}" \
  --arg news_next "${news_next:-}" \
  --argjson ir_rows "$IR_ROWS" \
  --argjson news_rows "$NEWS_ROWS" \
  '{
    ticker: $ticker,
    status: "ok",
    issue_number: $issue_number,
    issue_body: $body,
    cursors: {
      ir:   { current: (if $ir_cursor   == "" then null else $ir_cursor   end), next: (if $ir_next   == "" then null else $ir_next   end) },
      news: { current: (if $news_cursor == "" then null else $news_cursor end), next: (if $news_next == "" then null else $news_next end) }
    },
    ir_count:   ($ir_rows   | length),
    news_count: ($news_rows | length),
    ir_items:   $ir_rows,
    news_items: $news_rows
  }'
