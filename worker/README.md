# 収集のクラウド化 (Cloudflare Worker)

データ収集とニュース判定を完全クラウド化した構成。Mac の cron が動かない
(権限/スリープ/電源) 問題を回避するため、収集を Cloudflare Worker + Cron Triggers に、
LLM 判定を GitHub Actions に移した。**ローカル常駐プロセスもローカル cron も持たない。**

- 収集: kabutan / kioxia をスクレイプ (IR / per_ticker ニュース / prices / daily / fundamentals / premarket / earnings)
- 保存: 記事本文JSON → **R2** (`ARTICLES`)、メタ・時系列・重複排除キー → **D1** (`DB`)
- 発火: Cron Triggers (下記) + 手動 `/run`
- 判定: 新規 IR/ニュースがあれば `repository_dispatch(signal-update)` で **GitHub Actions の context-builder** を起動 (`.claude/skills/context-builder`)。context-builder が `/pull` `/pull-news` で材料を引いて銘柄ごとの **D1 コンテキスト** (`POST /context`、`contexts` テーブル) を更新し、更新後の本文全文を Slack のコンテキスト更新チャンネルへ投稿、続けて `repository_dispatch(signal-judge)` で signal-judge を起動。signal-judge が `/latest` と `/context` を引いて buy/sell を判定し Slack へ通知 (コンテキストは触らない)。

## エンドポイント

HTTP 層は `src/routes/` に分かれる。各ルートと用途はファイル冒頭コメントに書く
(ルーティングの一覧は `src/index.ts`)。収集系 (`/run`)・skill 用バンドル
(`/judge-context` `/context-input` `/market-context`)・Slack 連携 (`/slack/*`) などがある。

`/health` 以外は本番では `SYNC_TOKEN` を要求する (`Authorization: Bearer <token>` ヘッダ、
dev/未設定なら認証なし)。

## Cron 割り当て (wrangler.toml [triggers], UTC基準)

Cloudflare の cron trigger 上限は **5個**。新規 cron は足せないので、ニュース収集と
決算予定日推定は既存 cron に相乗りさせている。発火した cron 式を `scheduled()` 内で
`event.cron` により判別し種別を振り分ける (`CRON_KIND`)。昼(12:30)の IR intake は
専用 cron を持たず prices ループに相乗りさせている (`event.scheduledTime` で昼スロットを判定)。

cron 式と JST の対応は `wrangler.toml [triggers]` のコメントに、種別ごとの収集内容は
`cron.ts` (`CRON_KIND` の振り分け) に書く。intake (寄り前/引け後)・prices (場中5分毎)・
eod (引け後) の3種で、寄り前は地合い、引け後は信用残や決算予定推定などを相乗りさせる。

## ローカル検証 (ログイン・デプロイ不要、課金なし)

D1=ローカルSQLite、R2=ローカルFS をエミュレートする。

```sh
cd worker
pnpm install
pnpm run db:init:local                # ローカルD1にスキーマ適用
pnpm exec wrangler dev --port 8799
# 別ターミナル:
curl "http://localhost:8799/health"
curl "http://localhost:8799/run?kind=ir&code=285A&limit=3"
curl "http://localhost:8799/run?kind=news&code=285A"
curl "http://localhost:8799/run?kind=earnings&code=285A"
curl "http://localhost:8799/latest?kind=ir&code=285A&n=5"
```

## 本番デプロイ

`worker/**` への push で `.github/workflows/deploy-worker.yml` が wrangler deploy する
(`CLOUDFLARE_API_TOKEN` secret が必要)。初回のみ D1/R2 作成とスキーマ適用が手動:

```sh
cd worker
pnpm exec wrangler login                                  # ★ブラウザ認証
pnpm exec wrangler d1 create stock-signals                # ★ → database_id を wrangler.toml に記入
pnpm exec wrangler r2 bucket create stock-signals-articles # ★
pnpm run db:init:remote                                   # リモートD1にスキーマ適用 (スキーマ変更時も)
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

## D1 スキーマ (`schema.sql`)

全テーブルの定義は `schema.sql` を見る (各テーブルにコメント付き)。

冪等性は複合 PRIMARY KEY が担保し、`INSERT OR IGNORE`/`OR REPLACE` で二重取得を弾く。
watchlist (4銘柄) と URL テンプレートは各 src (`timeseries.ts` / `news.ts` / `earnings.ts` の
`WATCHLIST` / `URL_*`) に写している (Worker は読み取り専用FSで yaml を持てないため)。

## 確認用スクリプト (ローカル、読み取り専用)

`scripts/valuation.ts` は Worker の `/latest` を叩いて fair_per からの必要修正率を表示する
(要 `WORKER_URL` 環境変数)。常駐ではなく手動実行。

需給イベント (SQ/指数リバランス/FOMC/日銀/ピア決算)・セクター相対強弱・数値正規化といった
決定論的な前処理はすべて Worker 側 (バンドルエンドポイントと `src/lib/`) に寄せてある。
skill は curl 1 発で正規化済み JSON を受け取り、解釈だけを行う。
