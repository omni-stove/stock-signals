// Drizzle スキーマ定義 (D1 / SQLite)。このファイルがスキーマの唯一の情報源 (single source of truth)。
//
// 各 lib は db.insert(prices).values({...}) のようにカラム名で書く (bind 引数順ミスを型で防ぐ)。
//
// スキーマ変更フロー (worker/README.md 参照):
//   1. このファイルを編集
//   2. pnpm db:generate            → drizzle/ に差分 migration SQL を生成
//   3. push で CI がリモート D1 に適用 (手動なら pnpm db:migrate:remote)
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
// 株探の市場ニュース総合 (https://kabutan.jp/news/marketnews/) から、半導体/AI/金利/米国市場/政策/市況の
// テーマに当たった見出しだけを拾う。銘柄が確定しない (= articles.ticker を持てない) ため別テーブル。
// マーケットブリーフ (market-brief) が /market-context 経由で最新数件を読み、/context-input が見出しの
// 銘柄言及 (matchTickers) で当該銘柄の news_items に混ぜる。重複排除は url PK + INSERT OR IGNORE。
// topic は当たったテーマタグ (semi|ai|rates|us|policy|market を "," 連結。複数該当しうる)。本文は R2 に置く。
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
		// 今期会社予想 (forecast_period 行) の売上高・経常益・最終益 (億円)、1株配 (円)、予想の発表日。
		// 日次スナップショットを並べると、発表日か値が変わった日 = 業績予想の修正日になる。
		forecastSales: real("forecast_sales"),
		forecastOrdinary: real("forecast_ordinary"),
		forecastNet: real("forecast_net"),
		forecastDividend: real("forecast_dividend"),
		forecastAnnouncedAt: text("forecast_announced_at"),
		fetchedAt: text("fetched_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.ticker, t.date] }),
		index("idx_fundamentals_ticker_date").on(t.ticker, sql`${t.date} DESC`),
	],
);

// ── live_indexes (場中リアルタイム指数。冪等キー = (key, slot)) ──────────────
// prices と同じ「5分枠で1行」モデル (slot5min)。前夜確定の premarket_backdrop と違い、
// 場中に同時進行で動く指数 (日経225 / KOSPI 等) の最新現値を貯める。key は指数の識別子。
export const liveIndexes = sqliteTable(
	"live_indexes",
	{
		key: text("key").notNull(),
		slot: text("slot").notNull(),
		source: text("source").notNull(),
		price: real("price"),
		change: real("change"),
		changePct: real("change_pct"),
		quoteTime: text("quote_time"),
		fetchedAt: text("fetched_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.key, t.slot] }),
		index("idx_live_indexes_key_time").on(t.key, sql`${t.fetchedAt} DESC`),
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
	vixPrice: real("vix_price"),
	vixChangePct: real("vix_change_pct"),
	usdjpyPrice: real("usdjpy_price"),
	usdjpyChange: real("usdjpy_change"),
	us10yYield: real("us10y_yield"),
	us10yChangeBp: real("us10y_change_bp"),
	us10yDate: text("us10y_date"),
	usIndexesJson: text("us_indexes_json"),
	// 海外ピア (peer-earnings.ts の SOX_PEERS) の前夜の騰落。[{ticker, change_pct, jst_time}] の JSON。
	usPeersJson: text("us_peers_json"),
});

// ── earnings (次回決算発表予定日と通期会社予想。PK = ticker) ──────────────────
// estimated は next_date の出所: true = 株探の前年同期発表日 +1年の推定、false = JPX 決算発表予定日一覧の公表日。
// forecast_* は株探 finance ページ通期表の予想行 (百万円)。fundamentals.forecast_* (株探トップ、億円) とは
// 単位が違うので、四半期実績 (earnings_quarters) との進捗率はこちらで割る。
export const earnings = sqliteTable("earnings", {
	ticker: text("ticker").primaryKey(),
	nextDate: text("next_date"),
	estimated: integer("estimated", { mode: "boolean" }).notNull().default(true),
	detail: text("detail"),
	forecastPeriod: text("forecast_period"),
	forecastSales: real("forecast_sales"),
	forecastOperating: real("forecast_operating"),
	forecastOrdinary: real("forecast_ordinary"),
	forecastNet: real("forecast_net"),
	fetchedAt: text("fetched_at").notNull(),
});

// ── earnings_quarters (四半期 3ヵ月実績。冪等キー = (ticker, period)) ─────────
// 株探 finance ページの3ヵ月決算表。period は "2026.07-09" (開始月の西暦年)、金額は百万円。
export const earningsQuarters = sqliteTable(
	"earnings_quarters",
	{
		ticker: text("ticker").notNull(),
		period: text("period").notNull(),
		sales: real("sales"),
		operating: real("operating"),
		ordinary: real("ordinary"),
		net: real("net"),
		announcedAt: text("announced_at"),
		fetchedAt: text("fetched_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.ticker, t.period] })],
);

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

// ── jsf_balance (日証金の貸借取引残高。冪等キー = (ticker, date)) ──────────────
// 日証金の貸借取引残高 CSV (1 申込日分・全銘柄) から watchlist 銘柄の行を日次で書く。
// 証金を通る制度信用の分だけなので、信用残 (margin) の一部にあたる。同じ申込日の速報は確報で上書きする。
export const jsfBalance = sqliteTable(
	"jsf_balance",
	{
		ticker: text("ticker").notNull(),
		date: text("date").notNull(), // 貸借申込日 YYYY-MM-DD
		loanNew: integer("loan_new"), // 融資新規株数
		loanRepay: integer("loan_repay"), // 融資返済株数
		loanQty: integer("loan_qty"), // 融資残高株数
		lendNew: integer("lend_new"), // 貸株新規株数
		lendRepay: integer("lend_repay"), // 貸株返済株数
		lendQty: integer("lend_qty"), // 貸株残高株数
		fetchedAt: text("fetched_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.ticker, t.date] }),
		index("idx_jsf_balance_ticker_date").on(t.ticker, sql`${t.date} DESC`),
	],
);

// ── stock_lending (日証金の品貸料 = 逆日歩。冪等キー = (ticker, date)) ─────────
// 日証金の品貸料率一覧 CSV を引け後に取り、watchlist 全銘柄について貸借申込日ごとに 1 行書く。
// 一覧に無い銘柄も listed=0 で書き、「確認済みで逆日歩なし」を残す。
// fee は当日品貸料率 (円/株、当日品貸日数を乗じた値)。逆日歩が付かない日は null。
export const stockLending = sqliteTable(
	"stock_lending",
	{
		ticker: text("ticker").notNull(),
		date: text("date").notNull(), // 貸借申込日 YYYY-MM-DD
		listed: integer("listed").notNull(), // 1 = 品貸料率一覧に載った
		excessShares: integer("excess_shares"), // 貸株超過株数
		maxFee: real("max_fee"), // 最高料率 (円/株・日)
		fee: real("fee"), // 当日品貸料率 (円/株)
		feeDays: integer("fee_days"), // 当日品貸日数
		restriction: text("restriction"), // 制限措置 (注意喚起/申込停止 等)
		fetchedAt: text("fetched_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.ticker, t.date] }),
		index("idx_stock_lending_ticker_date").on(t.ticker, sql`${t.date} DESC`),
	],
);

// ── short_positions (機関の空売り残高報告。冪等キー = (ticker, calc_date, holder)) ──
// 残高割合 0.5% 以上の空売り者が出す報告 (JPX 公表分を karauri.net が銘柄別に並べたもの)。
// 報告義務消失 (0.5% 割れ) の行は lapsed=1。
export const shortPositions = sqliteTable(
	"short_positions",
	{
		ticker: text("ticker").notNull(),
		calcDate: text("calc_date").notNull(), // 計算日 YYYY-MM-DD
		holder: text("holder").notNull(), // 空売り者
		ratio: real("ratio"), // 残高割合 (%)
		qty: integer("qty"), // 残高数量 (株)
		lapsed: integer("lapsed").notNull(), // 1 = 報告義務消失
		fetchedAt: text("fetched_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.ticker, t.calcDate, t.holder] }),
		index("idx_short_positions_ticker_date").on(
			t.ticker,
			sql`${t.calcDate} DESC`,
		),
	],
);

// ── market_short_ratio (東証全体の空売り比率。PK = date) ──────────────────────
// JPX の日次「空売り集計」から、売買代金に占める空売りの比率 (価格規制あり + なし) を持つ。
export const marketShortRatio = sqliteTable("market_short_ratio", {
	date: text("date").primaryKey(), // 売買日 YYYY-MM-DD
	ratio: real("ratio").notNull(), // 空売り比率 (%) = 価格規制あり + なし
	restrictedRatio: real("restricted_ratio"), // うち価格規制あり (%)
	unrestrictedRatio: real("unrestricted_ratio"), // うち価格規制なし (%)
	fetchedAt: text("fetched_at").notNull(),
});

// ── investor_flows (投資部門別売買の差引き。冪等キー = (week_start, investor)) ──
// JPX の週次「投資部門別 株式売買状況」(東証プライム・金額) から部門ごとの差引き (買い−売り) を持つ。
// investor は foreigners / individuals / trust_banks / investment_trusts / business_cos / proprietary。
export const investorFlows = sqliteTable(
	"investor_flows",
	{
		weekStart: text("week_start").notNull(), // 集計週の初日 YYYY-MM-DD
		weekEnd: text("week_end").notNull(), // 集計週の最終日 YYYY-MM-DD
		investor: text("investor").notNull(),
		netValue: real("net_value").notNull(), // 差引き (億円、買い越し=正)
		fetchedAt: text("fetched_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.weekStart, t.investor] }),
		index("idx_investor_flows_week").on(sql`${t.weekStart} DESC`),
	],
);

// ── memory_prices (メモリのスポット/契約価格。冪等キー = (date, item)) ─────────
// item は取得元の品目名をそのまま持つ (例 DDR5_16Gb / DDR4_8Gb / NAND_512Gb_TLC_wafer)。
// 正規化すると取得元の品目改定時に別品目を同じ系列へ混ぜてしまうため。
export const memoryPrices = sqliteTable(
	"memory_prices",
	{
		date: text("date").notNull(), // 取得元の公表日 (JST) YYYY-MM-DD
		item: text("item").notNull(),
		sessionAvg: real("session_avg").notNull(), // セッション平均価格 (取得元の表示単位のまま)
		changePct: real("change_pct"), // 前回公表比 (%)
		source: text("source").notNull(),
		fetchedAt: text("fetched_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.date, t.item] })],
);

// ── tw_monthly_revenue (台湾企業の月次売上。冪等キー = (company, month)) ───────
export const twMonthlyRevenue = sqliteTable(
	"tw_monthly_revenue",
	{
		company: text("company").notNull(), // 例 TSMC
		month: text("month").notNull(), // 対象月 YYYY-MM
		revenue: real("revenue").notNull(), // 月次売上 (千 NTD)
		yoyPct: real("yoy_pct"), // 前年同月比 (%)
		momPct: real("mom_pct"), // 前月比 (%)
		publishedAt: text("published_at"), // 公表日 (JST) YYYY-MM-DD
		source: text("source").notNull(),
		fetchedAt: text("fetched_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.company, t.month] })],
);

// ── seaj_sales (SEAJ 日本製半導体製造装置 販売高 速報。冪等キー = month) ───────
// 値は SEAJ の公表どおり 3 か月移動平均。後の速報で過去月が確定値に改まるので month で上書きする。
export const seajSales = sqliteTable("seaj_sales", {
	month: text("month").primaryKey(), // 対象月 YYYY-MM
	sales: real("sales").notNull(), // 販売高 (億円)
	yoyPct: real("yoy_pct"), // 前年同月比 (%)
	momPct: real("mom_pct"), // 前月比 (%)
	publishedAt: text("published_at"), // その値を載せた速報の公表日 (JST) YYYY-MM-DD
	source: text("source").notNull(),
	fetchedAt: text("fetched_at").notNull(),
});

// ── forced_liquidation (強制決済スコア。冪等キー = (ticker, date)) ───────────
// 「他プレイヤーの強制的な売買フロー」(追証売り=買い方のロスカット / 踏み上げ=売り方のロスカット)
// を eod cron で決定論的に算出して保存する。judge-context が最新行を forced ブロックとして
// judge (ticker-brief=LLM) に渡し「投げ/踏みが今日いつ出るか」の推論材料にする。post-brief.sh も
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

// ── large_holdings (EDINET の大量保有報告書・変更報告書。PK = doc_id) ──────────
// 監視銘柄を対象会社とする報告だけを持つ (large-holdings.ts)。ratio / prev_ratio は株券等保有割合 (%)
// とその前回報告値で、取れなければ null。special = 特例対象株券等 (機関投資家の特例報告)。
export const largeHoldings = sqliteTable(
	"large_holdings",
	{
		docId: text("doc_id").primaryKey(),
		ticker: text("ticker").notNull(),
		filer: text("filer").notNull(),
		reportKind: text("report_kind").notNull(), // new | change
		special: integer("special", { mode: "boolean" }).notNull(),
		submitDate: text("submit_date").notNull(), // YYYY-MM-DD
		ratio: real("ratio"),
		prevRatio: real("prev_ratio"),
		fetchedAt: text("fetched_at").notNull(),
	},
	(t) => [
		index("idx_large_holdings_ticker_date").on(
			t.ticker,
			sql`${t.submitDate} DESC`,
		),
	],
);

// ── macro_events (FOMC/日銀/米CPI/米雇用統計・ピア決算・指数採用の日程。冪等キー = (date, kind)) ──
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
//   body     … 見出し+本文を素テキスト連結したもの。judge-context と position-report が LLM へ、
//              context-builder が再生入力としてそのまま読む (人間向け装飾を混ぜない)。
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

// ── briefs (最新の材料ブリーフ。PK = ticker) ─────────────────────────────────
// ticker-brief (個別銘柄の材料ブリーフ) と market-brief (朝のマーケットブリーフ、ticker='market')
// の最新 1 件を 1 行で控える。post-brief.sh / post-market.sh が /slack/post に brief_body を載せ、
// 投稿経路 (misc.ts /slack/post) がここに upsert する。ブリーフの度に当該行を上書きするので、
// 常に最新ブリーフだけが残る。読み手は 2 つ: ポジション事実レポート (eod cron) が建玉銘柄の
// 最新材料として引き、judge-context が ticker='market' の当日行を market_brief として同梱する。
export const briefs = sqliteTable("briefs", {
	ticker: text("ticker").primaryKey(), // 銘柄コード (例 285A)。マーケットブリーフは 'market'
	headline: text("headline").notNull(), // ブリーフの headline 全文
	body: text("body"), // 本文 (materials/強気/弱気を改行連結した素テキスト)。読めなければ null
	briefedAt: text("briefed_at").notNull(), // 保存時刻 (ISO8601)
});

// ── positions (ユーザーの保有ポジション。冪等キー = (userId, ticker, account)) ──
// ユーザーが /position コマンドで登録する自分の建玉。解析 (ticker-brief / crash-scenario) は
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
// ユーザーが /profile コマンドで登録する自分の売買スタイル。解析 (ticker-brief / crash-scenario)
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
