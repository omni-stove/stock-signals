// Drizzle スキーマ定義 (D1 / SQLite)。このファイルがスキーマの唯一の情報源 (single source of truth)。
//
// 各 lib は db.insert(prices).values({...}) のようにカラム名で書く (bind 引数順ミスを型で防ぐ)。
//
// スキーマ変更フロー (worker/README.md 参照):
//   1. このファイルを編集
//   2. pnpm db:generate            → drizzle/ に差分 migration SQL を生成
//   3. pnpm db:migrate:local       → ローカル D1 に適用 (リモートは :remote)
// drizzle-kit が差分 (ADD COLUMN / CREATE TABLE / PK 変更時の table 再作成) を生成するため、
// 全テーブルを DROP して作り直す初期化スクリプトを流す事故が起きない。

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

// ── market_news (銘柄に紐付かない市場テーマニュース。PK = url) ───────────────
// 株探の市場ニュース総合 (https://kabutan.jp/news/marketnews/) から、半導体/AI/金利/米国市場の
// テーマに当たった見出しだけを拾う。銘柄が確定しない (= articles.ticker を持てない) ため別テーブル。
// 地合い判定 (market-check) が /market-context 経由で最新数件を読む。重複排除は url PK + INSERT OR IGNORE。
// topic は当たったテーマタグ (semi|ai|rates|us を "," 連結。複数該当しうる)。本文は R2 に置く。
export const marketNews = sqliteTable(
	"market_news",
	{
		url: text("url").primaryKey(),
		title: text("title").notNull(),
		topic: text("topic").notNull(),
		publishedAt: text("published_at"),
		r2Key: text("r2_key").notNull(),
		fetchedAt: text("fetched_at").notNull(),
	},
	(t) => [index("idx_market_news_fetched").on(sql`${t.fetchedAt} DESC`)],
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

// ── forced_liquidation (強制決済スコア。冪等キー = (ticker, date)) ───────────
// 「他プレイヤーの強制的な売買フロー」(追証売り=買い方のロスカット / 踏み上げ=売り方のロスカット)
// を eod cron で決定論的に算出して保存する。judge-context が最新行を forced ブロックとして
// judge (signal-judge=LLM) に渡し「投げ/踏みが今日いつ出るか」の推論材料にする。post-signal.sh も
// 投稿時にここから最新行を引き、stance!=none のとき観測行を本文末尾に貼る。direction は
// long(投げ)/short(踏み上げ)、stance は building(これから出る)/exhausted(出尽くし)/none(対象外)。
export const forcedLiquidation = sqliteTable(
	"forced_liquidation",
	{
		ticker: text("ticker").notNull(),
		date: text("date").notNull(),
		direction: text("direction").notNull(), // long | short | none
		stance: text("stance").notNull(), // building | exhausted | none
		fuel: integer("fuel").notNull(), // 0..3
		fire: integer("fire").notNull(), // 0..3
		exhaust: integer("exhaust").notNull(), // 0..3
		settleWarningInDays: integer("settle_warning_in_days"), // building のときだけ猶予営業日数
		summary: text("summary").notNull(), // Slack/judge にそのまま載せられる1行平文
		fetchedAt: text("fetched_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.ticker, t.date] }),
		index("idx_forced_liquidation_ticker_date").on(
			t.ticker,
			sql`${t.date} DESC`,
		),
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
// 銘柄の living document。本文と IR/news の2カーソルを同じ行に持ち、本文の全面上書きと
// カーソル前進を1 upsert で原子的に行う。
//   body     … 見出し+本文を素テキスト連結したもの。judge-context が LLM へ、context-builder が
//              再生入力としてそのまま読む (人間向け装飾を混ぜない)。
//   sections … 同じ内容を [{heading, lines[]}] で持つ JSON。Slack 通知の blocks 化に使う
//              (body からは見出し境界を機械復元できないため別に持つ)。lib/context-format.ts で両者を生成。
export const contexts = sqliteTable("contexts", {
	ticker: text("ticker").primaryKey(),
	body: text("body").notNull(),
	sections: text("sections"),
	irLastFetchedAt: text("ir_last_fetched_at"),
	newsLastFetchedAt: text("news_last_fetched_at"),
	updatedAt: text("updated_at").notNull(),
});

// ── market_regime (当日の地合いコール。PK = JST暦日) ─────────────────────────
// 当日の地合い (リスクオン/中立/リスクオフ + 拾い場/様子見/守り) を 1 行で控える。
// 1日1行 (当日分を upsert で上書き)。
export const marketRegime = sqliteTable("market_regime", {
	date: text("date").primaryKey(),
	regime: text("regime").notNull(),
	stance: text("stance").notNull(),
	headline: text("headline").notNull(),
	fetchedAt: text("fetched_at").notNull(),
});

// ── signals (signal-judge の最新判定。PK = ticker) ───────────────────────────
// signal-judge が銘柄ごとに出す方向 (buy/sell) + 価格ラインを 1 銘柄 1 行で控える。
// 判定本体は GitHub Actions の signal-judge スキルが out-file に書き、その末尾に機械可読な
// signal JSON (side/line/stop/rr) を 1 行で添える。post-signal.sh がその JSON を抜き出して
// /slack/post に signal フィールドとして渡し、投稿経路 (misc.ts /slack/post) がここに upsert
// する (market_regime を同経路で控えるのと同じ流儀)。判定の度に当該銘柄を上書きするので、常に
// 各銘柄の最新コールが 1 行残る。ポジション評価 (eod cron) がこの行を引き、ユーザーの建値
// (positions) と決定論的に突き合わせて利確/損切り/継続を DM する。
export const signals = sqliteTable("signals", {
	ticker: text("ticker").primaryKey(), // 銘柄コード (例 285A)
	side: text("side").notNull(), // buy (買い場) | sell (売り場) — judge の方向 1 本
	exec: text("exec").notNull().default("now"), // now (現値約定) | wait (line で指値待ち) — 約定タイミング
	line: text("line"), // 約定価格 (数値文字列)。now=現値なので null、wait=その指値。読めなければ null
	stop: text("stop"), // 損切りライン (価格 or MA/range 表現)。読めなければ null
	rr: text("rr"), // リスクリワード 良 | 可 | 薄。読めなければ null
	headline: text("headline").notNull(), // 判定の headline 全文 (DM 文面に流用)
	judgedAt: text("judged_at").notNull(), // 保存時刻 (ISO8601)
});

// ── positions (ユーザーの保有ポジション。冪等キー = (userId, ticker, account)) ──
// ユーザーが /position コマンドで登録する自分の建玉。判定 (signal-judge / crash-scenario) は
// 汎用のまま据え置き、これは slack-reply だけが読む (スレッド返信で「建値から見て今どうか」を
// 答えるため)。/thread-context が返信した本人 (userId) の当該銘柄行を引いて positions ブロックに同梱する。
//
// 建玉は Slack ユーザー単位で持つ (userId = 登録/返信した本人の Slack user_id)。複数人で使っても
// 各自の建玉が混ざらないよう、PK に userId を含める。
// 銘柄ごとに現物 (account=cash) と信用 (account=margin) を1行ずつ持てる (PK=(userId, ticker, account))。
// 同じ口座区分に複数ロットは持たず「平均建値」1本に集約する (ナンピンは平均建値を入れ直す)。
// side は現物なら通常 long だが、信用の売建を許容するため別フィールドで持つ。
// 登録は INSERT OR REPLACE で上書き。qty<=0 を登録したら手仕舞い扱いで行ごと削除する (routes 側)。
export const positions = sqliteTable(
	"positions",
	{
		userId: text("user_id").notNull(), // 登録/返信した本人の Slack user_id (例 U0123ABCD)
		ticker: text("ticker").notNull(), // 銘柄コード (例 285A)
		account: text("account").notNull(), // cash (現物) | margin (信用)
		side: text("side").notNull(), // long (買い建て) | short (売り建て)
		avgPrice: real("avg_price").notNull(), // 平均建値 (円)
		qty: integer("qty").notNull(), // 株数
		updatedAt: text("updated_at").notNull(), // 最終更新時刻 (ISO8601)
	},
	(t) => [primaryKey({ columns: [t.userId, t.ticker, t.account] })],
);

// ── user_profiles (ユーザーの好み・特記事項。PK = userId) ──────────────────────
// ユーザーが /profile コマンドで登録する自分の売買スタイル。判定 (signal-judge / crash-scenario)
// は汎用のまま据え置き、これは positions と同じく slack-reply だけが読む (スレッド返信で「この人の
// 玉の持ち方・リスク許容度を踏まえて」答えるため)。/thread-context が返信した本人 (userId) の行を
// 引いて profile ブロックに同梱する。
//
// プロフィールは Slack ユーザー単位 (userId = 登録/返信した本人の Slack user_id)、1 ユーザー 1 行。
// 構造化フィールド (リスク許容度 / 保有スタイル / 最大ポジション率) と自由記述 (note) を併せ持つ。
// 構造化に収まらない特記事項 (「玉は分割で建てる」「決算跨ぎは持たない」等) は note に書く。
// 登録は upsert で上書き。全フィールド空を登録したらプロフィール解除として行ごと削除する (routes 側)。
export const userProfiles = sqliteTable("user_profiles", {
	userId: text("user_id").primaryKey(), // 登録/返信した本人の Slack user_id (例 U0123ABCD)
	riskTolerance: text("risk_tolerance"), // low | mid | high (リスク許容度)
	holdStyle: text("hold_style"), // swing | day | mid_long (保有スタイル = 玉の持ち方の基本)
	maxPositionPct: real("max_position_pct"), // 1銘柄あたり最大ポジション率 (%)。任意
	cashBalance: real("cash_balance"), // 投資余力 (現金残高、円)。任意
	note: text("note"), // 自由記述の特記事項。任意
	updatedAt: text("updated_at").notNull(), // 最終更新時刻 (ISO8601)
});
