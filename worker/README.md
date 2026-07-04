# 収集のクラウド化 (Cloudflare Worker)

データ収集とニュース判定を完全クラウド化した構成。Mac の cron が動かない
(権限/スリープ/電源) 問題を回避するため、収集を Cloudflare Worker + Cron Triggers に、
LLM 判定を GitHub Actions に移した。**ローカル常駐プロセスもローカル cron も持たない。**

- 収集: kabutan / kioxia をスクレイプ (IR / per_ticker ニュース / prices / daily / fundamentals / premarket / earnings)
- 保存: 記事本文JSON → **R2** (`ARTICLES`)、メタ・時系列・重複排除キー → **D1** (`DB`)
- 発火: Cron Triggers (下記) + 手動 `/run`
- 判定: 新規 IR/ニュースがあれば `repository_dispatch(signal-update)` で **GitHub Actions の context-builder** を起動する。判定ルールはワークフローの `prompt` にベタ書きされ、`/context-input` の正規化済み JSON を `@` で読んで銘柄ごとの **D1 コンテキスト** (`POST /context`、`contexts` テーブル) を再生成、`post-context.sh` が更新後の全文をセクション区切りの blocks で Slack のコンテキスト更新チャンネルへ投稿、続けて `repository_dispatch(signal-judge)` で signal-judge を起動。signal-judge が `/judge-context` を引いて buy/sell を構造化判定し、`post-signal.sh` が Slack へ通知しつつ `/slack/post` 経由でその判定を `signals` テーブルへ保存する (コンテキストは触らない)。
- 評価: 引け後 eod cron が `signals` の最新判定を各ユーザーの建玉 (`positions`) に当てて利確/損切り/継続を読み替え、本人へ DM する (`reviewPositions`)。

## エンドポイント

HTTP 層は `src/routes/` に分かれる。各ルートと用途はファイル冒頭コメントに書く
(ルーティングの一覧は `src/index.ts`)。収集系 (`/run`)・判定 prompt 用バンドル
(`/judge-context` `/context-input` `/market-context`)・Slack 連携 (`/slack/*`) などがある。

`/health` 以外は本番では `SYNC_TOKEN` を要求する (`Authorization: Bearer <token>` ヘッダ、
未設定なら認証なし)。

## Cron 割り当て (wrangler.toml [triggers], UTC基準)

Cloudflare の cron trigger 上限は **5個**。新規 cron は足せないので、ニュース収集と
決算予定日推定は既存 cron に相乗りさせている。発火した cron 式を `scheduled()` 内で
`event.cron` により判別し種別を振り分ける (`CRON_KIND`)。昼(12:30)の IR intake は
専用 cron を持たず prices ループに相乗りさせている (`event.scheduledTime` で昼スロットを判定)。

cron 式と JST の対応は `wrangler.toml [triggers]` のコメントに、種別ごとの収集内容は
`cron.ts` (`CRON_KIND` の振り分け) に書く。intake (寄り前/引け後)・prices (場中5分毎)・
eod (引け後) の3種で、寄り前は地合い、引け後は信用残や決算予定推定などを相乗りさせる。

## 本番デプロイ

`worker/**` への push で `.github/workflows/deploy-worker.yml` が wrangler deploy する
(`CLOUDFLARE_API_TOKEN` secret が必要)。初回のみ D1/R2 作成とスキーマ適用が手動:

```sh
cd worker
pnpm exec wrangler login                                  # ★ブラウザ認証
pnpm exec wrangler d1 create stock-signals                # ★ → database_id を wrangler.toml に記入
pnpm exec wrangler r2 bucket create stock-signals-articles # ★
pnpm run db:migrate:remote                                # リモートD1にmigration適用 (スキーマ変更時も)
pnpm exec wrangler deploy                                 # ★初回のみ手動。以降は push で自動
```

### コストの目安 (個人利用)
- Workers/Cron Triggers: 無料枠 10万リクエスト/日。
- D1: 無料枠 500万行読み取り/日、5GB。
- R2: 無料枠 10GB保存・Class A 100万/月。
→ 実質無料の見込み。

## Slack通知 / GitHub App (発火)

- **Slack**: 新規取得時・判定更新時に Webhook へ通知。`pnpm exec wrangler secret put SLACK_WEBHOOK_URL`
  (dev は `worker/.dev.vars`)。`curl .../test-slack` で疎通確認。未設定なら通知スキップ。
- **GitHub App (omnistove-internal-auth)**: 新規 IR/ニュースで context-builder を repository_dispatch
  で起動する。`GH_APP_PRIVATE_KEY` を Secret、`GH_APP_ID` / `GH_APP_INSTALL_ID` を wrangler.toml vars に。
  3つ揃っていなければ発火は no-op (収集自体は動く)。`curl .../dispatch-test?code=285A` で E2E 確認。

## D1 スキーマ (`src/lib/schema.ts` / drizzle-kit migration)

スキーマの唯一の情報源は `src/lib/schema.ts` (Drizzle 定義、各テーブルにコメント付き)。
手書き `schema.sql` は廃止し、drizzle-kit が差分 migration を `drizzle/` に生成する運用に移行した。

スキーマ変更フロー:

```sh
cd worker
# 1. src/lib/schema.ts を編集
pnpm db:generate                      # → drizzle/NNNN_<name>.sql に差分 SQL を生成 (内容を確認)
pnpm db:migrate:remote                # リモート D1 に適用 (push 時は deploy-worker.yml が自動適用)
```

差分 migration なので、テーブル追加は `CREATE TABLE`、列追加は `ALTER TABLE ADD COLUMN` だけが
生成される (全 DROP を伴う初期化スクリプトを流すことがなく、既存データが消えない)。PK 変更など
SQLite が直接サポートしない変更は drizzle-kit が「新テーブル作成→コピー→旧 DROP」の手順を生成する
ので、その場合だけ生成 SQL のレビューが要る。

> **既存 D1 のベースライン化**: drizzle-kit 導入前から存在する D1 は、初回 migration (`0000_init`) を
> 「適用済み」として登録してから運用に入る (そのまま apply すると "table already exists" で落ちるため)。
> 登録は管理テーブルに一行入れるだけ:
> `wrangler d1 execute stock-signals --remote --command "INSERT INTO d1_migrations (name, applied_at) VALUES ('0000_init.sql', CURRENT_TIMESTAMP);"`
> その後 `pnpm db:migrate:remote` が "No migrations to apply!" になれば同期完了。新規 D1 はこの手順不要
> (空の DB に `0000_init` がそのまま流れる)。

冪等性は複合 PRIMARY KEY が担保し、`INSERT OR IGNORE`/`OR REPLACE` で二重取得を弾く。
watchlist (4銘柄) と URL テンプレートは各 src (`timeseries.ts` / `news.ts` / `earnings.ts` の
`WATCHLIST` / `URL_*`) に写している (Worker は読み取り専用FSで yaml を持てないため)。

## 確認用スクリプト (ローカル、読み取り専用)

`scripts/valuation.ts` は Worker の `/latest` を叩いて fair_per からの必要修正率を表示する
(要 `WORKER_URL` 環境変数)。常駐ではなく手動実行。

需給イベント (SQ/指数リバランス/FOMC/日銀/ピア決算)・セクター相対強弱・数値正規化といった
決定論的な前処理はすべて Worker 側 (バンドルエンドポイントと `src/lib/`) に寄せてある。
判定はワークフローが `@` で正規化済み JSON を受け取り、解釈だけを行う。
