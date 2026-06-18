# 収集のクラウド化 (Cloudflare Worker) — PoC: fetch-ir

Mac の cron が動かない (権限/スリープ/電源) 問題を回避するため、データ収集を
Cloudflare Worker + Cron Triggers に移す。**第1段として IR取得だけ** を Worker 化した。

- 取得: `kioxia.com/ja-jp/news.html` をスクレイプ (ローカル `scripts/fetch-ir.ts` と同じ解析)
- 保存: 記事本文JSON → **R2** (`ARTICLES`)、メタ+重複排除キー → **D1** (`DB`)
- 発火: Cron Triggers (JST 8:30/12:30/18:30) + 手動 `/run`
- LLM判定 (analyze-ticker) はクラウド化しない。ローカルが R2/D1 を読みに行く (下記「ローカル連携」)。

## ローカル検証 (ログイン・デプロイ不要、課金なし)

D1=ローカルSQLite、R2=ローカルFS をエミュレートする。

```sh
cd worker
npm install
npm run db:init:local                 # ローカルD1にスキーマ適用
npx wrangler dev --port 8799          # 別プロジェクトと衝突する場合はポート変更
# 別ターミナル:
curl "http://localhost:8799/health"               # → ok
curl "http://localhost:8799/run?code=285A&limit=3" # → 取得→R2/D1保存
curl "http://localhost:8799/latest?code=285A&n=5"  # → D1から最新メタ
```

検証済み: found=626 / 新着3件を written / 再実行で skipped=3 (重複排除OK) / R2に本文JSON保存。

## 本番デプロイ (★ユーザー操作が必要)

`★` の付いたコマンドはブラウザ認証や課金リソース作成を伴うため、セッションで
`! <command>` の形で自分で実行する (Claude は対話ログインを代行できない)。

```sh
cd worker

# 1. ★Cloudflareにログイン (ブラウザが開く)
npx wrangler login

# 2. ★D1データベースを作成 → 出力された database_id を wrangler.toml に記入
npx wrangler d1 create stock-signals
#   → wrangler.toml の database_id = "PLACEHOLDER_RUN_D1_CREATE" を実IDに置換

# 3. ★R2バケットを作成 (R2は無料枠あり。要R2有効化)
npx wrangler r2 bucket create stock-signals-articles

# 4. リモートD1にスキーマ適用
npm run db:init:remote

# 5. ★デプロイ (Worker + Cron Triggers が有効になる)
npx wrangler deploy

# 6. 動作確認 (デプロイ後のURLに対して)
curl "https://stock-signals-collector.<your-subdomain>.workers.dev/run?code=285A&limit=3"
```

### コストの目安 (個人利用)
- Workers/Cron Triggers: 無料枠 10万リクエスト/日。IR取得は1日3回×数リクエストなので余裕。
- D1: 無料枠 500万行読み取り/日、5GB。記事メタのみなので余裕。
- R2: 無料枠 10GB保存・Class A 100万/月。記事JSONは小さく余裕。
→ PoC〜実運用初期は **実質無料** の見込み。

## Slack通知

新規IRを取得 (written) したとき、その記事を Slack にまとめて1通通知する。
holdings(適時開示) を先頭に寄せて強調。Webhook未設定なら通知はスキップ (取得は動く)。

### Webhook URL の取得
1. https://api.slack.com/apps → Create New App → From scratch (ワークスペース選択)
2. Incoming Webhooks → Activate On → Add New Webhook to Workspace → チャンネル選択
3. 生成された `https://hooks.slack.com/services/...` をコピー

### 設定
```sh
# dev検証 (worker/.dev.vars、gitignore済み):
echo 'SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."' > worker/.dev.vars

# 本番 (Secret):
npx wrangler secret put SLACK_WEBHOOK_URL   # プロンプトにURLを貼る
```

### 疎通確認
```sh
curl "http://localhost:8799/test-slack"   # ダミー1件を実際にSlackへ送る
```

## ローカル連携

方針: **判定 (analyze-ticker) はローカルのまま、収集だけクラウド** (本ファイル冒頭の通り)。
クラウドが D1 に集めた時系列データを、Mac 起動時にローカル jsonl へ引き戻す。読み手
(`valuation.ts`/`sector.ts`/`analyze-ticker`) のロジックは一切変えない。

### 時系列 (prices/daily/fundamentals): D1 → jsonl 同期 ✅
- Worker の **`/dump?kind=...&code=...`** が「ローカル jsonl と同じ列・古い順」で ndjson を返す。
- ローカルの **`scripts/sync-from-d1.ts`** がそれを GET し `data/<kind>/<code>.jsonl` を丸ごと置換
  (D1 が source of truth)。
```sh
# dev (ローカルWorker) に対して
WORKER_URL=http://localhost:8800 node scripts/sync-from-d1.ts
# 本番。SYNC_TOKEN を設定している場合は環境変数で渡す
WORKER_URL=https://stock-signals-collector.<sub>.workers.dev SYNC_TOKEN=... node scripts/sync-from-d1.ts
# cron 例 (Mac 起動時/読む直前): logs/sync.log に追記
```
検証済み (2026-06-18): sync で206行復元・errors=0、285A 最終値が D1 の最新 (06-18 12:51) に更新、
`valuation.ts`/`sector.ts` がそのまま読めることを確認。5分枠重複は D1 正規化済み (6行→4行)。

`/dump` は本番(公開URL)では **`SYNC_TOKEN`** を要求する (`npx wrangler secret put SYNC_TOKEN`、
dev/未設定なら認証なし)。

### IR記事 (R2/D1 → 判断): `/pull` で本文込み取得 ✅
Worker の **`/pull?code=285A&since=<ISO8601>&limit=N`** が「`since` (= 前回処理カーソル) より後に
取得した未処理IRだけ」を **本文(R2)込み・`fetched_at` 昇順** で返す (`/latest` はメタのみ・published_at 順
なのに対し、こちらは判断に必要な本文を同梱し取りこぼさないカーソル順)。`since` 省略時は直近 limit 件。
公開URLでは `/dump` と同様 `SYNC_TOKEN` を要求する。
- 用途: GitHub Actions の **ir-report** (`.github/workflows/ir-report.yml` + `.claude/skills/ir-report`) が
  これを叩いて新規IRだけを判断し、銘柄ごとの常設Issue (企業レポート) を更新 → Slack通知する。
- ローカルの analyze-ticker(常駐)に R2本文を流し込む同期は引き続き別途 (必要なら `/pull` を流用可)。

## 時系列データ (prices / daily / fundamentals) — Worker化済み

価格・日足・ファンダの3系統を Worker に移植した (`src/timeseries.ts`)。ローカルの
`data/{prices,daily,fundamentals}/<code>.jsonl` (append-only) は、R2 では追記できない
(R2はオブジェクト上書きのみ) ため **D1 テーブル** に置く。冪等性は複合 PRIMARY KEY が担保し、
`INSERT OR IGNORE`/`OR REPLACE` だけで二重取得を弾く (ローカルの seen.txt / loadKnownDates 相当)。

- **prices**: PK `(ticker, slot)`。slot = 値付き時刻 (無ければ取得時刻) を **5分枠に丸めた**キー。
  「5分毎 cron で1枠1行」を保証 (分単位で動く quote_time をそのまま使うと最大390行/日に膨らむため)。
- **daily**: PK `(ticker, date)`。30営業日分を batch INSERT、重複日付は PK で自動スキップ。
- **fundamentals**: PK `(ticker, date)`。同日複数回は `OR REPLACE` で最新値に更新。

watchlist (4銘柄) と URL テンプレートは `src/timeseries.ts` の `WATCHLIST` / `URL_*` に写している。

### 手動検証 (dev)
```sh
npx wrangler dev --port 8800 --local
curl "http://localhost:8800/run?kind=prices&code=285A"        # 1銘柄取得
curl "http://localhost:8800/run?kind=prices"                  # watchlist全件
curl "http://localhost:8800/run?kind=daily&code=285A"
curl "http://localhost:8800/run?kind=fundamentals&code=6857"
curl "http://localhost:8800/latest?kind=prices&code=285A&n=3" # D1から最新行
```
検証済み (2026-06-18): prices price/change/PTS パースOK・同一5分枠で skipped=1 (冪等OK) /
daily 30行 written / fundamentals per=47.2 forecast_eps=642.2 取得OK。

### 過去 jsonl → D1 移行 (`migrate-jsonl.ts`)
既存の `data/{prices,daily,fundamentals}/<code>.jsonl` を、Worker と同じスキーマ・同じ
冪等規則 (prices の5分枠 slot、daily/fundamentals の date キー) で SQL に変換して流し込む。
```sh
cd worker
node migrate-jsonl.ts > /tmp/migrate.sql                                # SQL生成 (確認用)
npx wrangler d1 execute stock-signals --local  --file=/tmp/migrate.sql  # ローカルD1へ
npx wrangler d1 execute stock-signals --remote --file=/tmp/migrate.sql  # 本番D1へ (デプロイ後)
```
`INSERT OR IGNORE`/`OR REPLACE` なので、ローカル収集と D1 が同じデータを二重に取り込んでも
冪等 (件数は増えない)。検証済み (2026-06-18): prices 19行→14行 (5分枠重複を圧縮) /
daily 180行 / fundamentals 10行 / 再投入で件数不変 (冪等OK)。
※ wrangler の SQL パーサは先頭コメント・BEGIN/COMMIT を嫌うので付けていない。

### Cron 割り当て (wrangler.toml [triggers], UTC基準)
発火した cron 式を `scheduled()` 内で `event.cron` により判別し種別を振り分ける (`CRON_KIND`)。
- `*/5 0-6 * * *` (JST 09:00-15:00 5分毎) → prices
- `0 7 * * *` (JST 16:00) → daily / `5 7 * * *` (JST 16:05) → fundamentals
- IR は従来通り 3回。

## 残タスク (このPoCの次)
- [ ] 残りの fetch をWorker化 (news/premarket/earnings-date)
      ※ earnings-date は watchlist.yaml (Git管理ファイル) への書き戻しが要るため、
        書き戻し先を D1 等に変える設計が別途必要 (Worker は読み取り専用FS)。
- [ ] ir定義を wrangler.toml の vars かD1に逃がし、複数銘柄対応 (今は src/index.ts に直書き)
- [ ] Cron の曜日を JST 月-金 に厳密化 (現状 crons は UTC 毎日)
- [x] ローカル連携 (時系列) — `/dump` + `scripts/sync-from-d1.ts` で D1 → jsonl 同期 (読み手は無改修)
- [ ] ローカル連携 (IR記事) — R2本文を data/queue へ落とし analyze-ticker に渡す
- [x] 過去 jsonl → D1 への移行スクリプト (`migrate-jsonl.ts`、ローカルD1へ投入済み)
- [ ] kioxia 以外の site パーサ (IR)
