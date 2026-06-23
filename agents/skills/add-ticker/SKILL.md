---
name: add-ticker
description: Add a new monitored ticker to the watchlist. Given a securities code (and optionally a name / sector / IR・news URLs), this skill writes one new entry into config/watchlist.yaml — the single source of truth — then runs `npm run gen:watchlist` to regenerate the mirrors (worker/src/lib/watchlist.gen.ts と context-builder.yml / signal-judge.yml の workflow_dispatch options). It edits config only — it does NOT fetch prices, build context, or post to Slack. One-shot; run manually when 監視対象を増やすとき.
---

# add-ticker

監視対象 (watchlist) に銘柄を 1 つ足す。銘柄リストは `config/watchlist.yaml` が**唯一の真のソース**。
写経先 (Worker のコード・GitHub Actions の choice options) は **`npm run gen:watchlist` が yaml から
自動生成する**ので、このSkillは yaml に 1 エントリ書いて gen を走らせるだけでよい。

このSkillは**設定の編集だけ**を行う。価格取得・context 構築・Slack 投稿は一切しない
(それらは銘柄追加後、通常の cron / 各 workflow が拾う)。

## Inputs

第1引数 `<code>` は必須 (証券コード)。第2引数以降は任意 (会社名・`key=value` の上書き)。
例: `7203` / `7203 トヨタ自動車` / `7203 トヨタ自動車 sector=auto`。
情報が足りなければ**ユーザーに尋ねず、まず web/IR で調べて埋める**。確定できない値は
推定値を入れ、その旨を yaml のコメントに残す (既存エントリのコメント運用に倣う)。

## 仕組み (なぜ yaml だけ直せばいいか)

`config/watchlist.yaml` の `tickers[]` が真のソース。これを写経している箇所は、Worker が
読み取り専用FSで yaml を読めない制約と、`workflow_dispatch` の `choice` が動的生成できない
制約のため必要だが、`scripts/gen-watchlist.ts` (= `npm run gen:watchlist`) が yaml から自動生成する:

- **`worker/src/lib/watchlist.gen.ts`** — `WATCHLIST` 配列 + `WATCHLIST_NAMES` マップ。
  `timeseries.ts` がここから import & re-export するので Worker 各所の `import` は不変。
- **`.github/workflows/context-builder.yml`** / **`signal-judge.yml`** —
  `# GEN:watchlist:start` 〜 `# GEN:watchlist:end` で囲った options 領域だけ差し替える。

> crash-scenario / slack-reply の workflow には choice options が無いので対象外。
> `npm run check:watchlist` (= `gen:watchlist --check`) が verify で「yaml と生成物のズレ」を検知する。

## Steps

### 1. 既存エントリを 1 つ読み、フォーマットを掴む

`config/watchlist.yaml` の既存銘柄 (例: `6857` アドバンテスト) を読み、フィールド・コメントの
書き方をそのまま踏襲する。冒頭の長いフィールド解説コメントは**触らない**。

### 2. 新銘柄の値を確定する

必須・推奨フィールド (既存エントリと同じ粒度で埋める):

- `code` / `name` — 必須。name が未指定なら web で正式社名を引く。
- `aliases` — ニュース本文での銘柄判定に使う別名・略称・英名。
- `keywords` — 業界・製品など、その銘柄の文脈ワード。
- `ir_url` — 公式IR/プレスリリース一覧ページ。
- `news_url` — 株探の銘柄ニュース: `https://kabutan.jp/stock/news?code=<code>`。
- `next_earnings_date` — 次回決算予定日 (YYYY-MM-DD)。公式日程が無ければ**前年同期発表日ベースの推定**を入れ、
  その根拠を行コメントに書く (例: `# 前年Q1=2025-08-08 ベースの推定`)。`scripts/fetch-earnings-date.ts`
  が cron で後から自動上書きするので、推定で十分。
- `fair_per` — その銘柄に妥当と見る予想PER (主観値)。業種水準を踏まえて入れる。逆算不要なら `null`。
- `sector` / `sector_role` — セクター識別子 (現状は全銘柄 `semiconductor`) とその中での位置づけメモ。
  半導体以外を足すなら新しい sector 名を付けてよい (同一 sector 内でのみ相対強弱が比較される)。

不明値は推定 + コメント。**ユーザーへの確認で止めない**。

### 3. yaml に追記する

`tickers[]` の自然な並び順に従って挿入する (既存4銘柄は `285A` → `6857` → `6920` → `6981` の
英数・数値昇順)。前後の銘柄と同じインデント・空行・コメント様式で書く。
**編集するのはこの yaml だけ。写経先は手で触らない。**

### 4. 生成を走らせる

```
npm run gen:watchlist
```

`watchlist.gen.ts` と 2 つの workflow yml の options が yaml から再生成される。
更新されたファイルが `updated ...` で表示される。

### 5. 検証する

```
npm run check:watchlist
```

「watchlist 生成物は config/watchlist.yaml と一致しています。」が出ればOK。
ズレが出たら gen を再実行する (通常は手で yaml 以外を触ったときだけ起きる)。

### 6. 結果を 1 行で報告する

stdout に narration 抜きで:

```
add-ticker <code> (<name>) → watchlist.yaml + gen mirrors, check:watchlist <ok|FAIL>
```

推定値を入れた場合 (next_earnings_date / fair_per など) はその 1 点だけ併記する。
価格・context・Slack には触れていないこと、初回データは次の cron / workflow が拾うことを添える。
