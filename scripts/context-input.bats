#!/usr/bin/env bats
# scripts/context-input.bats
# context-input.sh の status 分岐 (no-issue / no-update / ok)・カーソル抽出・次カーソル算出・
# 非 JSON の {} 正規化を検証する。
#
# 実行: pnpm run test:sh
#
# 設計:
#   - gh issue list は ISSUE_JSON 環境変数で差し替える (注入口)。
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
    ISSUE_JSON="${ISSUE_JSON:-}" \
    PULL_IR_JSON="${PULL_IR_JSON:-}" \
    PULL_NEWS_JSON="${PULL_NEWS_JSON:-}" \
    bash "$SCRIPT" "${1:-285A}"
  [ "$status" -eq 0 ]
}

jqf() { printf '%s' "$output" | jq -r "$1"; }

# Issue body にカーソルコメントを含むサンプル。ir/news の現行カーソルを持つ。
issue_with_cursors() {
  cat <<'JSON'
[{"number":42,"body":"context here <!-- ir_last_fetched_at=2026-06-01T00:00:00Z news_last_fetched_at=2026-06-02T00:00:00Z -->"}]
JSON
}

# === status 分岐 ============================================================

# 対象 Issue が無ければ status=no-issue で即返す
@test "status: no issue yields no-issue" {
  ISSUE_JSON='[]' run_ctx 285A
  [ "$(jqf '.status')" = "no-issue" ]
  [ "$(jqf '.ticker')" = "285A" ]
}

# gh が壊れた JSON を返しても [] に正規化されて no-issue に倒れる
@test "status: malformed gh output falls back to no-issue" {
  ISSUE_JSON='not-json-at-all' run_ctx 285A
  [ "$(jqf '.status')" = "no-issue" ]
}

# Issue はあるが IR/ニュースが両方 0 なら no-update
@test "status: issue present but no new items yields no-update" {
  ISSUE_JSON="$(issue_with_cursors)" \
    PULL_IR_JSON='{"rows":[]}' PULL_NEWS_JSON='{"rows":[]}' run_ctx 285A
  [ "$(jqf '.status')" = "no-update" ]
  [ "$(jqf '.issue_number')" = "42" ]
  [ "$(jqf '.ir_count')" = "0" ]
  [ "$(jqf '.news_count')" = "0" ]
}

# 新規があれば status=ok で items を載せる
@test "status: new items yield ok with items and counts" {
  ISSUE_JSON="$(issue_with_cursors)" \
    PULL_IR_JSON='{"rows":[{"fetched_at":"2026-06-05T00:00:00Z","title":"IR1"},{"fetched_at":"2026-06-06T00:00:00Z","title":"IR2"}]}' \
    PULL_NEWS_JSON='{"rows":[{"fetched_at":"2026-06-07T00:00:00Z","title":"N1"}]}' run_ctx 285A
  [ "$(jqf '.status')" = "ok" ]
  [ "$(jqf '.ir_count')" = "2" ]
  [ "$(jqf '.news_count')" = "1" ]
  [ "$(jqf '.ir_items[0].title')" = "IR1" ]
  [ "$(jqf '.news_items[0].title')" = "N1" ]
  # 本文も同梱される (skill が gh を再度叩かずに書き換えられるように)
  [ "$(jqf '.issue_body | test("context here")')" = "true" ]
}

# === カーソル抽出 / 次カーソル算出 ==========================================

# 現行カーソルは body コメントから抽出される
@test "cursor: current cursors are extracted from body comment" {
  ISSUE_JSON="$(issue_with_cursors)" \
    PULL_IR_JSON='{"rows":[{"fetched_at":"2026-06-05T00:00:00Z"}]}' PULL_NEWS_JSON='{"rows":[]}' run_ctx 285A
  [ "$(jqf '.cursors.ir.current')" = "2026-06-01T00:00:00Z" ]
  [ "$(jqf '.cursors.news.current')" = "2026-06-02T00:00:00Z" ]
}

# 次カーソルは引いた行の max fetched_at。0 件の kind は現行カーソルを据え置く
@test "cursor: next is max fetched_at, zero-count kind keeps current" {
  ISSUE_JSON="$(issue_with_cursors)" \
    PULL_IR_JSON='{"rows":[{"fetched_at":"2026-06-05T00:00:00Z"},{"fetched_at":"2026-06-09T00:00:00Z"}]}' \
    PULL_NEWS_JSON='{"rows":[]}' run_ctx 285A
  # IR は新規があるので max=06-09 が次カーソル
  [ "$(jqf '.cursors.ir.next')" = "2026-06-09T00:00:00Z" ]
  # news は 0 件なので現行カーソル (06-02) を据え置く
  [ "$(jqf '.cursors.news.next')" = "2026-06-02T00:00:00Z" ]
}

# 初回 (body にカーソルコメントが無い) は current=null になる
@test "cursor: first run without comment has null current" {
  ISSUE_JSON='[{"number":7,"body":"first run, no cursor yet"}]' \
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
  ISSUE_JSON='[{"number":7,"body":"x"}]' \
    PULL_IR_JSON='garbage-not-json' PULL_NEWS_JSON='' run_ctx 285A
  [ "$(jqf '.status')" = "no-update" ]
  [ "$(jqf '.ir_count')" = "0" ]
  [ "$(jqf '.news_count')" = "0" ]
}
