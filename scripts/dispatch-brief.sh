#!/usr/bin/env bash
# scripts/dispatch-brief.sh
# 単一銘柄の ticker-brief ワークフローを repository_dispatch で発火するだけの小物。
#
# 設計の意図:
#   context-builder が status=ok (新規 IR/ニュースを取り込んでコンテキストを再生成した) を返した回と、
#   Worker の intake が brief=true を載せた定時の回に発火する。新着が無い定時の回は --no-fresh で
#   client_payload.fresh=false を載せ、ticker-brief が簡易版にする。呼び出し条件の判定は
#   context-builder ワークフローの dispatch ステップが行い、ここは発火だけを担う。
#   post-context.sh には発火を置かない (発火経路をここに一本化)。
#
# 入力:
#   $1 = ticker (必須)
#   $2 = --no-fresh (任意。新着材料なしの定時ブリーフ)
# 環境変数: GITHUB_REPOSITORY (必須。未設定=ローカル等なら発火スキップして正常終了)。
#           GH_TOKEN は gh が参照する (ワークフローでは github.token を渡す)。
#
# 出力 (stdout): ticker-brief dispatched | ticker-brief skipped (no GITHUB_REPOSITORY) |
#               ticker-brief dispatch failed。
# テスト用の注入口: DISPATCH_BRIEF_DRYRUN=1 で gh を叩かず "GH <args>" を stderr に出す。
#   gh 単体を差し替えたいときは DISPATCH_BRIEF_GH も使える。

set -euo pipefail

TICKER="${1:?usage: dispatch-brief.sh <ticker> [--no-fresh]}"
FRESH=true
case "${2:-}" in
  "") ;;
  --no-fresh) FRESH=false ;;
  *) echo "usage: dispatch-brief.sh <ticker> [--no-fresh]" >&2; exit 2 ;;
esac

GH="${DISPATCH_BRIEF_GH:-gh}"
if [[ "${DISPATCH_BRIEF_DRYRUN:-}" == "1" ]]; then
  GH="dryrun_gh"
fi
dryrun_gh() { printf 'GH %s\n' "$*" >&2; }

# GITHUB_REPOSITORY 未設定 (ローカル等) なら発火しない。run は失敗させない。
if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
  "$GH" api "repos/${GITHUB_REPOSITORY}/dispatches" \
    -f event_type=ticker-brief \
    -F "client_payload[ticker]=${TICKER}" \
    -F "client_payload[fresh]=${FRESH}" \
    && echo "ticker-brief dispatched" || echo "ticker-brief dispatch failed"
else
  echo "ticker-brief skipped (no GITHUB_REPOSITORY)"
fi
