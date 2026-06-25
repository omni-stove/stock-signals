#!/usr/bin/env bash
# scripts/watchlist-meta.sh
# worker/src/lib/watchlist.ts から 1 銘柄ぶんの判定メタ (name / fair_per / sector / note) を
# 抜き出して JSON 1 行で stdout に出す。
#
# 設計の意図:
#   watchlist.ts は静的な唯一のソースで、ランナーのチェックアウト済みコードベースに常にある。
#   judge 系は Worker /judge-context が D1 と一緒に同梱して渡すが、context-builder の入力は
#   /context-input (D1/R2 由来) で watchlist の静的メタを持たない。fetch する筋でもないので
#   (静的ファイルをコードベースから直に抜くだけ)、ここで .ts をパースして JSON を組み、
#   workflow がそれを context-input の JSON へマージして skill に渡す。これで skill は
#   watchlist.ts 全体 (全銘柄) を読まずに当該銘柄分だけ受け取れる。
#
# 入力:
#   $1 = ticker (必須)。watchlist.ts に無ければ非0で終了。
# 環境変数: WATCHLIST_FILE (任意。既定 = リポジトリ内 worker/src/lib/watchlist.ts)。
#
# 出力 (stdout): {"name":…, "fair_per":…|null, "sector":…|null, "note":…|null}
#   fair_per は数値か null、それ以外は文字列か null。
#
# パース方針: TICKERS は `{ … }` の銘柄オブジェクトが code 行で始まる素直な並び。対象 code の
#   行から次の銘柄境界 (`code:` 行) までを 1 ブロックとして切り、各フィールドを行 grep で拾う。
#   .ts の整形 (1 フィールド 1 行・末尾カンマ) に依存するため、書式が崩れたらテストが落ちる。

set -euo pipefail

TICKER="${1:?usage: watchlist-meta.sh <ticker>}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FILE="${WATCHLIST_FILE:-$ROOT/worker/src/lib/watchlist.ts}"
[[ -f "$FILE" ]] || { echo "watchlist-meta.sh: not found: $FILE" >&2; exit 1; }

# 対象 code の行番号。`code: "<TICKER>",` の形に厳密一致 (前後空白許容)。
# 未知 ticker は grep 0 件 (pipefail+set -e で即死せず) → エラーメッセージで落とす。
start="$({ grep -nE "^[[:space:]]*code:[[:space:]]*\"${TICKER}\",[[:space:]]*$" "$FILE" || true; } | head -1 | cut -d: -f1)"
[[ -n "$start" ]] || { echo "watchlist-meta.sh: unknown ticker: $TICKER" >&2; exit 1; }

# code 行から次の銘柄境界 (次の code: 行) の手前までを 1 銘柄ブロックとして切り出す。
# 次の code: が無ければ (末尾銘柄) ファイル終端まで。
next="$(awk -v s="$start" '
  NR > s && /^[[:space:]]*code:[[:space:]]*"[^"]+",[[:space:]]*$/ { print NR; exit }
' "$FILE")"
if [[ -n "$next" ]]; then
  block="$(sed -n "${start},$((next - 1))p" "$FILE")"
else
  block="$(sed -n "${start},\$p" "$FILE")"
fi

# クオート文字列フィールドの値を取り出す (無ければ空)。`<field>: "<value>",`。
# grep 不一致 (note 等の任意フィールド) は空文字を返したいので、パイプ全体を || true で受ける。
str_field() {
  printf '%s\n' "$block" \
    | { grep -E "^[[:space:]]*$1:[[:space:]]*\"" || true; } \
    | head -1 \
    | sed -E "s/^[[:space:]]*$1:[[:space:]]*\"(.*)\",?[[:space:]]*$/\1/"
}

# 裸の値フィールド (クオート無し) を取り出す。`<field>: <value>,` の <value> 部分。
# 値が "..." で囲まれた文字列でも null や数値でもそのまま返す。
raw_field() {
  printf '%s\n' "$block" \
    | { grep -E "^[[:space:]]*$1:[[:space:]]*" || true; } \
    | head -1 \
    | sed -E "s/^[[:space:]]*$1:[[:space:]]*//; s/,[[:space:]]*$//"
}

NAME="$(str_field name)"
NOTE="$(str_field note)"
SECTOR_RAW="$(raw_field sector)"   # `"semiconductor"` or `null`
FAIR_RAW="$(raw_field fair_per)"   # `20` or `null`

[[ -n "$NAME" ]] || { echo "watchlist-meta.sh: name not found for $TICKER" >&2; exit 1; }

# sector ("…" or null) と fair_per (数値 or null) は .ts の値表現がそのまま JSON として妥当なので
# --argjson にそのまま渡す。値が無い (空) ときだけ null に倒す。note は未設定 (空) なら null。
jq -nc \
  --arg name "$NAME" \
  --arg note "$NOTE" \
  --argjson sector "${SECTOR_RAW:-null}" \
  --argjson fair "${FAIR_RAW:-null}" \
  '{name:$name, fair_per:$fair, sector:$sector, note:(if $note=="" then null else $note end)}'
