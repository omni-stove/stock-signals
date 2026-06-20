#!/usr/bin/env bash
# scripts/context-input.sh
# context-builder に「渡す」ための入力 (既存コンテキスト本文 + カーソル以降の新規 IR/ニュース) を
# 1 つの JSON にまとめる。
#
# 設計 (judge-context.sh / event-context.sh と同じ思想):
#   - skill 本体に curl/gh を叩かせない。決定論的な read + fetch (コンテキスト取得・カーソル抽出・
#     /pull /pull-news の since 付き取得・新規0判定・次カーソル算出) は workflow step
#     (= このスクリプト) が担い、結果を 1 つの JSON として渡す。skill は新規アイテムの
#     取捨選択と本文の再生成だけに集中する (本文は再生成後にファイルへ書き、POST は workflow step)。
#   - コンテキスト本文はここでも JSON に同梱して渡す。skill が再度 curl で引かずに済むようにするため
#     (judge-context は本文を扱わないが、こちらは本文を「書き換える」ために必ず読むので、入力として
#     渡してしまう方が skill の curl/gh 依存を完全に外せる)。
#
# 移行メモ: 従来は living document を GitHub Issue 本文に置き、カーソルも本文コメント行に
#   埋めていた。現在は Worker /context (D1 contexts テーブル) を source of truth とする。
#   行が無い銘柄は初回扱い (body 空・カーソル null → /pull は since 省略で backlog を引く)。
#
# 前提: jq + curl (GitHub Actions ubuntu-latest)。WORKER_URL / SYNC_TOKEN は環境変数。
#       ローカル検証は `WORKER_URL=... SYNC_TOKEN=... bash scripts/context-input.sh 285A`。
#
# 入力: $1 = ticker (必須)。WORKER_URL / SYNC_TOKEN は環境変数。
# 出力: JSON 1 つを stdout に。status で skill の分岐を決める:
#         "no-update" … 新規 IR/ニュースが両方 0 → skill は本文も dispatch も触らない
#         "ok"        … 新規あり → skill は items を読んで本文を再生成しファイル出力する
# 実行: bash scripts/context-input.sh 285A

set -euo pipefail

TICKER="${1:?usage: context-input.sh <ticker>}"

: "${WORKER_URL:?WORKER_URL is required}"
AUTH=(-H "Authorization: Bearer ${SYNC_TOKEN:-}")

# --- 既存コンテキスト取得 ----------------------------------------------------
# Worker /context から本文 + 2カーソル (ir / news の last_fetched_at) を引く。行が無ければ
# exists=false・body=null・カーソル null で返るので、初回扱い (backlog を引く) になる。
# テスト/オフライン用の注入口: CONTEXT_JSON があれば curl を叩かずそれを使う
# (judge-context.sh の FETCH_*_JSON と同じ思想)。
if [[ -n "${CONTEXT_JSON:-}" ]]; then
  CTX="$CONTEXT_JSON"
else
  CTX="$(curl -sf "${AUTH[@]}" "$WORKER_URL/context?code=$TICKER" 2>/dev/null || true)"
fi
# curl 失敗や非 JSON は "{}" に正規化 (exists 無し → body null・カーソル null の初回扱いに倒す)。
echo "$CTX" | jq -e . >/dev/null 2>&1 || CTX='{}'

# 本文は無ければ空文字 (初回 = skill が一から組み立てる)。
BODY="$(echo "$CTX" | jq -r '.body // ""')"
# カーソル未確立 (null / 未存在) は空文字 → since 省略 = 直近 backlog を引く。
IR_CURSOR="$(echo "$CTX" | jq -r '.cursors.ir // ""')"
NEWS_CURSOR="$(echo "$CTX" | jq -r '.cursors.news // ""')"

# --- 新規 IR / ニュースを Worker から引く ------------------------------------
# /pull は IR (ir:/tdnet:/rating:)、/pull-news はニュース (kabutan:)。since があれば
# fetched_at > since で絞る (= カーソル以降の新規だけ)。失敗/空は "{}" に正規化して
# 以降の jq を安全に走らせる (judge-context.sh の fetch() と同じ作法)。
pull() {
  local path="$1" cursor="$2"
  local out
  # テスト/オフライン用の注入口: path=pull → PULL_IR_JSON / path=pull-news → PULL_NEWS_JSON。
  # あれば curl を叩かず注入値を out に積む (curl 経路と同じ {} 正規化を下で通す)。
  local injected=""
  case "$path" in
    pull)      injected="${PULL_IR_JSON+set}";   out="${PULL_IR_JSON:-}" ;;
    pull-news) injected="${PULL_NEWS_JSON+set}"; out="${PULL_NEWS_JSON:-}" ;;
  esac
  if [[ -z "$injected" ]]; then
    local q="code=$TICKER&limit=20"
    [[ -n "$cursor" ]] && q+="&since=$cursor"
    out="$(curl -sf "${AUTH[@]}" "$WORKER_URL/$path?$q" 2>/dev/null || true)"
  fi
  # curl 失敗 (空) または非 JSON (タイムアウトで途中まで返った等) は "{}" に正規化し、
  # 以降の jq を確実に走らせる。jq -e で妥当性を判定する。
  if [[ -z "$out" ]] || ! echo "$out" | jq -e . >/dev/null 2>&1; then
    echo "{}"
  else
    echo "$out"
  fi
}

IR="$(pull "pull" "$IR_CURSOR")"
NEWS="$(pull "pull-news" "$NEWS_CURSOR")"

IR_ROWS="$(echo "$IR" | jq '.rows // []')"
NEWS_ROWS="$(echo "$NEWS" | jq '.rows // []')"
IR_N="$(echo "$IR_ROWS" | jq 'length')"
NEWS_N="$(echo "$NEWS_ROWS" | jq 'length')"

# 両方 0 → 新規なし。skill は本文も dispatch も触らない。
if [[ "$IR_N" -eq 0 && "$NEWS_N" -eq 0 ]]; then
  jq -n --arg t "$TICKER" \
    '{ticker:$t, status:"no-update", ir_count:0, news_count:0}'
  exit 0
fi

# --- 次カーソル算出 ----------------------------------------------------------
# 引いた行の max fetched_at が次カーソル。0 件の kind は現行カーソルを据え置く (workflow step が
# POST /context する際にそのまま渡す)。rows は fetched_at ASC なので末尾が最大。
ir_next="$(echo "$IR_ROWS"   | jq -r 'if length>0 then (max_by(.fetched_at).fetched_at) else null end')"
news_next="$(echo "$NEWS_ROWS" | jq -r 'if length>0 then (max_by(.fetched_at).fetched_at) else null end')"
[[ "$ir_next"   == "null" ]] && ir_next="$IR_CURSOR"
[[ "$news_next" == "null" ]] && news_next="$NEWS_CURSOR"

# --- 組み立て ----------------------------------------------------------------
# body は巨大なので --arg で文字列として渡す。skill はこの body を起点に書き換える。
jq -n \
  --arg ticker "$TICKER" \
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
    context_body: $body,
    cursors: {
      ir:   { current: (if $ir_cursor   == "" then null else $ir_cursor   end), next: (if $ir_next   == "" then null else $ir_next   end) },
      news: { current: (if $news_cursor == "" then null else $news_cursor end), next: (if $news_next == "" then null else $news_next end) }
    },
    ir_count:   ($ir_rows   | length),
    news_count: ($news_rows | length),
    ir_items:   $ir_rows,
    news_items: $news_rows
  }'
