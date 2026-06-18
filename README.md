# stock-signals

日本株4銘柄(半導体)向けのニュース駆動シグナル生成リポジトリ。

## 構成思想

- **対象はスイング (数日〜3週間の保有)**。秒・分単位の板情報や歩み値は対象外。
- **取引は手動**。本リポは「売買判断の材料」を非同期で並べ続ける装置。
- **完全クラウド**。収集は Cloudflare Worker、LLM判定は GitHub Actions で完結する。
- **収集はWorker (LLM不使用)**。記事・株価・ファンダ・適時開示・証券会社レーティングの取得は素のスクレイプなので Worker の cron trigger から直接実行。
- **判定はGitHub Actions上のClaude Code (LLM)**。新規データ取得をトリガーに skill (`.claude/skills/`) を起動する。
- **判定は2段に分離**。前段 `context-builder` が銘柄ごとの常設 Issue 本文を「持続コンテキスト(経営判断・商品ラインナップ・技術ロードマップ + 直近の重大トピック要約)」として育て、後段 `signal-judge` がそのコンテキスト+価格/地合いを読んで buy/sell を判定する。
- **判定は必ず buy か sell の2値**。薄い材料でも片側に倒す。方向に「水準」修飾子 (押し目/追い/利確/逃げ) を添えて、トレンド内のどこにいるかを示す。
- **出力の住み分け**。Issue 本文 = 銘柄を読み解く生きたナレッジ(context-builder が書く)。判定 (buy/sell) = Slack に流れる(signal-judge が書く)。source of truth は時系列が D1、銘柄コンテキストが Issue 本文。
- **記事系は1テーブルに合流**。公式IR・銘柄ニュース・適時開示(TDnet)・証券会社レーティングはすべて `articles` テーブルに `source`/`ir_category` プレフィクス付きで保存する。`/pull` の IR カーソルが `ir:% tdnet:% rating:%` を、`/pull-news` がニュースをまとめて返すので、収集元が増えても context-builder は無改修で読む。レーティングは目標株価が中期(6〜12ヶ月)ビューなので、context-builder が Issue 本文の専用セクションに畳み込む(直近トピックの30日ルールの例外)。

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
Worker が cron で集めた新規データを起点に、`context-builder` → `signal-judge` の2段が
`repository_dispatch` で連鎖する (詳細は構成思想を参照)。

```mermaid
flowchart TB
    subgraph EXT["外部データソース (スクレイプ対象)"]
        KABUTAN["kabutan<br/>現値/日足/ファンダ/ニュース<br/>適時開示(TDnet)/レーティング日報"]
        KIOXIA["kioxia.com /<br/>kioxia-holdings.com<br/>(公式IR)"]
        MARKET["米国市場/SOX/日経先物<br/>(前夜マーケット)"]
    end

    subgraph CLOUD["☁️ Cloudflare Worker (収集)"]
        direction TB
        CRON_CF["Cron Triggers<br/>intake(IR+news+開示+レーティング+寄り前は地合い)/prices/eod(daily+fundamentals+earnings)"]
        WORKER["Worker<br/>routes/(HTTP層) + lib/(Cron配線/スクレイプ/IR収集/dispatch発火)"]
        D1[("D1 (SQLite)<br/>prices/daily/fundamentals<br/>articles(IR+news+開示+レーティング)メタ<br/>premarket/earnings/intraday_dispatch")]
        R2[("R2<br/>記事本文JSON")]
        API((HTTP API<br/>/run /pull /pull-news /latest))
        CRON_CF --> WORKER
        WORKER -->|時系列/メタINSERT| D1
        WORKER -->|本文保存| R2
        D1 -->|時系列/メタ/カーソル照会| API
        R2 -->|本文取得| API
        WORKER -.->|新規あれば<br/>repository_dispatch| DISPATCH{{"signal-update<br/>イベント"}}
    end

    subgraph GHA["⚙️ GitHub Actions (LLM判定)"]
        direction TB
        CTXWF["context-builder.yml<br/>(concurrency: 銘柄ごと cancel-in-progress)"]
        CTXIN["step: context-input.sh<br/>(Issue+カーソル+新規IR/news を 1 JSON に)"]
        CTXSKILL["skill: context-builder<br/>(Claude Code / LLM)<br/>@path を読み銘柄コンテキストに反映"]
        JUDGEDISP{{"signal-judge<br/>イベント<br/>(repository_dispatch)"}}
        JUDGEWF["signal-judge.yml<br/>(concurrency: 銘柄ごと cancel-in-progress)"]
        JUDGECTX["step: judge-context.sh + event-context.sh<br/>(数値コンテキストを正規化 + 需給イベント1行)"]
        JUDGESKILL["skill: signal-judge<br/>(Claude Code / LLM)<br/>@path+Issue を読み buy/sell を判定"]
        ISSUE["銘柄ごとの常設Issue<br/>(銘柄コンテキスト + 2カーソル)"]
        SLACK["Slack"]
        CTXWF --> CTXIN --> CTXSKILL -->|本文を更新| ISSUE
        CTXSKILL -->|本文更新後 dispatch| JUDGEDISP --> JUDGEWF --> JUDGECTX --> JUDGESKILL
        ISSUE -.->|本文を読む| JUDGESKILL
        JUDGESKILL -->|判定 buy/sell| SLACK
    end

    %% 外部 → 収集
    KABUTAN --> WORKER
    KIOXIA --> WORKER
    MARKET --> WORKER

    %% subgraph を縦に固定 (不可視リンク: subgraph 単位で上下を強制)
    EXT ~~~ CLOUD
    CLOUD ~~~ GHA

    %% Worker → Actions
    DISPATCH --> CTXWF

    %% Actions → Worker (材料引きは workflow step が代行し skill へ @path で渡す)
    %% 縦積みを崩さぬよう横断する戻り参照は破線 (重み低)
    API -.->|/pull（IR/開示/レーティング本文） /pull-news（ニュース本文）| CTXIN
    API -.->|/latest（prices/daily/premarket/earnings）| JUDGECTX

    classDef cloud stroke:#4285f4,stroke-width:2px
    classDef gha stroke:#8e44ad,stroke-width:2px
    class CLOUD,CRON_CF,WORKER,D1,R2,API,DISPATCH cloud
    class GHA,CTXWF,CTXIN,CTXSKILL,JUDGEDISP,JUDGEWF,JUDGECTX,JUDGESKILL,ISSUE,SLACK gha
```

### Cron スケジュール

Worker の cron trigger は UTC 基準 (`worker/wrangler.toml`)。JST 換算は以下。

| JST | cron式 (UTC) | 種別 | 内容 |
| --- | --- | --- | --- |
| 08:30 | `30 23 * * *` | intake | IR + ニュース + 適時開示(TDnet) + 証券会社レーティング + 地合い(寄り前のみ) |
| 20:00 | `0 11 * * *` | intake | IR + ニュース + 適時開示 + レーティング(決算・適時開示・レーティング日報を当夜に拾う) |
| 09:00–15:00 5分毎 | `*/5 0-6 * * *` | prices | 株価スナップショット + ニュース速報。12:30 相当スロットでは IR intake も相乗り。新着ニュースの dispatch は銘柄ごと 15分デバウンス (下記) |
| 16:00 | `0 7 * * *` | eod | 日足 + ファンダ + 決算日推定 |

### LLM連鎖 (新規データ検知 → Slack)

```mermaid
sequenceDiagram
    participant W as Worker (cron)
    participant GH as GitHub
    participant CB as context-builder (LLM)
    participant SJ as signal-judge (LLM)
    participant SL as Slack

    W->>W: スクレイプ → D1/R2 保存
    alt 新規 IR/ニュース/開示/レーティングあり
        W->>GH: dispatch(signal-update)
        GH->>CB: カーソル以降の新着 IR/news を渡して起動
        CB->>GH: Issue本文を更新 (コンテキスト畳み込み + カーソル更新)
        CB->>GH: dispatch(signal-judge)
        GH->>SJ: 現在の数値 (価格/日足/寄り前/決算) + 需給イベントを渡して起動
        SJ->>GH: Issue本文 (銘柄コンテキスト) を読む
        SJ->>SL: buy/sell + 水準修飾子 (押し目/追い/利確/逃げ) を通知
    end
```

カーソルは Issue 本文に永続化されるため、前段のジョブが途中でキャンセルされても
カーソルは更新されず、次の発火で取りこぼし分を含めて再取得される (冪等)。判定はカーソル以降を全部読む。

**場中ニュースのデバウンス**。場中 (prices cron, 5分毎) は同じ銘柄に短時間で複数の新着が出ると
スロットごとに独立して dispatch してしまい、LLM 2段 (context-builder→signal-judge) が数分おきに
連発する。これを抑えるため、Worker は銘柄ごとの最終 dispatch 時刻を D1 (`intraday_dispatch`) に持ち、
**15分以内に既に撃っていればその回は見送る** (見送り分は上記の冪等性で次スロットがまとめて拾う)。
intake cron (寄り前/引け後) は地合い込みの重要判定なのでデバウンスせず常に dispatch する。
signal-judge は精度優先で `--effort high` (reasoning effort) で走る。

## ディレクトリ構成

| パス | 中身 |
| ---- | ---- |
| `worker/`            | Cloudflare Worker (収集) |
| `.github/workflows/` | LLM判定の Actions / CI (`ci.yml` で `pnpm run verify`) / dependabot 自動マージ |
| `agents/skills/`     | Claude Code skill 実体 (`.claude/skills/` は symlink) |
| `scripts/`           | Actions 前処理 (`*.sh`) と手動ツール (`*.ts`) |
| `config/`            | watchlist / sources / events |

## 判定結果の見方

判定は GitHub Issue と Slack に出る。

- **GitHub Issue (銘柄コンテキスト)**: 銘柄ごとに `label: ir-report` + `label: ticker:<code>` の
  常設 Issue が1本あり、本文が銘柄コンテキスト + 末尾の 2カーソル。
- **Slack (判定)**: signal-judge が出す buy/sell + 水準修飾子 + 根拠が1行流れる。
  根拠には判定の核になった「直近の重大トピック」が引用される。寄り前 (intake cron) は地合いを
  取得してから新着のある銘柄の signal-judge を発火するので、寄り前判定も地合い込みで Slack に届く。

確認用スクリプトを手元で叩くこともできる (要 `WORKER_URL` 環境変数):

```sh
WORKER_URL=https://<your-worker> node scripts/valuation.ts
WORKER_URL=https://<your-worker> node scripts/sector.ts semiconductor
node scripts/events.ts --days 45
```

## 決算日メンテナンス

各銘柄の次回決算発表予定日は **Worker が eod cron (引け後1日1回) で自動推定**し D1 に保持する。
kabutan finance ページの四半期業績テーブルから「直近実績の次四半期 = 前年同期の発表日 +1年」で算出。
signal-judge はこれを読み、決算が5日以内なら原則 `sell` に倒す(de-risk into the print。最新コンテキスト
そのものが決算リリースの場合を除く。スイング前提で持ち越しガラを避けるため)。決算発表後は翌営業日の cron で
自動的に次の予定日へ繰り上がる。

`config/watchlist.yaml` の `next_earnings_date` は初期値/参考用。source of truth は D1。

## 証券会社レーティングメンテナンス

証券会社レーティング(個社別 目標株価)は **Worker が intake cron で kabutan のレーティング日報から自動収集**する。
日報は当日夕方〜夜に出揃うため、引け後 (20:00) intake で拾うと取りこぼしが少ない。新規が出るのは
watchlist 銘柄にレーティング変更があった日だけ。

- `articles` への保存形式 (`source="rating:<firm>"` / `ir_category="rating"`) と Issue 本文への畳み込みは
  構成思想の「記事系は1テーブルに合流」を参照。
- 信頼する証券会社は `worker/src/lib/ratings.ts` の `TRUSTED_FIRMS` で定義する。**ここに無い機関も捨てず保存し**、
  本文に「信頼度: 低」を付けて judge 側で割り引けるようにする (後でリストを変えても再取得不要)。

## イベントカレンダーメンテナンス

`config/events.yaml` に FOMC・SQ・日銀会合などのマクロ/需給イベントを手動で並べる
(個別決算とは別系統)。`scripts/events.ts` が「直近N日以内の未来イベント」を表示する。

- **四半期ごとに先の日程を追記**する。
  - FOMC / 日銀会合: 公式サイトの年間スケジュールから。米国イベントは結果が日本の
    翌営業日に効くので `jst_effect_date` を入れる。
  - SQ: 各月の第2金曜。3/6/9/12月はメジャーSQ (impact: high)、他月はオプションのみ
    (impact: medium)。祝日でズレる場合は実日付で上書き。
- 過去日になったイベントは消さなくてよい (`events.ts` は未来分のみ表示)。溜まったら整理。
