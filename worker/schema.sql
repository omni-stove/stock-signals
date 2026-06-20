-- stock-signals D1 スキーマ (PoC: IR取得)
--
-- ローカルのファイル版 data/seen.txt + data/queue/<code>/*.json の役割を、
-- D1 (構造データ/重複排除) と R2 (記事本文JSON) に分担させる。
-- このファイルは D1 側 (構造データ) を定義する。

-- 取得した記事のメタ情報。本文は R2 に置き、ここには参照キー(r2_key)を持つ。
-- url を一意キーにすることで、ローカルの seen.txt (URLハッシュ重複排除) と同じ働きをする。
-- IR (source=ir:<site>:<code>) と per_ticker ニュース (source=kabutan:<code>) を同居させ、
-- signal-report は source で IR/ニュースを振り分けて両方を判定材料にする。
-- ニュース記事は ir_category=NULL。
CREATE TABLE IF NOT EXISTS articles (
  url           TEXT PRIMARY KEY,       -- 記事URL (重複排除キー)
  ticker        TEXT NOT NULL,          -- 銘柄コード (例 285A)
  source        TEXT NOT NULL,          -- 取得元 (例 ir:kioxia:285A / kabutan:285A)
  title         TEXT NOT NULL,
  published_at  TEXT,                   -- YYYY-MM-DD
  ir_category   TEXT,                   -- IRのみ: holdings / corporate / business / personal。ニュースはNULL
  r2_key        TEXT NOT NULL,          -- R2 上の本文JSONのキー
  fetched_at    TEXT NOT NULL           -- 取得時刻 (ISO8601)
);

-- 銘柄ごと・新着順に引くためのインデックス (analyze-ticker が「未処理の新着」を取る用途)。
CREATE INDEX IF NOT EXISTS idx_articles_ticker_fetched
  ON articles (ticker, fetched_at DESC);

-- カテゴリで絞る用 (holdings=適時開示だけ見たい等)。
CREATE INDEX IF NOT EXISTS idx_articles_category
  ON articles (ticker, ir_category, published_at DESC);

-- ── 時系列データ ────────────────────────────────────────────────────────
-- ローカルの data/{prices,daily,fundamentals}/<code>.jsonl (append-only) を
-- D1 テーブルに移したもの。R2 は本文1記事=1オブジェクト向きで追記できないため、
-- 5分毎に積み上がる時系列は D1 が正解。冪等性は複合 PRIMARY KEY が担保し、
-- INSERT OR IGNORE だけで二重取得を弾く (ローカルの seen.txt/loadKnownDates 相当)。

-- 5分足スナップショット。冪等キー = (ticker, slot)。
--   slot = quote_time があればそれ、無ければ fetched_at を5分に丸めた値。
--   これで「同じ5分枠を二度取っても1行」になる (cron 多重発火・手動再実行に耐える)。
CREATE TABLE IF NOT EXISTS prices (
  ticker      TEXT NOT NULL,          -- 銘柄コード
  slot        TEXT NOT NULL,          -- 冪等キー (quote_time or fetched_at の5分丸め)
  source      TEXT NOT NULL,          -- 取得元 (例 kabutan:285A)
  price       REAL,                   -- 現値
  change      REAL,                   -- 前日比 (円)
  change_pct  REAL,                   -- 前日比 (%)
  volume      INTEGER,                -- 出来高
  quote_time  TEXT,                   -- 値付き時刻 (ISO8601 or null=場外)
  pts_price   REAL,                   -- PTS現値 (なければ null)
  pts_time    TEXT,                   -- PTS時刻
  fetched_at  TEXT NOT NULL,          -- 取得時刻 (ISO8601)
  PRIMARY KEY (ticker, slot)
);
CREATE INDEX IF NOT EXISTS idx_prices_ticker_time
  ON prices (ticker, fetched_at DESC);

-- 日足 OHLC。冪等キー = (ticker, date)。ローカルの loadKnownDates の役割を PK が担う。
CREATE TABLE IF NOT EXISTS daily (
  ticker      TEXT NOT NULL,
  date        TEXT NOT NULL,          -- YYYY-MM-DD (確定足)
  source      TEXT NOT NULL,
  open        REAL,
  high        REAL,
  low         REAL,
  close       REAL,
  change      REAL,
  change_pct  REAL,
  volume      INTEGER,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (ticker, date)
);
CREATE INDEX IF NOT EXISTS idx_daily_ticker_date
  ON daily (ticker, date DESC);

-- ファンダ指標 (今期予想PER/EPS・直近実績EPS)。冪等キー = (ticker, date)。
--   同日に複数回取っても1行 (INSERT OR REPLACE で最新値に更新する想定)。
CREATE TABLE IF NOT EXISTS fundamentals (
  ticker          TEXT NOT NULL,
  date            TEXT NOT NULL,      -- YYYY-MM-DD (取得日)
  source          TEXT NOT NULL,
  per             REAL,               -- 今期予想ベース PER
  pbr             REAL,
  dividend_yield  REAL,
  forecast_eps    REAL,               -- 今期予想 1株益
  forecast_period TEXT,               -- 例 2027.03
  actual_eps      REAL,               -- 直近実績 1株益
  actual_period   TEXT,
  fetched_at      TEXT NOT NULL,
  PRIMARY KEY (ticker, date)
);
CREATE INDEX IF NOT EXISTS idx_fundamentals_ticker_date
  ON fundamentals (ticker, date DESC);

-- ── 寄り前の地合い ──────────────────────────────────────────────────────
-- ローカルの scripts/fetch-premarket.ts (前夜マーケットモード) が
-- data/premarket/<date>.jsonl に残していた「今日の地合い」を D1 に移したもの。
-- 前夜の米国市場 (とくに SOX) と日経先物が寄り付きの方向をかなり決めるため、
-- 寄り前ブリーフ (premarket-brief skill) の主入力になる。
-- PK = fetched_at (UTC ISO8601) の append-only ログ。暦日 (JST/ET の「日」) を一切
-- 持たないことで時差ズレを構造的に排除する。最新の地合いは fetched_at DESC LIMIT 1。
-- 同じ NY クローズを複数回取ると複数行残るが、最新取得が勝つので実害なし (履歴にもなる)。
-- ※寄前気配 (kehai) は寄りが読めないため移植せず、地合いのみ。
--
-- ── マイグレーション (2026-06-19): PK を date(JST暦日) → fetched_at(UTC) に変更 ──
-- CREATE IF NOT EXISTS では既存テーブルの PK は変わらないため、旧スキーマを一度落とす。
-- 地合いは日々取り直す揮発データで履歴保持の必要がないため DROP して問題ない。
-- ※旧 PK が一掃され全環境が新スキーマになったら、この DROP 行は削除してよい。
DROP TABLE IF EXISTS premarket_backdrop;
CREATE TABLE IF NOT EXISTS premarket_backdrop (
  fetched_at           TEXT PRIMARY KEY,  -- 取得時刻 (UTC ISO8601)。これが冪等/順序キー
  sox_change_pct       REAL,              -- SOX 前日比% (半導体銘柄の地合い主指標)
  nasdaq_change_pct    REAL,              -- ナスダック総合 前日比%
  dow_change_pct       REAL,              -- NYダウ 前日比%
  nikkei_futures_price REAL,              -- CME日経225先物(ドル建て) 現値
  nikkei_contract      TEXT,              -- 限月 (例 6月限)
  us_indexes_json      TEXT               -- 指数明細の生配列 (現値/前日比/参照時刻) を JSON 文字列で保持
);

-- ── 次回決算発表予定日 ──────────────────────────────────────────────────
-- ローカルの scripts/fetch-earnings-date.ts が watchlist.yaml の next_earnings_date を
-- 自動更新していた役割を D1 に移したもの。kabutan finance ページの四半期業績テーブルから
-- 「直近実績の次四半期 = 前年同期の発表日 +1年」で推定する。
-- Worker は読み取り専用FSで watchlist.yaml に書き戻せないため、推定結果は D1 を source とする。
-- 銘柄ごと1行 (INSERT OR REPLACE で最新の推定値に上書き)。
-- signal-report は /latest?kind=earnings で読み、決算が近ければ confidence をキャップする。
CREATE TABLE IF NOT EXISTS earnings (
  ticker          TEXT PRIMARY KEY,    -- 銘柄コード
  next_date       TEXT,                -- 次回決算発表予定日 YYYY-MM-DD (推定不可なら null)
  detail          TEXT,                -- 推定根拠 (last/prior 四半期と発表日)
  fetched_at      TEXT NOT NULL        -- 取得時刻 (ISO8601)
);

-- ── 場中 dispatch のデバウンス ────────────────────────────────────────────
-- 場中 (prices cron, 5分毎) は同じ銘柄に短時間で複数の新着ニュースが出ると、
-- スロットごとに独立して signal-update を dispatch してしまい、context-builder→
-- signal-judge の LLM 2段が数分おきに連発する (サブスク枠の浪費)。
-- 銘柄ごとに「最後に場中 dispatch した時刻」を持ち、デバウンス窓 (15分) 以内なら
-- その回の dispatch を見送る。見送っても新着記事はカーソル未更新のまま残り、
-- 次にデバウンスが明けたスロットで context-builder がまとめて拾うので取りこぼしゼロ。
-- intake cron (寄り前/引け後) はこのテーブルを参照せず常に dispatch する (1日数回・地合い込みの重要判定)。
-- 銘柄ごと1行 (INSERT OR REPLACE で最新の dispatch 時刻に上書き)。
CREATE TABLE IF NOT EXISTS intraday_dispatch (
  ticker           TEXT PRIMARY KEY,   -- 銘柄コード
  last_dispatch_at TEXT NOT NULL       -- 最後に場中 dispatch した時刻 (UTC ISO8601)
);

-- ── 信用取引残高 (信用残) ────────────────────────────────────────────────
-- 東証/日証金が毎週金曜時点の信用建玉を集計し翌週公表する週次の需給データ。kabutan の個別
-- 銘柄ページ内の信用残テーブルから取得する (1回で過去5週分が返る)。判断 (買い長で上値重い等)
-- は signal-judge に委ねる。
--
-- 冪等キー = (ticker, date)。date は取得日ではなく kabutan の集計基準日 (毎週金曜)。intake cron
-- が毎日走っても同じ週は同一 date となり INSERT OR IGNORE で1週1行に収束する (daily と同じ流儀)。
-- 過去5週が返るので数日 Worker が落ちても次回でまとめて拾える。kabutan の "06/12" (年なし) は
-- collectMargin が「未来日付なら前年」で YYYY-MM-DD に補完する。
-- ── Slack スレッド対話 (解析結果 ts ⇄ 銘柄) ──────────────────────────────
-- 解析結果 (signal-judge / crash-scenario) を Bot トークンで chat.postMessage したとき
-- 返ってくる ts を銘柄とともに控える。ユーザーがその投稿にスレッド返信すると Slack は
-- thread_ts=親の ts を載せて送ってくるので、ここを引けば「どの銘柄の解析への返信か」を
-- 復元できる (返信本文からの銘柄パースに依存しない)。返信を受けた /slack/events は
-- thread_ts でこの表を引き、ヒットした時だけ slack-reply ワークフローを dispatch する
-- (= watchlist 外の雑談スレッドには反応しない誤発火防止も兼ねる)。
-- 銘柄ごとに投稿は何度も出るので thread_ts (= 各投稿の ts) を PK にして1投稿1行。
CREATE TABLE IF NOT EXISTS slack_threads (
  thread_ts   TEXT PRIMARY KEY,       -- 親メッセージの ts (スレッドキー)
  ticker      TEXT NOT NULL,          -- 銘柄コード (例 285A)
  kind        TEXT NOT NULL,          -- 解析の種類 (signal-judge / crash-scenario)
  channel     TEXT NOT NULL,          -- 投稿先チャンネルID (返信投稿/履歴取得に要る)
  created_at  TEXT NOT NULL           -- 投稿時刻 (ISO8601)
);

-- ── 信用取引残高 (信用残) ────────────────────────────────────────────────
-- 東証/日証金が毎週金曜時点の信用建玉を集計し翌週公表する週次の需給データ。kabutan の個別
-- 銘柄ページ内の信用残テーブルから取得する (1回で過去5週分が返る)。判断 (買い長で上値重い等)
-- は signal-judge に委ねる。
--
-- 冪等キー = (ticker, date)。date は取得日ではなく kabutan の集計基準日 (毎週金曜)。intake cron
-- が毎日走っても同じ週は同一 date となり INSERT OR IGNORE で1週1行に収束する (daily と同じ流儀)。
-- 過去5週が返るので数日 Worker が落ちても次回でまとめて拾える。kabutan の "06/12" (年なし) は
-- collectMargin が「未来日付なら前年」で YYYY-MM-DD に補完する。
CREATE TABLE IF NOT EXISTS margin (
  ticker      TEXT NOT NULL,          -- 銘柄コード
  date        TEXT NOT NULL,          -- 集計基準日 YYYY-MM-DD (毎週金曜)。冪等キー
  source      TEXT NOT NULL,          -- 取得元 (例 kabutan:285A)
  short_qty   REAL,                   -- 信用売残 (千株)
  long_qty    REAL,                   -- 信用買残 (千株)
  ratio       REAL,                   -- 信用倍率 (買残/売残)。算出不能は null
  fetched_at  TEXT NOT NULL,          -- 取得時刻 (ISO8601)
  PRIMARY KEY (ticker, date)
);
CREATE INDEX IF NOT EXISTS idx_margin_ticker_date
  ON margin (ticker, date DESC);

-- ── マクロイベント (FOMC / 日銀金融政策決定会合) ──────────────────────────
-- SQ や指数リバランスのように規則計算できない「会合系」イベントの日程。従来は config/events.yaml に
-- 人間が年1回手動転記していたが (README「イベントカレンダーメンテナンス」)、公式が年単位で先の全日程を
-- 出すので Worker が定期スクレープ (worker/src/lib/macro-events.ts) して保持し手動メンテを無くす。
-- eod cron に月初相乗りで更新 (会合は年8回・先の日程が確定公表されており月1で十分)。
-- SQ / 指数リバランスは scripts/event-context.sh が日付計算で出すのでここには入れない。
--
-- 冪等キー = (date, kind)。同じ会合を再スクレープしても1行に収束し、label/note は最新に上書きされる。
-- event-context.sh が /latest?kind=macro-events で読み、近接 (直近5日) イベントを prompt に乗せる。
-- jst_effect_date は「日本市場に効く営業日」: 米国(FOMC)は翌営業日なので翌日, 日銀は当日なので NULL。
CREATE TABLE IF NOT EXISTS macro_events (
  date            TEXT NOT NULL,       -- イベント日 / 結果発表日 YYYY-MM-DD
  kind            TEXT NOT NULL,       -- fomc / boj
  label           TEXT NOT NULL,       -- 表示名
  impact          TEXT NOT NULL,       -- high (会合は全て high 想定)
  jst_effect_date TEXT,                -- 日本市場に効く日 (米国=翌日, 日銀=NULL=当日)
  note            TEXT,                -- 補足
  fetched_at      TEXT NOT NULL,       -- 取得時刻 (ISO8601)
  PRIMARY KEY (date, kind)
);
CREATE INDEX IF NOT EXISTS idx_macro_events_date
  ON macro_events (date);

-- ── 銘柄コンテキスト (living document) ──────────────────────────────────────
-- 従来 GitHub Issue 本文に持っていた「銘柄の living document」(事業の骨格 / 商品ライン
-- ナップ・技術ロードマップ / 経営判断・資本政策 / 直近の重大トピック / 証券会社レーティング /
-- 決算・ガイダンス) を D1 に移したもの。人間が直接読む UI ではなく、context-builder が
-- 書き、signal-judge / crash-scenario / slack-reply が読む内部ストア。
--
-- 銘柄ごと1行 (PK=ticker, INSERT OR REPLACE で本文を全面上書き)。本文(markdown)と、
-- 次回取得開始点となる2カーソル (IR / news の last_fetched_at) を同じ行に持つ。本文の
-- 上書きとカーソル前進を1回の upsert で原子的に行うことで、本文更新は成ったがカーソルが
-- 進まない (= 二重取得) / カーソルだけ進んで本文が古い (= 取りこぼし) を構造的に排除する。
-- カーソル未確立 (初回) は NULL → /pull は since 省略で直近 backlog を引く。
CREATE TABLE IF NOT EXISTS contexts (
  ticker               TEXT PRIMARY KEY,   -- 銘柄コード (例 285A)
  body                 TEXT NOT NULL,      -- living document 本体 (markdown)
  ir_last_fetched_at   TEXT,               -- IR カーソル (次回 /pull の since)。未確立は NULL
  news_last_fetched_at TEXT,               -- news カーソル (次回 /pull-news の since)。未確立は NULL
  updated_at           TEXT NOT NULL       -- 最終更新時刻 (ISO8601)
);
