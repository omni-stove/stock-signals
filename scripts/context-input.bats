#!/usr/bin/env bats
# scripts/context-input.bats
# context-input.sh の status 分岐 (no-update / ok)・カーソル取得・次カーソル算出・
# 非 JSON の {} 正規化を検証する。
#
# 実行: pnpm run test:sh
#
# 設計:
#   - Worker /context は CONTEXT_JSON 環境変数で差し替える (注入口)。
#   - Worker の /pull /pull-news は PULL_IR_JSON / PULL_NEWS_JSON で差し替える (注入口)。
#   - WORKER_URL は必須チェックがあるのでダミー値を渡す (注入があるので curl は走らない)。
#   - 出力は JSON 1 つなので jq で値を取り出して突き合わせる。
#   - @test の説明は ASCII のみ (bats 1.13 は非ASCIIのテスト名を実行できない)。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  SCRIPT="$ROOT/scripts/context-input.sh"
}

# ticker を渡して context-input.sh を直接実行し、JSON を $output に得る。
# 各注入値は呼び出し側で export 済みのものを引き継ぐ。
run_ctx() {
  run env \
    WORKER_URL="http://test.invalid" \
    SYNC_TOKEN="" \
    CONTEXT_JSON="${CONTEXT_JSON:-}" \
    PULL_IR_JSON="${PULL_IR_JSON:-}" \
    PULL_NEWS_JSON="${PULL_NEWS_JSON:-}" \
    bash "$SCRIPT" "${1:-285A}"
  [ "$status" -eq 0 ]
}

jqf() { printf '%s' "$output" | jq -r "$1"; }

# /context の応答サンプル。本文 + ir/news の現行カーソルを持つ。
context_with_cursors() {
  cat <<'JSON'
{"exists":true,"body":"context here","cursors":{"ir":"2026-06-01T00:00:00Z","news":"2026-06-02T00:00:00Z"}}
JSON
}

# === status 分岐 ============================================================

# 既存コンテキストはあるが IR/ニュースが両方 0 なら no-update
@test "status: context present but no new items yields no-update" {
  CONTEXT_JSON="$(context_with_cursors)" \
    PULL_IR_JSON='{"rows":[]}' PULL_NEWS_JSON='{"rows":[]}' run_ctx 285A
  [ "$(jqf '.status')" = "no-update" ]
  [ "$(jqf '.ir_count')" = "0" ]
  [ "$(jqf '.news_count')" = "0" ]
}

# コンテキスト行が無い (初回) 銘柄でも、新規があれば ok で動く
@test "status: missing context row still yields ok when new items exist" {
  CONTEXT_JSON='{"exists":false,"body":null,"cursors":{"ir":null,"news":null}}' \
    PULL_IR_JSON='{"rows":[{"fetched_at":"2026-06-05T00:00:00Z","title":"IR1"}]}' \
    PULL_NEWS_JSON='{"rows":[]}' run_ctx 285A
  [ "$(jqf '.status')" = "ok" ]
  [ "$(jqf '.context_body')" = "" ]
}

# /context が壊れた JSON を返しても {} に正規化され、新規も無ければ no-update に倒れる
@test "status: malformed context output normalizes and falls back to no-update" {
  CONTEXT_JSON='not-json-at-all' \
    PULL_IR_JSON='{"rows":[]}' PULL_NEWS_JSON='{"rows":[]}' run_ctx 285A
  [ "$(jqf '.status')" = "no-update" ]
}

# 新規があれば status=ok で items を載せる
@test "status: new items yield ok with items and counts" {
  CONTEXT_JSON="$(context_with_cursors)" \
    PULL_IR_JSON='{"rows":[{"fetched_at":"2026-06-05T00:00:00Z","title":"IR1"},{"fetched_at":"2026-06-06T00:00:00Z","title":"IR2"}]}' \
    PULL_NEWS_JSON='{"rows":[{"fetched_at":"2026-06-07T00:00:00Z","title":"N1"}]}' run_ctx 285A
  [ "$(jqf '.status')" = "ok" ]
  [ "$(jqf '.ir_count')" = "2" ]
  [ "$(jqf '.news_count')" = "1" ]
  [ "$(jqf '.ir_items[0].title')" = "IR1" ]
  [ "$(jqf '.news_items[0].title')" = "N1" ]
  # 本文も同梱される (skill が再度 fetch せずに書き換えられるように)
  [ "$(jqf '.context_body | test("context here")')" = "true" ]
}

# === カーソル取得 / 次カーソル算出 ==========================================

# 現行カーソルは /context の cursors から取れる
@test "cursor: current cursors come from /context" {
  CONTEXT_JSON="$(context_with_cursors)" \
    PULL_IR_JSON='{"rows":[{"fetched_at":"2026-06-05T00:00:00Z"}]}' PULL_NEWS_JSON='{"rows":[]}' run_ctx 285A
  [ "$(jqf '.cursors.ir.current')" = "2026-06-01T00:00:00Z" ]
  [ "$(jqf '.cursors.news.current')" = "2026-06-02T00:00:00Z" ]
}

# 次カーソルは引いた行の max fetched_at。0 件の kind は現行カーソルを据え置く
@test "cursor: next is max fetched_at, zero-count kind keeps current" {
  CONTEXT_JSON="$(context_with_cursors)" \
    PULL_IR_JSON='{"rows":[{"fetched_at":"2026-06-05T00:00:00Z"},{"fetched_at":"2026-06-09T00:00:00Z"}]}' \
    PULL_NEWS_JSON='{"rows":[]}' run_ctx 285A
  # IR は新規があるので max=06-09 が次カーソル
  [ "$(jqf '.cursors.ir.next')" = "2026-06-09T00:00:00Z" ]
  # news は 0 件なので現行カーソル (06-02) を据え置く
  [ "$(jqf '.cursors.news.next')" = "2026-06-02T00:00:00Z" ]
}

# 初回 (cursors が null) は current=null になる
@test "cursor: first run with null cursors has null current" {
  CONTEXT_JSON='{"exists":false,"body":null,"cursors":{"ir":null,"news":null}}' \
    PULL_IR_JSON='{"rows":[{"fetched_at":"2026-06-05T00:00:00Z"}]}' PULL_NEWS_JSON='{"rows":[]}' run_ctx 285A
  [ "$(jqf '.cursors.ir.current')" = "null" ]
  # IR は新規ありなので next は埋まる
  [ "$(jqf '.cursors.ir.next')" = "2026-06-05T00:00:00Z" ]
  # news は新規なし & 現行カーソルも無いので next=null
  [ "$(jqf '.cursors.news.next')" = "null" ]
}

# === 非 JSON の正規化 =======================================================

# Worker が非 JSON を返しても {} に正規化され、新規 0 → no-update に倒れる
@test "robustness: non-JSON pull response normalizes to no-update" {
  CONTEXT_JSON='{"exists":true,"body":"x","cursors":{"ir":null,"news":null}}' \
    PULL_IR_JSON='garbage-not-json' PULL_NEWS_JSON='' run_ctx 285A
  [ "$(jqf '.status')" = "no-update" ]
  [ "$(jqf '.ir_count')" = "0" ]
  [ "$(jqf '.news_count')" = "0" ]
}
