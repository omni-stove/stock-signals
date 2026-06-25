#!/usr/bin/env bats
# scripts/watchlist-meta.bats
# watchlist-meta.sh が watchlist.ts から 1 銘柄ぶんのメタを JSON で抜き出す挙動を検証する。
#
# 実行: pnpm run test:sh
#
# 設計:
#   - 既定は実ファイル (worker/src/lib/watchlist.ts) を対象に主要経路を見る。
#   - null フィールド (fair_per/sector が null、note 無し) は実データに無いので、WATCHLIST_FILE
#     注入口でフィクスチャを差し込んで検証する。
#   - @test の説明は ASCII のみ (bats 1.13 は非ASCIIのテスト名を実行できない)。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  SCRIPT="$ROOT/scripts/watchlist-meta.sh"
}

@test "args: missing ticker fails with usage" {
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
}

@test "unknown ticker fails" {
  run bash -c "bash \"\$1\" 9999 2>&1" _ "$SCRIPT"
  [ "$status" -ne 0 ]
  printf '%s\n' "$output" | grep -q "unknown ticker"
}

# note ありの銘柄: name/fair_per/sector/note が全て出る
@test "ticker with note: all fields populated" {
  run bash "$SCRIPT" 285A
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r .name)" = "キオクシアホールディングス" ]
  [ "$(printf '%s' "$output" | jq -r .fair_per)" = "20" ]
  [ "$(printf '%s' "$output" | jq -r .sector)" = "semiconductor" ]
  [ "$(printf '%s' "$output" | jq -r .note)" != "null" ]
}

# note なしの銘柄: note は JSON null
@test "ticker without note: note is null" {
  run bash "$SCRIPT" 6857
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r .name)" = "アドバンテスト" ]
  [ "$(printf '%s' "$output" | jq .note)" = "null" ]
}

# 末尾銘柄 (次の code: 境界が無い) もファイル終端まで切り出せる
@test "last ticker in file parses to end" {
  run bash "$SCRIPT" 6981
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r .name)" = "村田製作所" ]
  [ "$(printf '%s' "$output" | jq -r .fair_per)" = "30" ]
}

# fair_per が数値で出る (文字列化されない)
@test "fair_per is a JSON number" {
  run bash "$SCRIPT" 6920
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq '.fair_per | type')" = '"number"' ]
}

# fair_per: null / sector: null の銘柄はフィクスチャで検証する
@test "null fair_per and sector become JSON null (fixture)" {
  fixture="$BATS_TEST_TMPDIR/watchlist.ts"
  cat > "$fixture" <<'EOF'
export const TICKERS = [
	{
		code: "TEST",
		name: "テスト銘柄",
		sector: null,
		fair_per: null,
		news_url: "x",
	},
];
EOF
  run env WATCHLIST_FILE="$fixture" bash "$SCRIPT" TEST
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r .name)" = "テスト銘柄" ]
  [ "$(printf '%s' "$output" | jq .fair_per)" = "null" ]
  [ "$(printf '%s' "$output" | jq .sector)" = "null" ]
  [ "$(printf '%s' "$output" | jq .note)" = "null" ]
}

# sector_role を sector と取り違えない (前方一致の取りこぼし回帰)
@test "sector field is not confused with sector_role (fixture)" {
  fixture="$BATS_TEST_TMPDIR/watchlist.ts"
  cat > "$fixture" <<'EOF'
export const TICKERS = [
	{
		code: "TEST",
		name: "テスト銘柄",
		sector: "semiconductor",
		sector_role: "memory",
		fair_per: 20,
		news_url: "x",
	},
];
EOF
  run env WATCHLIST_FILE="$fixture" bash "$SCRIPT" TEST
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r .sector)" = "semiconductor" ]
}
