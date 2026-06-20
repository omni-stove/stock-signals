// Drizzle スキーマ定義 (D1 / SQLite)。
//
// 従来は worker/schema.sql (手書きDDL) と各 lib の `INSERT INTO ...(col, ...)` 文に
// テーブル形状が二重定義されていた。ここを型の単一情報源にし、各 lib は
// db.insert(prices).values({...}) のようにカラム名で書く (bind 引数順ミスを型で防ぐ)。
//
// schema.sql は引き続き `pnpm db:init:*` が初期化に使う DDL の出所として残す。
// このファイルと schema.sql は手で同期させる (drizzle-kit generate を使う場合は後述)。
// → 段階移行中のため、当面は schema.sql を正とし、こちらは「型 + Drizzle 用ハンドル」。

import { sql } from "drizzle-orm";
import {
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

// ── articles ────────────────────────────────────────────────────────────────
export const articles = sqliteTable(
	"articles",
	{
		url: text("url").primaryKey(),
		ticker: text("ticker").notNull(),
		source: text("source").notNull(),
		title: text("title").notNull(),
		publishedAt: text("published_at"),
		irCategory: text("ir_category"),
		r2Key: text("r2_key").notNull(),
		fetchedAt: text("fetched_at").notNull(),
	},
	(t) => [
		index("idx_articles_ticker_fetched").on(t.ticker, sql`${t.fetchedAt} DESC`),
		index("idx_articles_category").on(
			t.ticker,
			t.irCategory,
			sql`${t.publishedAt} DESC`,
		),
	],
);

// ── prices (5分足スナップショット。冪等キー = (ticker, slot)) ────────────────
export const prices = sqliteTable(
	"prices",
	{
		ticker: text("ticker").notNull(),
		slot: text("slot").notNull(),
		source: text("source").notNull(),
		price: real("price"),
		change: real("change"),
		changePct: real("change_pct"),
		volume: integer("volume"),
		quoteTime: text("quote_time"),
		ptsPrice: real("pts_price"),
		ptsTime: text("pts_time"),
		fetchedAt: text("fetched_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.ticker, t.slot] }),
		index("idx_prices_ticker_time").on(t.ticker, sql`${t.fetchedAt} DESC`),
	],
);

// ── daily (日足 OHLC。冪等キー = (ticker, date)) ────────────────────────────
export const daily = sqliteTable(
	"daily",
	{
		ticker: text("ticker").notNull(),
		date: text("date").notNull(),
		source: text("source").notNull(),
		open: real("open"),
		high: real("high"),
		low: real("low"),
		close: real("close"),
		change: real("change"),
		changePct: real("change_pct"),
		volume: integer("volume"),
		fetchedAt: text("fetched_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.ticker, t.date] }),
		index("idx_daily_ticker_date").on(t.ticker, sql`${t.date} DESC`),
	],
);

// ── fundamentals (今期予想PER/EPS 等。冪等キー = (ticker, date)) ─────────────
export const fundamentals = sqliteTable(
	"fundamentals",
	{
		ticker: text("ticker").notNull(),
		date: text("date").notNull(),
		source: text("source").notNull(),
		per: real("per"),
		pbr: real("pbr"),
		dividendYield: real("dividend_yield"),
		forecastEps: real("forecast_eps"),
		forecastPeriod: text("forecast_period"),
		actualEps: real("actual_eps"),
		actualPeriod: text("actual_period"),
		fetchedAt: text("fetched_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.ticker, t.date] }),
		index("idx_fundamentals_ticker_date").on(t.ticker, sql`${t.date} DESC`),
	],
);

// ── premarket_backdrop (寄り前の地合い。PK = fetched_at) ─────────────────────
export const premarketBackdrop = sqliteTable("premarket_backdrop", {
	fetchedAt: text("fetched_at").primaryKey(),
	soxChangePct: real("sox_change_pct"),
	nasdaqChangePct: real("nasdaq_change_pct"),
	dowChangePct: real("dow_change_pct"),
	nikkeiFuturesPrice: real("nikkei_futures_price"),
	nikkeiContract: text("nikkei_contract"),
	usIndexesJson: text("us_indexes_json"),
});

// ── earnings (次回決算発表予定日。PK = ticker) ──────────────────────────────
export const earnings = sqliteTable("earnings", {
	ticker: text("ticker").primaryKey(),
	nextDate: text("next_date"),
	detail: text("detail"),
	fetchedAt: text("fetched_at").notNull(),
});

// ── intraday_dispatch (場中 dispatch のデバウンス。PK = ticker) ─────────────
export const intradayDispatch = sqliteTable("intraday_dispatch", {
	ticker: text("ticker").primaryKey(),
	lastDispatchAt: text("last_dispatch_at").notNull(),
});

// ── slack_threads (Slack スレッド ts ⇄ 銘柄。PK = thread_ts) ────────────────
export const slackThreads = sqliteTable("slack_threads", {
	threadTs: text("thread_ts").primaryKey(),
	ticker: text("ticker").notNull(),
	kind: text("kind").notNull(),
	channel: text("channel").notNull(),
	createdAt: text("created_at").notNull(),
});

// ── margin (信用残。冪等キー = (ticker, date)) ──────────────────────────────
export const margin = sqliteTable(
	"margin",
	{
		ticker: text("ticker").notNull(),
		date: text("date").notNull(),
		source: text("source").notNull(),
		shortQty: real("short_qty"),
		longQty: real("long_qty"),
		ratio: real("ratio"),
		fetchedAt: text("fetched_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.ticker, t.date] }),
		index("idx_margin_ticker_date").on(t.ticker, sql`${t.date} DESC`),
	],
);

// ── macro_events (FOMC/日銀 会合日程。冪等キー = (date, kind)) ────────────────
export const macroEvents = sqliteTable(
	"macro_events",
	{
		date: text("date").notNull(),
		kind: text("kind").notNull(),
		label: text("label").notNull(),
		impact: text("impact").notNull(),
		jstEffectDate: text("jst_effect_date"),
		note: text("note"),
		fetchedAt: text("fetched_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.date, t.kind] }),
		index("idx_macro_events_date").on(t.date),
	],
);

// ── contexts (銘柄 living document。PK = ticker) ─────────────────────────────
// 従来 GitHub Issue 本文に持っていた living document を D1 に移したもの。本文(markdown)と
// IR/news の2カーソルを同じ行に持ち、本文の全面上書きとカーソル前進を1 upsert で原子的に行う。
export const contexts = sqliteTable("contexts", {
	ticker: text("ticker").primaryKey(),
	body: text("body").notNull(),
	irLastFetchedAt: text("ir_last_fetched_at"),
	newsLastFetchedAt: text("news_last_fetched_at"),
	updatedAt: text("updated_at").notNull(),
});
