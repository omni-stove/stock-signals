-- stock-signals D1 スキーマ (PoC: IR取得)
--
-- ローカルのファイル版 data/seen.txt + data/queue/<code>/*.json の役割を、
-- D1 (構造データ/重複排除) と R2 (記事本文JSON) に分担させる。
-- このファイルは D1 側 (構造データ) を定義する。

-- 取得した記事のメタ情報。本文は R2 に置き、ここには参照キー(r2_key)を持つ。
-- url を一意キーにすることで、ローカルの seen.txt (URLハッシュ重複排除) と同じ働きをする。
CREATE TABLE IF NOT EXISTS articles (
  url           TEXT PRIMARY KEY,       -- 記事URL (重複排除キー)
  ticker        TEXT NOT NULL,          -- 銘柄コード (例 285A)
  source        TEXT NOT NULL,          -- 取得元 (例 ir:kioxia:285A)
  title         TEXT NOT NULL,
  published_at  TEXT,                   -- YYYY-MM-DD
  ir_category   TEXT,                   -- holdings / corporate / business / personal
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
