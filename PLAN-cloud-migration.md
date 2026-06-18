# ローカル起動の廃止とニュース判定のクラウド化 — 実装計画

## ゴール

ローカル起動(Mac cron 収集 + cmux 常駐 Claude Code)を完全に廃止し、
**収集を Cloudflare Worker、LLM 判定を GitHub Actions** に一本化する。
ニュース判定(旧 route-news + analyze-ticker)もクラウドで完結させる。

## 確定した設計判断(対話で決定済み)

1. **出力 = 銘柄ごとの判定 Issue 1 本**。IR/News をソース別に分けない。両方を入力とする統合判定。
2. **トリガー = 新着で即発火・毎回フル判定**。IR or per_ticker ニュースの新着が引き金。
   判定は常にその銘柄の IR + ニュース両方の最新状態を読む。
3. **カーソル方式**。判定 Issue に IR 用・News 用 2 つの `last_fetched_at` を持ち、
   `since` 以降だけ Worker から引く。中断されてもカーソル未更新 → 取りこぼしゼロ(冪等)。
4. **中断 = concurrency + cancel-in-progress**。銘柄ごとに別ジョブ。
   skill は最後に Issue を一括上書きして原子性に近づける。
5. **macro ニュースは収集しない**。地合いは premarket(SOX/Nasdaq/Dow/日経先物)+ events で十分。
6. **寄前気配(kehai)も廃止**。スイング判定に板の偏りは効かず、滅多に埋まらない。
   ※ Worker premarket は元々 kehai 未移植(`premarket.ts:10`)。ローカル削除で自然消滅。

## 判定の入力(確定)

| 入力 | 由来 | 状態 |
|---|---|---|
| IR(一次情報) | Worker `/pull` | 既存 |
| per_ticker ニュース | Worker `/pull-news`(新規) | 移植 |
| 価格/日足/ファンダ | Worker `/latest` | 既存 |
| 地合い premarket | Worker `/latest?kind=premarket` | 既存 |
| イベント(FOMC/SQ 等) | `config/events.yaml` | 既存 |

---

## 作業 1: Worker に per_ticker ニュース収集を追加

検証済み: cheerio は Worker 動作実証あり、kabutan は全 UTF-8 で iconv 不要、
重複排除は D1 の url PK + INSERT OR IGNORE で代替可。

- `worker/src/news.ts`(新規): `scripts/fetch-news.ts` の per_ticker 部分を移植。
  - `fetchHtml` を `TextDecoder("utf-8")` 版に(iconv 除去)。
  - `parseKabutanList` / `parseKabutanArticle` を流用。
  - 出力は既存 `saveArticle` パターン(R2 本文 + D1 `articles`)。
  - `source = "kabutan:<code>"`(IR は `ir:kioxia:<code>` なので区別可)。`ir_category` は NULL。
  - watchlist(WATCHLIST 定数)から news_url を生成。macro は収集しない。
- `worker/src/index.ts`:
  - `/run?kind=news[&code=]` を追加(手動収集)。
  - `/pull-news?code=&since=&limit=&token=` を追加(`/pull` とほぼ同型、`source` が `kabutan:` のものだけ)。
  - scheduled handler: 既存 IR cron に相乗りでニュースも収集(cron 5 枠維持)。
    新規ニュース or 新規 IR があった銘柄を集約して dispatch。
  - `dispatchIrReport` → `dispatchSignalUpdate`(event_type を `signal-update` に)。

## 作業 1b: earnings-date 自動更新を Worker に移植

- `scripts/fetch-earnings-date.ts` の kabutan 四半期テーブル解析を Worker に移植。
  「直近実績の次四半期 = 前年同期の発表日 +1年」で推定。
- eod cron(JST 16:00)に相乗りで実行。
- 保存先: D1 に earnings 日付テーブルを追加 or premarket 同様の小テーブル。
  判定 skill は `/latest?kind=earnings&code=` 等で読む。
  (※ watchlist.yaml への書き戻しは Worker からはできないので、D1 を source にする)

## 作業 2: 判定を 2 段に分離(context-builder → signal-judge)

判定を 1 つの skill に統合するのではなく、**コンテキストを育てる役**と
**コンテキストを読んで判定する役**に分離する(実装で確定した設計)。

### 2a. context-builder skill(`agents/skills/context-builder/`)— 前段

Issue 本文を「銘柄の持続コンテキスト」に育てる。判定 (buy/sell/hold) は出さない。

- Issue 本文から 2 カーソル(`ir_last_fetched_at` / `news_last_fetched_at`)を読む。
- `/pull`(IR)と `/pull-news`(ニュース)を両方 since 以降で引く。
- 新着を本文に畳み込む:事業の骨格 / 商品ラインナップ・技術ロードマップ / 経営判断・資本政策 /
  直近の重大トピック(要約・新しい順)/ 決算・ガイダンス。判定や価格の揮発情報は書かない。
- Issue を一括上書き、末尾に 2 カーソルを更新。
- 本文更新後、`repository_dispatch(event_type=signal-judge, {ticker})` で後段を起動。

### 2b. signal-judge skill(`agents/skills/signal-judge/`)— 後段

Issue 本文(コンテキスト)+ 価格/地合い/決算で判定し Slack に出す。**Issue は書き換えない。**

- Issue 本文(context-builder が育てたコンテキスト)を読む。
- `/latest` で prices/daily/premarket(地合い)/earnings(決算日)を引く。
- analyze-ticker の判定ガイドライン(価格/日足/決算リスク/SOX 地合い weighting/連続性)で
  buy/sell/hold + confidence を判定。
- Slack に通知。Issue を触らないので judge→context の編集ループは構造的に起きない。

## 作業 3: GitHub Actions workflow

- `.github/workflows/context-builder.yml`(前段):
  - `repository_dispatch.types: [signal-update]`(Worker 発火)。
  - `concurrency: { group: context-builder-${{ ...ticker }}, cancel-in-progress: true }`。
  - `permissions.contents: write`(signal-judge を `repos/.../dispatches` で起動するため。
    GITHUB_TOKEN 発でも `repository_dispatch` は再帰起動の例外として新規実行を起こせる)。
  - prompt を `/context-builder <ticker>` に。
- `.github/workflows/signal-judge.yml`(後段、新規):
  - `repository_dispatch.types: [signal-judge]`(context-builder 発火)。
  - `concurrency: { group: signal-judge-${{ ...ticker }}, cancel-in-progress: true }`。
  - `permissions`: contents/issues は read のみ(本文を読むだけ)。
  - `allowed_bots: "github-actions[bot]"`(context-builder=GITHUB_TOKEN 発火を許可)。
  - prompt を `/signal-judge <ticker>` に。
- premarket-brief.yml はそのまま(地合いブリーフとして維持)。
- deploy-worker.yml はそのまま。

## 作業 4: ローカル起動資産の削除

### skill
- `.claude/skills/route-news/`(振り分けは判定 skill の LLM が吸収)
- `.claude/skills/analyze-ticker/`(signal-judge の判定ガイドラインに統合)

### scripts(収集は Worker、判定は Actions に移行済み)
- `scripts/fetch-news.ts`(→ Worker news.ts)
- `scripts/fetch-ir.ts` / `fetch-prices.ts` / `fetch-daily.ts` /
  `fetch-fundamentals.ts` / `fetch-premarket.ts`(全て Worker 済み)
- `scripts/fetch-earnings-date.ts`(→ **Worker に移植してから削除**。作業 1b 参照)
- `scripts/route-news-watch.ts` / `scripts/queue-watch.ts`(watcher)
- `scripts/start-tabs.sh`(cmux 起動)
- `scripts/crontab.txt`(Mac cron 定義)
- `scripts/sync-from-d1.ts`(ローカルへの引き戻しが不要に)

### 確認用スクリプト(手動の読み取り専用 → 残す、データ源を Worker に切替え)
- `scripts/valuation.ts` / `sector.ts` / `events.ts` は **残す**。
  ローカル jsonl を読んでいる箇所を **Worker `/latest?kind=...` を叩く形に修正**。
  - valuation: prices + fundamentals + watchlist の fair_per
  - sector: premarket(SOX)+ daily(前日比/5日リターン/出来高)
  - events: `config/events.yaml`(ローカル設定のまま、データ源変更不要)

### data / signals(キュー系のみ削除)
- 削除: `data/inbox` `data/queue` `data/archive` `data/seen.txt` / `signals/`
- 残置: `data/prices` `data/daily` `data/fundamentals` `data/premarket`
  (確認用スクリプトが `/latest` 移行するまでの当面の互換。最終的に不要なら別途削除)

### package.json
- `scripts` の fetch/route/analyze を削除。
- `chokidar` を依存から削除(watcher 廃止)。`iconv-lite` も削除可
  (確認用スクリプトは kabutan を直接叩かなくなるため)。
- cheerio/yaml は確認用スクリプトが使うなら残す。

## 作業 5: ドキュメント(README)更新

- mermaid から LOCAL サブグラフを削除、CLOUD + GHA 中心の図に。
- 「全体構成」「起動」「ログの見方」「ディレクトリ」を Worker + Actions 前提に書き直す。
- cron 登録手順・cmux 起動手順・ローカル収集の記述を削除。
- 判定結果は GitHub Issue + Slack で見る、と明記。

## 残課題: すべて解決済み

- earnings-date → **作業 1b で Worker に移植**(完全クラウド化維持)。
- 確認用スクリプト → **作業 4 で `/latest` を叩く形に修正して残す**。
- 実データ削除 → **作業 4 でキュー系(inbox/queue/archive/seen.txt + signals/)のみ削除**。
  時系列 jsonl は確認スクリプトの /latest 移行後に不要なら別途削除。

## 注意

- 判定 skill が earnings を D1 から読むため、`watchlist.yaml` の `next_earnings_date` は
  source of truth でなくなる(D1 が正)。watchlist.yaml の当該フィールドの扱いは実装時に整理。
