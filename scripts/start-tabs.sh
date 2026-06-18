#!/usr/bin/env bash
# cmux で route-news + 各銘柄 analyze-ticker のタブを一括起動する想定。
#
# cmux のCLIインターフェイスはまだ未確定なので、ここはプレースホルダ。
# 実コマンドは cmux 側のセッション設定に置き換える。
#
# 例(イメージ):
#   cmux new-window -n route   'cd "$(dirname "$0")/.." && claude /route-news'
#   cmux new-window -n 6857    'cd "$(dirname "$0")/.." && claude /analyze-ticker 6857'
#   cmux new-window -n 6920    'cd "$(dirname "$0")/.." && claude /analyze-ticker 6920'
#   cmux new-window -n 285A    'cd "$(dirname "$0")/.." && claude /analyze-ticker 285A'
#   cmux new-window -n 6981    'cd "$(dirname "$0")/.." && claude /analyze-ticker 6981'

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "ROOT=$ROOT"
echo "TODO: cmux の起動コマンドに置き換える"
