# 収集のクラウド化 (Cloudflare Worker)

データ収集とニュース判定を完全クラウド化した構成。Mac の cron が動かない
(権限/スリープ/電源) 問題を回避するため、収集を Cloudflare Worker + Cron Triggers に、
LLM 判定を GitHub Actions に移した。**ローカル常駐プロセスもローカル cron も持たない。**

- 収集: kabutan / kioxia をスクレイプ (IR / per_ticker ニュース / prices / daily / fundamentals / premarket / earnings)
- 保存: 記事本文JSON → **R2** (`ARTICLES`)、メタ・時系列・重複排除キー → **D1** (`DB`)
- 発火: Cron Triggers (下記) + 手動 `/run`
- 判定: 新規 IR/ニュースがあれば `repository_dispatch(signal-update)` で **GitHub Actions の signal-report** を起動 (`.claude/skills/signal-report`)。Actions が `/pull` `/pull-news` `/latest` で材料を引いて判定し、銘柄ごとの Issue を更新。

## エンドポイント

| ルート | 用途 |
|---|---|
| `/health` | 疎通確認 (無認証) |
| `/run?kind=ir\|news\|prices\|daily\|fundamentals\|earnings\|premarket&code=&[dispatch=1]` | 手動収集。`dispatch=1` で新規があれば signal-report 起動 |
| `/pull?code=&since=&limit=` | IR だけ (source LIKE 'ir:%') を本文込み・fetched_at 昇順で返す |
| `/pull-news?code=&since=&limit=` | per_ticker ニュースだけ (source LIKE 'kabutan:%') を本文込みで返す |
| `/latest?kind=&code=&n=` | D1 から最新行 (prices/daily/fundamentals は時系列、premarket/earnings/ir も対応) |
| `/dispatch-test?code=` | App認証→repository_dispatch の E2E 確認 (収集せず強制発火) |
| `/test-slack` | Slack Webhook 疎通確認 |

`/health` 以外は本番では `SYNC_TOKEN` を要求する (`Authorization: Bearer <token>` ヘッダ、
dev/未設定なら認証なし)。

## Cron 割り当て (wrangler.toml [triggers], UTC基準)

Cloudflare の cron trigger 上限は **5個**。新規 cron は足せないので、ニュース収集と
決算予定日推定は既存 cron に相乗りさせている。発火した cron 式を `scheduled()` 内で
`event.cron` により判別し種別を振り分ける (`CRON_KIND`)。

| cron (UTC) | JST | 種別 | 内容 |
|---|---|---|---|
| `30 23 * * *` | 08:30 | ir | IR + ニュース収集 → 新規あれば signal-report |
| `30 3 * * *` | 12:30 | ir | 同上 |
| `30 9 * * *` | 18:30 | ir | 同上 |
| `*/5 0-6 * * *` | 09:00-15:00 5分毎 | prices | prices + ニュース速報 → 新規ニュースで signal-report |
| `0 7 * * *` | 16:00 | eod | daily + fundamentals + earnings(次回決算予定日推定) |

## ローカル検証 (ログイン・デプロイ不要、課金なし)

D1=ローカルSQLite、R2=ローカルFS をエミュレートする。

```sh
cd worker
npm install
npm run db:init:local                 # ローカルD1にスキーマ適用
npx wrangler dev --port 8799
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
npx wrangler login                                  # ★ブラウザ認証
npx wrangler d1 create stock-signals                # ★ → database_id を wrangler.toml に記入
npx wrangler r2 bucket create stock-signals-articles # ★
npm run db:init:remote                              # リモートD1にスキーマ適用 (スキーマ変更時も)
npx wrangler deploy                                 # ★初回のみ手動。以降は push で自動
```

### コストの目安 (個人利用)
- Workers/Cron Triggers: 無料枠 10万リクエスト/日。
- D1: 無料枠 500万行読み取り/日、5GB。
- R2: 無料枠 10GB保存・Class A 100万/月。
→ 実質無料の見込み。

## Slack通知 / GitHub App (発火)

- **Slack**: 新規取得時・判定更新時に Webhook へ通知。`npx wrangler secret put SLACK_WEBHOOK_URL`
  (dev は `worker/.dev.vars`)。`curl .../test-slack` で疎通確認。未設定なら通知スキップ。
- **GitHub App (omnistove-internal-auth)**: 新規 IR/ニュースで signal-report を repository_dispatch
  で起動する。`GH_APP_PRIVATE_KEY` を Secret、`GH_APP_ID` / `GH_APP_INSTALL_ID` を wrangler.toml vars に。
  3つ揃っていなければ発火は no-op (収集自体は動く)。`curl .../dispatch-test?code=285A` で E2E 確認。

## D1 スキーマ (`schema.sql`)

| テーブル | キー | 内容 |
|---|---|---|
| `articles` | url (PK) | IR + ニュースのメタ。source で振り分け (ir:.. / kabutan:..)。本文は R2 |
| `prices` | (ticker, slot) | 5分枠スナップショット (slot=5分丸め冪等キー) |
| `daily` | (ticker, date) | 日足 OHLC |
| `fundamentals` | (ticker, date) | 予想PER/EPS・実績EPS |
| `premarket_backdrop` | date (PK) | 前夜の地合い (SOX/Nasdaq/Dow/日経先物) |
| `earnings` | ticker (PK) | 次回決算発表予定日の推定 (watchlist.yaml の代替 source of truth) |

冪等性は複合 PRIMARY KEY が担保し、`INSERT OR IGNORE`/`OR REPLACE` で二重取得を弾く。
watchlist (4銘柄) と URL テンプレートは各 src (`timeseries.ts` / `news.ts` / `earnings.ts` の
`WATCHLIST` / `URL_*`) に写している (Worker は読み取り専用FSで yaml を持てないため)。

## 確認用スクリプト (ローカル、読み取り専用)

`scripts/valuation.ts` / `sector.ts` は Worker の `/latest` を叩いて表示する
(要 `WORKER_URL` 環境変数)。`scripts/events.ts` は `config/events.yaml` を読む。常駐ではなく手動実行。
