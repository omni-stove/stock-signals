# scripts/

| 拡張子 | 実行場所 | 依存 |
|--------|----------|------|
| `*.sh` | GitHub Actions の step | なし (GNU date / grep) |
| `*.ts` | ローカルで人間が実行 | Node + `pnpm install` |

Actions に Node ランタイムを持ち込まない方針なので、**workflow から呼ぶ前処理は `*.sh`** で書く
(ubuntu に最初から入っている GNU `date` / `grep` だけで完結させる)。`*.ts` はローカルの確認用ツールで、
Worker から引いて表を出すだけ — Actions からは呼ばない。

## ファイル

**`event-context.sh`** (Actions 用) — SQ (日本=第2金 / 米=第3金 / 3・6・9・12月=メジャー) を日付から
計算し「SQ週」(当週=歪む) と「SQ明け」(翌週=歪み剥落) の2フェーズで出力。`config/events.yaml` の
近接イベントを grep で合体して 1 行に整形。`signal-judge.yml` が起動時に
走らせ prompt へ渡す。GNU date 前提。macOS で試すなら `brew install coreutils` して
`DATE=gdate bash scripts/event-context.sh 2026-09-14`。

ローカル確認用 (`WORKER_URL` 必須):
- **`events.ts`** (`pnpm events`) — events.yaml のイベントを直近 N 日で一覧表示 (`--days` / `--all` / `--json`)
- **`sector.ts`** (`pnpm sector`) — セクター地合い (SOX) とセクター内相対強弱
- **`valuation.ts`** (`pnpm valuation`) — 株価・PER・EPS と fair_per からの必要修正率
