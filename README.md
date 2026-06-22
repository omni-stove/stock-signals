# stock-signals

日本株4銘柄(半導体)向けのニュース駆動シグナル生成リポジトリ。

## 構成思想

- **対象はスイング (数日〜3週間の保有)**。秒・分単位の板情報や歩み値は対象外。
- **取引は手動**。本リポは「売買判断の材料」を非同期で並べ続ける装置。
- **完全クラウド**。収集は Cloudflare Worker、LLM判定は GitHub Actions で完結する。
- **収集はWorker (LLM不使用)**。記事・株価・ファンダ・適時開示・証券会社レーティングの取得は素のスクレイプなので Worker の cron trigger から直接実行。
- **判定はGitHub Actions上のClaude Code (LLM)**。新規データ取得をトリガーに skill (`.claude/skills/`) を起動する。
- **判定は2段に分離**。前段 `context-builder` が銘柄ごとの **D1 コンテキスト** (Worker `/context`、`contexts` テーブル) を「持続コンテキスト(経営判断・商品ラインナップ・技術ロードマップ + 直近の重大トピック要約)」として育て、後段 `signal-judge` がそのコンテキスト+価格/地合いを読んで buy/sell を判定する。
- **判定は必ず buy か sell の2値**。薄い材料でも片側に倒す。方向に「水準」修飾子 (押し目/追い/利確/逃げ) を添えて、トレンド内のどこにいるかを示す。
- **出力の住み分け**。D1 コンテキスト = 銘柄を読み解く生きたナレッジ(context-builder が書く)。判定 (buy/sell) = Slack に流れる(signal-judge が書く)。コンテキストは人間が直接見るものではないが、更新のたび全文が Slack のコンテキスト更新チャンネル (`SLACK_CONTEXT_CHANNEL`) に投稿される(覗き窓)。
- **記事系は1つに合流**。公式IR・銘柄ニュース・適時開示(TDnet)・証券会社レーティングはすべて同じ記事ストアに保存され、収集元が増えても context-builder は無改修で読む。レーティングは目標株価が中期(6〜12ヶ月)ビューなので、context-builder がコンテキストの専用セクションに畳み込む(直近トピックの30日ルールの例外)。
- **補助: 暴落プリモーテム**。`crash-scenario` skill は signal-judge と同じインプット (コンテキスト + 数値) を読み、その銘柄が崩れる道筋を銘柄固有/マクロの両面で3〜5本列挙して Slack に流す。buy/sell 判定とは別物 (リスクの事前棚卸し)。起動は **Slack スラッシュコマンド `/crash` 専用**: `/crash 285A` なら即発火 / 引数なしなら watchlist から銘柄ピッカーが出る。GitHub 画面からの手動実行は持たない。
- **手動 buy/sell 判定**。`signal-judge` は通常 context-builder のあとに自動で走るが、**Slack スラッシュコマンド `/signal` でも任意のタイミングで起動できる**: `/signal 285A` なら即発火 / 引数なしなら銘柄ピッカー (`/crash` と同じ口を共有)。

## 対象銘柄 (watchlist)

| code | name           | 備考                       |
| ---- | -------------- | -------------------------- |
| 285A | キオクシア     | 半導体メモリ               |
| 6857 | アドバンテスト | 半導体テスター             |
| 6920 | レーザーテック | 半導体検査装置             |
| 6981 | 村田製作所     | 電子部品(MLCC)             |

詳細とキーワード/IRソースは `config/watchlist.yaml` 参照(銘柄一覧の唯一の真のソース)。

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
        D1[("D1 (SQLite)<br/>prices/daily/fundamentals/margin(信用残)<br/>articles(IR+news+開示+レーティング)メタ<br/>contexts(銘柄コンテキスト+2カーソル)<br/>premarket/earnings/intraday_dispatch/slack_threads")]
        R2[("R2<br/>記事本文JSON")]
        API((HTTP API<br/>/run /pull /pull-news /latest /context))
        SLACKAPI((Slack HTTP<br/>/slack/command /slack/interact<br/>/slack/events /slack/post))
        CRON_CF --> WORKER
        WORKER -->|時系列/メタINSERT| D1
        WORKER -->|本文保存| R2
        D1 -->|時系列/メタ/カーソル照会| API
        R2 -->|本文取得| API
        SLACKAPI --> WORKER
        D1 -.->|親tsで銘柄復元<br/>slack_threads| SLACKAPI
        WORKER -.->|新規IR/news等あれば<br/>repository_dispatch| DISPATCH{{"signal-update<br/>イベント"}}
    end

    subgraph GHA["⚙️ GitHub Actions (LLM判定)"]
        direction TB
        CTXWF["context-builder.yml<br/>(concurrency: 銘柄ごと cancel-in-progress)"]
        CTXIN["step: context-input.sh<br/>(コンテキスト+カーソル+新規IR/news を 1 JSON に)"]
        CTXSKILL["skill: context-builder<br/>(Claude Code / LLM)<br/>@path を読み銘柄コンテキストに反映"]
        JUDGEDISP{{"signal-judge<br/>イベント<br/>(repository_dispatch)"}}
        JUDGEWF["signal-judge.yml<br/>(concurrency: 銘柄ごと cancel-in-progress)"]
        JUDGECTX["step: judge-context.sh + event-context.sh<br/>(数値+コンテキスト本文を正規化/同梱 + 需給イベント1行)"]
        JUDGESKILL["skill: signal-judge<br/>(Claude Code / LLM)<br/>@path (数値+context_body) を読み buy/sell を判定"]
        CRASHWF["crash-scenario.yml<br/>(/crash 起動)"]
        CRASHSKILL["skill: crash-scenario<br/>(Claude Code / LLM)<br/>暴落シナリオを列挙 (コンテキストは更新しない)"]
        REPLYWF["slack-reply.yml<br/>(スレッド返信に応答)"]
        REPLYSKILL["skill: slack-reply<br/>(Claude Code / LLM)<br/>@path (数値+context_body) +スレッド履歴を読み同スレッドへ返答"]
        SLACK["Slack"]
        CTXWF --> CTXIN --> CTXSKILL -->|POST /context で本文+カーソルを更新| API
        CTXSKILL -->|更新後 dispatch| JUDGEDISP --> JUDGEWF --> JUDGECTX --> JUDGESKILL
        CTXSKILL -.->|本文全文を投稿| SLACK
        JUDGESKILL -->|判定 buy/sell| SLACK
        CRASHWF --> CRASHSKILL
        CRASHSKILL -->|暴落プリモーテム| SLACK
        REPLYWF --> REPLYSKILL
        REPLYSKILL -->|同スレッドへ返答| SLACK
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
    WORKER -.->|repository_dispatch<br/>crash-scenario| CRASHWF
    WORKER -.->|repository_dispatch<br/>slack-reply| REPLYWF

    %% Actions → Worker (材料引きは workflow step が代行し skill へ @path で渡す)
    %% 縦積みを崩さぬよう横断する戻り参照は破線 (重み低)
    API -.->|/context（本文+カーソル） /pull（IR/開示/レーティング本文） /pull-news（ニュース本文）| CTXIN
    API -.->|/latest（prices/daily/premarket/earnings/margin） /context（本文）| JUDGECTX

    %% Slack 連携 (双方向)
    SLACK -.->|/crash・/signal・スレッド返信| SLACKAPI
    JUDGESKILL -.->|/slack/post Bot| SLACKAPI
    CRASHSKILL -.->|/slack/post Bot| SLACKAPI
    REPLYSKILL -.->|/slack/post thread_ts| SLACKAPI
    WORKER -.->|新規IR通知<br/>Incoming Webhook| SLACK

    classDef cloud stroke:#4285f4,stroke-width:2px
    classDef gha stroke:#8e44ad,stroke-width:2px
    class CLOUD,CRON_CF,WORKER,D1,R2,API,SLACKAPI,DISPATCH cloud
    class GHA,CTXWF,CTXIN,CTXSKILL,JUDGEDISP,JUDGEWF,JUDGECTX,JUDGESKILL,CRASHWF,CRASHSKILL,REPLYWF,REPLYSKILL,SLACK gha
```

### Cron スケジュール

収集は JST 基準で以下のタイミングに走る(東証が開かない土日はスキップ)。

| JST | 種別 | 内容 |
| --- | --- | --- |
| 08:30 | intake | IR + ニュース + 適時開示(TDnet) + 証券会社レーティング + 地合い(寄り前のみ) |
| 20:00 | intake | IR + ニュース + 適時開示 + レーティング + 信用残(週次の需給。引け後にだけ相乗り) |
| 09:00–15:00 5分毎 | prices | 株価スナップショット + ニュース速報。12:30 相当スロットでは IR intake も相乗り |
| 16:00 | eod | 日足 + ファンダ + 決算日推定。**月初 (1〜3日)** はマクロイベント(FOMC/日銀)も相乗り収集 |

### LLM連鎖 (新規データ検知 → Slack)

```mermaid
sequenceDiagram
    participant W as Worker (cron)
    participant D1 as D1 (contexts)
    participant GH as GitHub
    participant CB as context-builder (LLM)
    participant SJ as signal-judge (LLM)
    participant SL as Slack

    W->>W: スクレイプ → D1/R2 保存
    alt 新規 IR/ニュース/開示/レーティングあり
        opt 場中 (prices cron) は銘柄ごと 15分デバウンス
            W->>W: intraday_dispatch を確認<br/>15分以内に撃っていれば見送り (次スロットが冪等に拾う)
        end
        W->>GH: dispatch(signal-update)
        GH->>CB: カーソル以降の新着 IR/news を渡して起動
        CB->>D1: POST /context で本文+カーソルを更新 (1 upsert で原子的に前進)
        CB->>SL: 更新後の本文全文をコンテキスト更新チャンネルに投稿
        CB->>GH: dispatch(signal-judge)
        GH->>SJ: 現在の数値 (価格/日足/寄り前/決算/信用残) + コンテキスト本文 + 需給イベントを渡して起動
        SJ->>SL: buy/sell + 水準修飾子 (押し目/追い/利確/逃げ) を通知
    end
```

カーソル(`ir_last_fetched_at` / `news_last_fetched_at`)は `contexts` 行に本文と同じ行で持ち、
context-builder が POST /context で **本文とカーソルを1回の upsert で原子的に前進させる**
(本文だけ進む/カーソルだけ進む を構造的に排除)。前段のジョブが途中でキャンセルされても
カーソルは更新されず、次の発火で取りこぼし分を含めて再取得される (冪等)。判定はカーソル以降を全部読む。

### スレッド返信で対話 (Slack → Worker → slack-reply)

判定/プリモーテムの投稿にスレッド返信すると、同じスレッドへ Claude が返答する。

```mermaid
sequenceDiagram
    participant U as ユーザー
    participant SL as Slack
    participant W as Worker (/slack/events)
    participant D1 as D1 (slack_threads)
    participant GH as GitHub
    participant SR as slack-reply (LLM)

    U->>SL: 解析投稿にスレッド返信
    SL->>W: event_callback (message.channels, 署名付き)
    W->>W: bot投稿/subtype/親自身を除外
    W->>D1: 親 thread_ts で銘柄を復元
    alt slack_threads に親あり
        W-->>SL: ユーザー返信に 👀 (受付可視化)
        W->>GH: dispatch(slack-reply) {ticker, thread_ts, text}
        Note over W,SL: 3秒制約 → dispatch は waitUntil、即 200 を返す
        GH->>SR: 起動
        SR->>SR: コンテキスト本文 + 数値 (judge-context.sh) + スレッド履歴 (replies) を読む
        SR->>SL: /slack/post (thread_ts 指定) で同スレッドへ返答
        Note over U,SL: さらに返信すれば再発火し会話が続く
    else 親なし (watchlist 外の雑談)
        W-->>SL: 無視 (200 のみ)
    end
```

### スラッシュコマンド起動 (/crash 暴落プリモーテム・/signal buy/sell 判定)

`/crash` と `/signal` は同じ `/slack/command` の口を共有し、コマンド名で撃つ event_type
(crash-scenario / signal-judge) を切り替える。下図は `/crash` の例。`/signal` も流れは同じで、
dispatch 先が signal-judge、投稿内容が buy/sell 判定になる。

```mermaid
sequenceDiagram
    participant U as ユーザー
    participant SL as Slack
    participant W as Worker (/slack/command)
    participant GH as GitHub
    participant CS as crash-scenario / signal-judge (LLM)

    U->>SL: /crash または /signal [銘柄]
    SL->>W: slash command (署名付き)
    alt 引数が有効な銘柄コード
        W->>GH: dispatch(該当 event_type) で即発火
        W-->>SL: ephemeral「起動しました」
    else 引数なし / 未知コード
        W-->>SL: ephemeral 銘柄ピッカー (static_select, value=<cmd>:<code>)
        U->>SL: 銘柄を選択
        SL->>W: block_actions (/slack/interact)
        W->>GH: dispatch(該当 event_type)
        W-->>SL: ephemeral を結果メッセージに差し替え
    end
    GH->>CS: 起動
    CS->>CS: コンテキスト本文 + 数値 (judge-context.sh) を読む
    CS->>SL: /slack/post で結果を投稿
```

**場中ニュースのデバウンス**。場中 (5分毎) は同じ銘柄に短時間で複数の新着が出ると判定が数分おきに
連発するため、**15分以内に既に撃っていればその回は見送る** (見送り分は冪等性で次スロットがまとめて拾う)。
寄り前/引け後の intake は地合い込みの重要判定なのでデバウンスせず常に判定する。

## ディレクトリ構成

| パス | 中身 |
| ---- | ---- |
| `worker/`            | Cloudflare Worker (収集) |
| `.github/workflows/` | LLM判定の Actions / CI (`ci.yml` で `pnpm run verify`) / dependabot 自動マージ |
| `agents/skills/`     | Claude Code skill 実体 (`.claude/skills/` は symlink) |
| `scripts/`           | Actions 前処理 (`*.sh`) と手動ツール (`*.ts`) |
| `config/`            | watchlist / sources / events |

## 判定結果の見方

判定は Slack に出る。銘柄コンテキストは D1 に蓄積され、人間向けには更新のたび Slack に流れる。

- **D1 コンテキスト (銘柄コンテキスト)**: 銘柄ごとに `contexts` テーブルの1行があり、本文(銘柄
  コンテキスト) + 2カーソル(`ir_last_fetched_at` / `news_last_fetched_at`)を持つ。`GET /context?code=`
  で読める。人間が直接見るものではなく、context-builder が書き signal-judge / crash-scenario /
  slack-reply が読む内部ストア。
- **Slack (コンテキスト更新)**: context-builder が D1 を更新するたび、更新後の本文全文を
  コンテキスト更新チャンネル (`SLACK_CONTEXT_CHANNEL`) に投稿する。人間がコンテキストの育ちを
  覗くための窓 (判定チャンネルとは分離)。
- **Slack (判定)**: signal-judge が出す buy/sell + 水準修飾子 + 根拠が1行流れる。
  根拠には判定の核になった「直近の重大トピック」が引用される。寄り前は地合いを取得してから
  新着のある銘柄の判定を発火するので、寄り前判定も地合い込みで Slack に届く。
- **Slack (新規IR)**: Worker が新着IRを通知する。判定とは別チャンネルに分けることもできる。
- **Slack (暴落プリモーテム)**: スラッシュコマンド `/crash 285A` で即起動、`/crash` 単独なら
  銘柄ピッカーが出る。結果は判定と同じチャンネルに暴落シナリオ3〜5本が届く。
- **Slack (スレッド返信で対話)**: 判定/プリモーテムの投稿に**スレッド返信すると Claude が同じ
  スレッドへ返事を返す**。銘柄コンテキスト (生きたナレッジ) + 現在の数値 + スレッド履歴を読んで
  返答し、さらに返信すれば会話が続く。Bot 自身の投稿やスレッド外の発言には反応しない。

> Slack App の登録・Worker / GitHub Actions の secret 設定といった構築手順は、利用ではなく
> セットアップの領域なので各 skill (`agents/skills/`) とワークフロー (`.github/workflows/`) を参照。