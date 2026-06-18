# stock-signals

日本株4銘柄(半導体)向けのニュース駆動シグナル生成リポジトリ。

## 構成思想

- **対象はスイング (数日〜3週間の保有)**。デイトレ用途ではない。秒・分単位の板情報や歩み値は取らない。
- **取引は手動**。本リポはあくまで「売買判断の材料」を非同期で並べ続ける装置。
- **完全クラウド**。収集は Cloudflare Worker、LLM判定は GitHub Actions。常駐プロセスもローカル cron も持たない。
- **収集はWorker (LLM不使用)**。記事・株価・ファンダの取得は素のスクレイプなので Worker の cron trigger から直接実行。
- **判定はGitHub Actions上のClaude Code (LLM)**。新規データ取得をトリガーに skill (`.claude/skills/`) を起動する。
- **判定は2段に分離**。前段 `context-builder` が銘柄ごとの常設 Issue 本文を「持続コンテキスト(経営判断・商品ラインナップ・技術ロードマップ + 直近の重大トピック要約)」として育て、後段 `signal-judge` がそのコンテキスト+価格/地合いを読んで buy/sell/hold を判定する。
- **出力の住み分け**。Issue 本文 = 銘柄を読み解く生きたナレッジ(context-builder が書く)。判定 (buy/sell/hold) = Slack に流れる(signal-judge が書く)。signal-judge は Issue を一切書き換えないので、判定→本文の編集ループは起きない。

## 対象銘柄 (watchlist)

| code | name           | 備考                       |
| ---- | -------------- | -------------------------- |
| 285A | キオクシア     | 半導体メモリ               |
| 6857 | アドバンテスト | 半導体テスター             |
| 6920 | レーザーテック | 半導体検査装置             |
| 6981 | 村田製作所     | 電子部品(MLCC)             |

詳細とキーワード/IRソースは `config/watchlist.yaml` 参照。

## 全体構成

Cloudflare Worker (収集) と GitHub Actions (LLM判定) の2環境で完結する。
Worker が cron で記事・時系列・地合いを集めて D1/R2 に貯め、新規データがあれば
GitHub Actions を `repository_dispatch` で起動する。判定は2段:前段 `context-builder` が
Worker API から新着 IR/ニュースを引いて銘柄ごとの GitHub Issue 本文を「銘柄コンテキスト」として
更新し、続けて後段 `signal-judge` を `repository_dispatch` で起動する。signal-judge はその
コンテキスト+価格/地合いを読んで buy/sell/hold を判定し Slack に通知する(Issue は触らない)。
時系列の source of truth は D1、銘柄コンテキストの source of truth は Issue 本文。

```mermaid
flowchart TB
    subgraph EXT["外部データソース (スクレイプ対象)"]
        KABUTAN["kabutan<br/>現値/日足/ファンダ/ニュース"]
        KIOXIA["kioxia.com /<br/>kioxia-holdings.com<br/>(公式IR・適時開示)"]
        MARKET["米国市場/SOX/日経先物<br/>(前夜マーケット)"]
    end

    subgraph CLOUD["☁️ Cloudflare Worker (収集)"]
        direction TB
        CRON_CF["Cron Triggers<br/>ir/news/prices/eod(daily+fundamentals+earnings)/premarket"]
        WORKER["Worker<br/>src/index.ts + timeseries.ts<br/>+ premarket.ts + news.ts + earnings.ts"]
        D1[("D1 (SQLite)<br/>prices/daily/fundamentals<br/>articles(IR+news)メタ<br/>premarket/earnings")]
        R2[("R2<br/>記事本文JSON")]
        CRON_CF --> WORKER
        WORKER -->|時系列/メタINSERT| D1
        WORKER -->|本文保存| R2
        WORKER -.->|/pull /pull-news /latest| API((HTTP API))
        WORKER -.->|新規あれば<br/>repository_dispatch| DISPATCH{{"signal-update<br/>イベント"}}
    end

    subgraph GHA["⚙️ GitHub Actions (LLM判定)"]
        direction TB
        CTXWF["context-builder.yml<br/>(concurrency: 銘柄ごと cancel-in-progress)"]
        CTXSKILL["skill: context-builder<br/>(Claude Code / LLM)<br/>IR+ニュースを銘柄コンテキストに反映"]
        JUDGEDISP{{"signal-judge<br/>イベント<br/>(repository_dispatch)"}}
        JUDGEWF["signal-judge.yml<br/>(concurrency: 銘柄ごと cancel-in-progress)"]
        JUDGESKILL["skill: signal-judge<br/>(Claude Code / LLM)<br/>コンテキスト+価格/地合いで判定"]
        PREWF["premarket-brief.yml<br/>(cron JST 08:30)"]
        PRESKILL["skill: premarket-brief<br/>(Claude Code / LLM)"]
        ISSUE["銘柄ごとの常設Issue<br/>(銘柄コンテキスト + 2カーソル)"]
        SLACK["Slack"]
        CTXWF --> CTXSKILL -->|本文を更新| ISSUE
        CTXSKILL -->|本文更新後 dispatch| JUDGEDISP --> JUDGEWF --> JUDGESKILL
        ISSUE -.->|本文を読む| JUDGESKILL
        JUDGESKILL -->|判定| SLACK
        PREWF --> PRESKILL --> SLACK
    end

    %% 外部 → 収集
    KABUTAN --> WORKER
    KIOXIA --> WORKER
    MARKET --> WORKER

    %% Worker → Actions
    DISPATCH --> CTXWF

    %% Actions → Worker (材料引き)
    API -->|/pull(IR本文) /pull-news(ニュース本文)| CTXSKILL
    API -->|/latest(prices/daily/premarket/earnings)| JUDGESKILL
    API -->|/latest(premarket+各銘柄)| PRESKILL

    classDef cloud fill:#e8f0fe,stroke:#4285f4
    classDef gha fill:#f0e8fe,stroke:#8e44ad
    class CLOUD,CRON_CF,WORKER,D1,R2,API,DISPATCH cloud
    class GHA,CTXWF,CTXSKILL,JUDGEDISP,JUDGEWF,JUDGESKILL,PREWF,PRESKILL,ISSUE,SLACK gha
```

## データフロー

```
  Cloudflare Worker (cron trigger)
        │  収集 (LLM不使用、kabutan/kioxia をスクレイプ)
        ├─▶ IR一次情報      ─┐
        ├─▶ per_tickerニュース ┼─▶ D1 articles(メタ) + R2(本文)
        │                      │
        ├─▶ prices/daily/fundamentals ─▶ D1 時系列
        ├─▶ premarket(SOX/日経先物)    ─▶ D1 premarket
        └─▶ earnings-date(決算予定推定) ─▶ D1 earnings
        │
        │  IR or ニュースに銘柄単位の新規があれば
        ▼
  repository_dispatch(signal-update, {ticker})
        │
        ▼
  GitHub Actions [前段]: context-builder skill (Claude Code / LLM)
        │  concurrency: context-builder-<ticker> / cancel-in-progress
        │  ① Issue 本文から ir/news の 2カーソルを読む(本文=銘柄コンテキスト)
        │  ② /pull(IR) + /pull-news(ニュース) を since以降で引く
        │  ③ 新着を「持続コンテキスト + 直近の重大トピック要約」に畳み込む
        │     (経営判断/商品ラインナップ/技術ロードマップ)。判定は書かない
        │  ④ Issue 本文を一括上書き、末尾に 2カーソルを更新
        ▼
  repository_dispatch(signal-judge, {ticker})   ← context-builder が発火
        │
        ▼
  GitHub Actions [後段]: signal-judge skill (Claude Code / LLM)
        │  concurrency: signal-judge-<ticker> / cancel-in-progress
        │  ① Issue 本文(コンテキスト)を読む  ※Issue は書き換えない
        │  ② /latest で prices/daily/premarket(地合い)/earnings(決算日)
        │  ③ コンテキスト+価格/地合いで buy/sell/hold + confidence を判定
        ▼
  Slack に判定を通知 (Issue は触らないので judge→context のループは起きない)
```

カーソルは Issue 本文に永続化されるため、前段のジョブが途中でキャンセルされても
カーソルは更新されず、次の発火で取りこぼし分を含めて再取得される (冪等)。
判定 (buy/sell/hold) は Issue に残さず Slack に流す。Issue 本文は「銘柄を読み解く
生きたコンテキスト」に徹し、後段はそれを読むだけで書き換えない。

## コンポーネント一覧

### Cloudflare Worker (`worker/`)

| 名前                     | 役割                                                    |
| ------------------------ | ------------------------------------------------------- |
| `worker/src/index.ts`    | ルーティング + IR/ニュース収集 + scheduled(cron) + GitHub App 認証で `repository_dispatch` 発火。`/run /pull /pull-news /latest /health` 等の HTTP API |
| `worker/src/timeseries.ts` | prices / daily / fundamentals の収集 (kabutan)         |
| `worker/src/premarket.ts`  | 前夜マーケット(SOX/Nasdaq/Dow/日経先物)の収集            |
| `worker/src/news.ts`       | per_ticker ニュース(kabutan 銘柄ニュース)の収集         |
| `worker/src/earnings.ts`   | 次回決算発表予定日の推定 (kabutan finance、eod cron で D1 更新) |
| `worker/schema.sql`        | D1 スキーマ (articles / prices / daily / fundamentals / premarket / earnings) |

### GitHub Actions (`.github/workflows/`)

| 名前                          | トリガー                          | 役割                                       |
| ----------------------------- | --------------------------------- | ------------------------------------------ |
| `context-builder.yml`         | `repository_dispatch(signal-update)` / 手動 | context-builder skill で銘柄コンテキスト(Issue本文)を更新し signal-judge を発火 |
| `signal-judge.yml`            | `repository_dispatch(signal-judge)` / 手動  | signal-judge skill でコンテキスト+価格/地合いを判定し Slack へ (Issueは触らない) |
| `premarket-brief.yml`         | cron (JST 08:30 平日) / 手動      | premarket-brief skill で寄り前ブリーフを Slack へ |
| `deploy-worker.yml`           | push to main (`worker/**`)        | wrangler で Worker を自動デプロイ          |

### Claude Code skill (`agents/skills/`)

skill の実体は `agents/skills/<name>/SKILL.md` に置く。Claude Code / GitHub Actions の `claude-code-action` は標準の `.claude/skills/` を探すため、`.claude/skills/<name>` は `agents/skills/<name>` への symlink になっている (実体と symlink の両方が git 管理下なので、Actions のチェックアウトでも解決できる)。

| 名前              | 役割                                                                 |
| ----------------- | -------------------------------------------------------------------- |
| `context-builder` | 銘柄の IR + ニュースを Worker から引き、Issue 本文を「持続コンテキスト+直近の重大トピック要約」として更新。判定はせず signal-judge を発火。one-shot |
| `signal-judge`    | Issue 本文(コンテキスト)+ 価格/地合い/決算を読み buy/sell/hold + confidence を判定し Slack 通知。Issue は書き換えない。one-shot |
| `premarket-brief` | 寄り前に全銘柄の地合い(SOX/日経先物)+ 価格を読み、当日の per-ticker lean を Slack に1本投稿。one-shot |

### 確認用スクリプト (`scripts/`、手動の読み取り専用)

| 名前                  | 役割                                                                          |
| --------------------- | ----------------------------------------------------------------------------- |
| `scripts/valuation.ts`| Worker `/latest` の prices + fundamentals + watchlist の `fair_per` から、必要EPS・必要な決算修正率・適正株価を表で出力 (`--json` 可) |
| `scripts/sector.ts`   | Worker `/latest` の premarket(SOX) と各銘柄 daily から、セクターの地合いと相対強弱を出力 |
| `scripts/events.ts`   | `config/events.yaml` の FOMC/SQ/日銀会合などから直近N日以内の未来イベントを一覧表示 |

skill の詳細は `agents/skills/<name>/SKILL.md`。Worker のデプロイ/初期化は `worker/README-cloud.md`。

## 判定結果の見方

判定は GitHub Issue と Slack に出る。

- **GitHub Issue (銘柄コンテキスト)**: 銘柄ごとに `label: ir-report` + `label: ticker:<code>` の
  常設 Issue が1本あり、本文は context-builder が育てる「銘柄を読み解く生きたコンテキスト」
  (事業の骨格 / 商品ラインナップ・技術ロードマップ / 経営判断・資本政策 / 直近の重大トピック /
  決算・ガイダンス)。末尾に 2カーソルを持つ。**判定 (buy/sell/hold) は本文には書かれない**。
- **Slack (判定)**: signal-judge が出す buy/sell/hold + confidence + 根拠が1行流れる。
  根拠には判定の核になった「直近の重大トピック」が引用される。寄り前ブリーフ(premarket-brief)も Slack に届く。

確認用スクリプトを手元で叩くこともできる (要 `WORKER_URL` 環境変数):

```sh
WORKER_URL=https://<your-worker> node scripts/valuation.ts
WORKER_URL=https://<your-worker> node scripts/sector.ts semiconductor
node scripts/events.ts --days 45
```

## ディレクトリ

```
stock-signals/
├── agents/skills/         # Claude Code skill の実体 (LLM判定)
│   ├── context-builder/   # IR+ニュースで銘柄コンテキスト(Issue本文)を更新
│   ├── signal-judge/      # コンテキスト+価格でスイング判定し Slack 通知
│   ├── premarket-brief/   # 寄り前ブリーフ (Actions cron)
│   └── cap/               # commit & push ヘルパ
├── .claude/skills/        # → agents/skills/* への symlink (Claude Code が探す標準パス)
├── .github/workflows/
│   ├── context-builder.yml
│   ├── signal-judge.yml
│   ├── premarket-brief.yml
│   └── deploy-worker.yml
├── config/
│   ├── watchlist.yaml     # 対象銘柄+キーワード+ソース定義
│   ├── sources.yaml       # ニュース/IR ソース定義
│   └── events.yaml        # マクロ/需給イベント (手動メンテ)
├── worker/                # Cloudflare Worker (収集)
│   ├── src/
│   │   ├── index.ts
│   │   ├── timeseries.ts
│   │   ├── premarket.ts
│   │   ├── earnings.ts
│   │   └── news.ts
│   ├── schema.sql
│   ├── wrangler.toml
│   └── README-cloud.md
├── scripts/               # 確認用スクリプト (手動、読み取り専用)
│   ├── valuation.ts
│   ├── sector.ts
│   └── events.ts
├── package.json
└── tsconfig.json
```

## 決算日メンテナンス

各銘柄の次回決算発表予定日は **Worker が eod cron (引け後1日1回) で自動推定**し D1 に保持する。
kabutan finance ページの四半期業績テーブルから「直近実績の次四半期 = 前年同期の発表日 +1年」で算出。
signal-judge はこれを読み、決算が5日以内なら confidence を low、6-14日なら medium にキャップする
(スイング前提で持ち越しガラを避けるため)。決算発表後は翌営業日の cron で自動的に次の予定日へ繰り上がる。

`config/watchlist.yaml` の `next_earnings_date` は初期値/参考用。source of truth は D1。

## イベントカレンダーメンテナンス

`config/events.yaml` に FOMC・SQ・日銀会合などのマクロ/需給イベントを手動で並べる
(個別決算とは別系統)。`scripts/events.ts` が「直近N日以内の未来イベント」を表示する。

- **四半期ごとに先の日程を追記**する。
  - FOMC / 日銀会合: 公式サイトの年間スケジュールから。米国イベントは結果が日本の
    翌営業日に効くので `jst_effect_date` を入れる。
  - SQ: 各月の第2金曜。3/6/9/12月はメジャーSQ (impact: high)、他月はオプションのみ
    (impact: medium)。祝日でズレる場合は実日付で上書き。
- 過去日になったイベントは消さなくてよい (`events.ts` は未来分のみ表示)。溜まったら整理。

## 注意

- スクレイピングは各サイトの利用規約を確認した上で、低頻度・User-Agent明示で行う。
- LLMの判定は参考情報。最終的な売買は必ず人間が決める。
- 判定 Issue には判定根拠を含めること(後日の振り返り用)。
