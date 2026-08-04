#!/usr/bin/env bash
# scripts/dispatch-brief.sh
# 単一銘柄の ticker-brief ワークフローを repository_dispatch で発火するだけの小物。
#
# 設計の意図:
#   材料ブリーフは新着材料の解説なので、context-builder が status=ok (新規 IR/ニュースを取り込んで
#   コンテキストを再生成した) を返した回だけ発火する。呼び出し条件の判定 (status の分岐) は
#   context-builder ワークフローの dispatch ステップが行い、ここは発火だけを担う。
#   post-context.sh には発火を置かない (発火経路をここに一本化)。
#
# 入力:
#   $1 = ticker (必須)
# 環境変数: GITHUB_REPOSITORY (必須。未設定=ローカル等なら発火スキップして正常終了)。
#           GH_TOKEN は gh が参照する (ワークフローでは github.token を渡す)。
#
# 出力 (stdout): ticker-brief dispatched | ticker-brief skipped (no GITHUB_REPOSITORY) |
#               ticker-brief dispatch failed。
# テスト用の注入口: DISPATCH_BRIEF_DRYRUN=1 で gh を叩かず "GH <args>" を stderr に出す。
#   gh 単体を差し替えたいときは DISPATCH_BRIEF_GH も使える。

set -euo pipefail

TICKER="${1:?usage: dispatch-brief.sh <ticker>}"

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
    && echo "ticker-brief dispatched" || echo "ticker-brief dispatch failed"
else
  echo "ticker-brief skipped (no GITHUB_REPOSITORY)"
fi
