# stock-signals

日本株4銘柄(半導体)向けのニュース駆動シグナル生成リポジトリ。

## 構成思想

- **対象はスイング (数日〜3週間の保有)**。デイトレ用途ではない。秒・分単位の板情報や歩み値は取らない。
- **取引は手動**。本リポはあくまで「売買判断の材料」を非同期で並べ続ける装置。
- **UIなし**。cmuxの並列タブで各エージェントを常駐させ、ログを眺める運用。
- **エージェント=Claude Code**。LLM判定が必要な工程だけskill (`.claude/skills/`) 化し、cmuxタブで常駐させる。
- **スクレイピングは素のスクリプト**。記事取得はLLM不要なのでcronから直接スクリプトを叩く。
- **キュー=ファイルシステム**。`data/inbox` → `data/queue/<ticker>` → `signals/<ticker>.log` の片方向フロー。

## 対象銘柄 (watchlist)

| code | name           | 備考                       |
| ---- | -------------- | -------------------------- |
| 285A | キオクシア     | 半導体メモリ               |
| 6857 | アドバンテスト | 半導体テスター             |
| 6920 | レーザーテック | 半導体検査装置             |
| 6981 | 村田製作所     | 電子部品(MLCC)             |

詳細とキーワード/IRソースは `config/watchlist.yaml` 参照。

## データフロー

```
                  ┌──────────────────────┐
        cron ───▶ │ scripts/fetch-news.ts│ (15分毎、node直実行、LLM不使用)
        (15分)    └─────┬──────────┬─────┘
                        │          │
       per_ticker分岐 ◀─┘          └─▶ macro分岐
       (銘柄ページ直行)               (横断ニュース)
              │                              │
              ▼                              ▼
  data/queue/<ticker>/*.json         data/inbox/*.json
              │                              │
              │                     ┌────────▼────────┐
              │                     │ route-news      │ ← Claude Code skill (LLM)
              │                     │ (inbox watch)   │ マクロ→該当銘柄へ配信
              │                     └────────┬────────┘
              │                              │
              ◀──────────────────────────────┘
              ▼
      ┌────────────────┐      ┌────────────────────────┐
      │ analyze-ticker │◀─読─ │ data/prices/<t>.jsonl  │
      │  (× 銘柄数)    │      │ data/daily/<t>.jsonl   │
      │                │      │ config/watchlist.yaml  │ (next_earnings_date)
      └────────┬───────┘      └──────────▲─────────────┘
               │                         │
               │              cron ─▶  scripts/fetch-prices.ts (5分毎、現値/PTS)
               │              cron ─▶  scripts/fetch-daily.ts  (引け後1回、日足)
               ▼
       signals/<ticker>.log  (JSONL追記、買/売/様子見)
               │
               ▼
          data/archive/   (処理済を保管)
```

## コンポーネント一覧

| 名前                       | 種別                 | 役割                                              |
| -------------------------- | -------------------- | ------------------------------------------------- |
| `scripts/fetch-news.ts`         | 単発スクリプト (node) | 設定ソースをスクレイプ→ `data/queue/` (per_ticker) と `data/inbox/` (macro) に振り分け配置 |
| `scripts/fetch-ir.ts`           | 単発スクリプト (node) | 銘柄の**公式IR/プレスリリースを一次情報**として取得し `data/queue/<code>/` に配置 (analyze-ticker が拾う)。`config/sources.yaml` の `ir` を読み site 別パーサで解析。現状 285A (キオクシア) のみ対応。事業会社 (kioxia.com) と持株会社 (kioxia-holdings.com=上場主体, 適時開示) の両方を取得し `ir_category` で分類。`seen.txt` を fetch-news と共有し重複排除 (`<code>`指定 / `--dry-run` 可) |
| `scripts/fetch-prices.ts`       | 単発スクリプト (node) | watchlist全銘柄の現値・前日比・出来高・PTSを kabutan から取得し `data/prices/<ticker>.jsonl` に追記 |
| `scripts/fetch-daily.ts`        | 単発スクリプト (node) | watchlist全銘柄の直近~30営業日の日足 (OHLC+出来高) を kabutan から取得し `data/daily/<ticker>.jsonl` に追記 (日付重複はスキップ) |
| `scripts/fetch-fundamentals.ts` | 単発スクリプト (node) | watchlist全銘柄の今期予想PER・予想EPS・直近実績EPS を kabutan から取得し `data/fundamentals/<ticker>.jsonl` に追記 (1日1回想定)。予想未開示銘柄は null |
| `scripts/fetch-earnings-date.ts` | 単発スクリプト (node) | watchlist全銘柄の**次回決算発表予定日を推定し `config/watchlist.yaml` の `next_earnings_date` を自動更新** (1日1回想定)。kabutan finance ページの四半期業績テーブルから「直近実績の次四半期 = 前年同期の発表日 +1年」で算出。値だけ差し替えコメントは保持。`--dry-run` で確認のみ |
| `scripts/valuation.ts`          | 確認用スクリプト (node) | 最新の prices + fundamentals + watchlist の `fair_per` を突き合わせ、現在株価・予想PER・予想EPS・**必要EPS**・**必要な決算修正率**・適正株価を表で出力 (`--json` で機械可読)。読むだけで何も書かない |
| `scripts/sector.ts`             | 確認用スクリプト (node) | **セクターの地合いとセクター内相対強弱**を出力。①前夜 `data/premarket/` の SOX 騰落率から risk-on/off/neutral を判定、②同一 `sector` 銘柄の前日比・5日リターン・出来高比をセクター平均と突き合わせ相対強弱を算出 (`semiconductor` 指定 / `--json` 可)。読むだけで何も書かない |
| `scripts/events.ts`             | 確認用スクリプト (node) | `config/events.yaml` の**マクロ/需給イベント (FOMC・SQ・CPI・日銀会合)** から「直近N日以内の未来イベント」を一覧表示。米国イベントは `jst_effect_date` で日本市場に効く翌営業日に補正。決算日と同様、近接時にシグナル確信度を抑える材料 (`--days N` / `--all` / `--json` 可)。読むだけで何も書かない |
| `scripts/route-news-watch.ts`   | 常駐スクリプト (node) | `data/inbox/` を watch、新着のパスを stdout に流す。route-news skill から起動される |
| `scripts/queue-watch.ts`        | 常駐スクリプト (node) | `data/queue/<ticker>/` を watch、新着のパスを stdout に流す。analyze-ticker skill から起動される |
| `.claude/skills/route-news`     | Claude Code skill    | watcherをbackgroundで起動 → Monitorで通知された記事をマクロ判定し銘柄に配信 |
| `.claude/skills/analyze-ticker` | Claude Code skill    | watcherをbackgroundで起動 → Monitorで通知された記事をシグナル判定し `signals/` に追記 |

skillの詳細は `.claude/skills/<name>/SKILL.md`。

## 前提

- **Node 26+** (mise管理)。`.tool-versions` または `.mise.toml` でバージョン固定。
  Node 26はTypeScriptを `node script.ts` で直接実行できる(`--experimental-strip-types`がデフォルト有効)。
- パッケージマネージャは `pnpm` 想定 (npmでも可)。

## 起動

```sh
# 0. Nodeバージョン設定 & 依存インストール
mise install        # .mise.toml に従って Node 26 を入れる
pnpm install

# 1. cron登録
#   ※リポルートで crontab -e する想定。パスはリポルート相対。
crontab -e
# ニュース取得 (平日9-15時、15分毎)
# */15 9-15 * * 1-5 cd ~/Documents/stock-signals && mise exec -- node scripts/fetch-news.ts >> logs/fetch.log 2>&1
# 株価スナップショット (平日9-15時、5分毎)
# */5  9-15 * * 1-5 cd ~/Documents/stock-signals && mise exec -- node scripts/fetch-prices.ts >> logs/prices.log 2>&1
# 日足 (平日16時、引け確定後の1日1回。idempotent なので時刻はずれて構わない)
# 0 16 * * 1-5      cd ~/Documents/stock-signals && mise exec -- node scripts/fetch-daily.ts  >> logs/daily.log  2>&1
# ファンダ指標 (平日16時。予想PER/予想EPS。決算後は数値が変わるので毎日取る)
# 5 16 * * 1-5      cd ~/Documents/stock-signals && mise exec -- node scripts/fetch-fundamentals.ts >> logs/fundamentals.log 2>&1
# 次回決算予定日 (平日16時。kabutanの四半期テーブルから推定し watchlist.yaml を自動更新)
# 10 16 * * 1-5     cd ~/Documents/stock-signals && mise exec -- node scripts/fetch-earnings-date.ts >> logs/earnings-date.log 2>&1
# 公式IR一次情報 (平日朝夕など。新規開示があればqueueに入りanalyze-tickerが拾う)
# 30 8,12,18 * * 1-5 cd ~/Documents/stock-signals && mise exec -- node scripts/fetch-ir.ts >> logs/ir.log 2>&1
# バリュエーション逆算表/セクター/イベントは cron 不要。見たいとき手動: node scripts/valuation.ts

# 2. cmuxで全タブ起動
./scripts/start-tabs.sh
# → 1タブ目: route-news watch
# → 2-5タブ目: analyze-ticker <code> ×4
```

## ログの見方

```sh
# 最新シグナル
tail -f signals/6857.log

# 全銘柄横断
tail -f signals/*.log

# 過去24h振り分け状況
ls -lt data/archive/ | head -30

# セクターの地合い + セクター内相対強弱 (寄り前の値動き判断の土台)
node scripts/sector.ts semiconductor   # 半導体セクターのみ
node scripts/sector.ts                 # 全セクター

# 直近のマクロ/需給イベント (FOMC・SQ・日銀会合)
node scripts/events.ts                 # 直近14日以内
node scripts/events.ts --days 45       # 直近45日以内
```

## ディレクトリ

```
stock-signals/
├── .claude/skills/        # エージェント定義 (Claude Code skill)
│   ├── fetch-news/
│   ├── route-news/
│   └── analyze-ticker/
├── config/
│   ├── watchlist.yaml     # 対象銘柄+キーワード+ソース定義
│   └── sources.yaml       # 共通ニュースソース
├── data/
│   ├── inbox/                  # 取得直後の生記事 (JSON)
│   ├── queue/<ticker>/         # 振り分け済、analyze待ち
│   ├── prices/<ticker>.jsonl   # 5分毎の価格スナップショット (append-only)
│   ├── daily/<ticker>.jsonl    # 日足 OHLC+出来高 (1日1行、append-only)
│   ├── fundamentals/<ticker>.jsonl  # 予想PER/予想EPS/実績EPS (1日1行、append-only)
│   └── archive/                # 処理済、日付別
├── signals/<ticker>.log        # JSONL append-only
├── scripts/
│   ├── fetch-news.ts           # cronから叩く (15分毎)
│   ├── fetch-ir.ts             # cronから叩く (8:30/12:30/18:30、公式IR一次情報)
│   ├── fetch-prices.ts         # cronから叩く (5分毎)
│   ├── fetch-daily.ts          # cronから叩く (引け後1回)
│   ├── fetch-earnings-date.ts  # cronから叩く (引け後1回、決算予定日を自動更新)
│   ├── sources/                # サイト別パーサ
│   └── start-tabs.sh           # cmux一括起動
├── package.json
├── tsconfig.json
└── logs/                  # 各エージェントの動作ログ
```

## 決算日メンテナンス

`config/watchlist.yaml` の各銘柄に `next_earnings_date` (YYYY-MM-DD) を持つ。
analyze-tickerはこれを読み、決算が5日以内なら confidence を low、6-14日なら
medium にキャップする (スイング前提で持ち越しガラを避けるため)。

- **更新は `scripts/fetch-earnings-date.ts` が自動化**している (cron で1日1回)。kabutan の
  finance ページの四半期業績テーブルから「直近実績の次の四半期 = 前年同期の発表日 +1年」を推定し、
  `next_earnings_date` の値だけを上書きする (推定根拠コメントは保持)。決算発表後は翌営業日の cron で
  自動的に次の予定日へ繰り上がる。手動更新は原則不要。
  - `node scripts/fetch-earnings-date.ts --dry-run` で書き換えずに推定結果だけ確認できる。
  - 公式が正式日程を出した場合や、推定がずれていると気づいた場合は手動で上書きしてよい
    (次回 cron 実行時、推定値と一致しなければ再度上書きされる点に注意)。
- 過去日付のまま放置するとシステム側で「stale」と判定されて制約なし扱いになる
  (シグナルログの `risks` に「earnings date stale, needs update」が残るので気づける)。

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
- `signals/*.log` には判定根拠を含めること(後日の振り返り用)。
