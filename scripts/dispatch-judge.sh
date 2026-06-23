#!/usr/bin/env bash
# scripts/dispatch-judge.sh
# 単一銘柄の signal-judge ワークフローを repository_dispatch で発火するだけの小物。
#
# 設計の意図:
#   context-builder は「新規 IR/ニュースがあったときだけ」コンテキストを育てる (no-update の
#   日は本文も Slack も触らない)。一方で判定 (signal-judge) は、新規が無い銘柄でも価格/地合いの
#   変化を毎営業日ひろって回したい。そこで判定の発火を context 更新から切り離し、context-builder
#   ワークフローが skill 実行後に「新規有無に関わらず必ず 1 回」このスクリプトを呼ぶ構成にした。
#   発火を post-context.sh (= 新規があったときだけ走る) に置いたままだと no-update の日に
#   判定が回らないため、発火経路をここに一本化している。
#
# 入力:
#   $1 = ticker (必須)
# 環境変数: GITHUB_REPOSITORY (必須。未設定=ローカル等なら発火スキップして正常終了)。
#           GH_TOKEN は gh が参照する (ワークフローでは github.token を渡す)。
#
# 出力 (stdout): signal-judge dispatched | signal-judge skipped (no GITHUB_REPOSITORY) |
#               signal-judge dispatch failed。
# テスト用の注入口: DISPATCH_JUDGE_DRYRUN=1 で gh を叩かず "GH <args>" を stderr に出す。
#   gh 単体を差し替えたいときは DISPATCH_JUDGE_GH も使える。

set -euo pipefail

TICKER="${1:?usage: dispatch-judge.sh <ticker>}"

GH="${DISPATCH_JUDGE_GH:-gh}"
if [[ "${DISPATCH_JUDGE_DRYRUN:-}" == "1" ]]; then
  GH="dryrun_gh"
fi
dryrun_gh() { printf 'GH %s\n' "$*" >&2; }

# GITHUB_REPOSITORY 未設定 (ローカル等) なら発火しない。run は失敗させない。
if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
  "$GH" api "repos/${GITHUB_REPOSITORY}/dispatches" \
    -f event_type=signal-judge \
    -F "client_payload[ticker]=${TICKER}" \
    && echo "signal-judge dispatched" || echo "signal-judge dispatch failed"
else
  echo "signal-judge skipped (no GITHUB_REPOSITORY)"
fi
