CREATE TABLE `articles` (
	`url` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`source` text NOT NULL,
	`title` text NOT NULL,
	`published_at` text,
	`ir_category` text,
	`r2_key` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_articles_ticker_fetched` ON `articles` (`ticker`,"fetched_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_articles_category` ON `articles` (`ticker`,`ir_category`,"published_at" DESC);--> statement-breakpoint
CREATE TABLE `contexts` (
	`ticker` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`ir_last_fetched_at` text,
	`news_last_fetched_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `daily` (
	`ticker` text NOT NULL,
	`date` text NOT NULL,
	`source` text NOT NULL,
	`open` real,
	`high` real,
	`low` real,
	`close` real,
	`change` real,
	`change_pct` real,
	`volume` integer,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`ticker`, `date`)
);
--> statement-breakpoint
CREATE INDEX `idx_daily_ticker_date` ON `daily` (`ticker`,"date" DESC);--> statement-breakpoint
CREATE TABLE `earnings` (
	`ticker` text PRIMARY KEY NOT NULL,
	`next_date` text,
	`detail` text,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `forced_liquidation` (
	`ticker` text NOT NULL,
	`date` text NOT NULL,
	`direction` text NOT NULL,
	`stance` text NOT NULL,
	`fuel` integer NOT NULL,
	`fire` integer NOT NULL,
	`exhaust` integer NOT NULL,
	`settle_warning_in_days` integer,
	`summary` text NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`ticker`, `date`)
);
--> statement-breakpoint
CREATE INDEX `idx_forced_liquidation_ticker_date` ON `forced_liquidation` (`ticker`,"date" DESC);--> statement-breakpoint
CREATE TABLE `fundamentals` (
	`ticker` text NOT NULL,
	`date` text NOT NULL,
	`source` text NOT NULL,
	`per` real,
	`pbr` real,
	`dividend_yield` real,
	`forecast_eps` real,
	`forecast_period` text,
	`actual_eps` real,
	`actual_period` text,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`ticker`, `date`)
);
--> statement-breakpoint
CREATE INDEX `idx_fundamentals_ticker_date` ON `fundamentals` (`ticker`,"date" DESC);--> statement-breakpoint
CREATE TABLE `intraday_dispatch` (
	`ticker` text PRIMARY KEY NOT NULL,
	`last_dispatch_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `macro_events` (
	`date` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`impact` text NOT NULL,
	`jst_effect_date` text,
	`note` text,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`date`, `kind`)
);
--> statement-breakpoint
CREATE INDEX `idx_macro_events_date` ON `macro_events` (`date`);--> statement-breakpoint
CREATE TABLE `margin` (
	`ticker` text NOT NULL,
	`date` text NOT NULL,
	`source` text NOT NULL,
	`short_qty` real,
	`long_qty` real,
	`ratio` real,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`ticker`, `date`)
);
--> statement-breakpoint
CREATE INDEX `idx_margin_ticker_date` ON `margin` (`ticker`,"date" DESC);--> statement-breakpoint
CREATE TABLE `market_regime` (
	`date` text PRIMARY KEY NOT NULL,
	`regime` text NOT NULL,
	`stance` text NOT NULL,
	`headline` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `premarket_backdrop` (
	`fetched_at` text PRIMARY KEY NOT NULL,
	`sox_change_pct` real,
	`nasdaq_change_pct` real,
	`dow_change_pct` real,
	`nikkei_futures_price` real,
	`nikkei_contract` text,
	`us_indexes_json` text
);
--> statement-breakpoint
CREATE TABLE `prices` (
	`ticker` text NOT NULL,
	`slot` text NOT NULL,
	`source` text NOT NULL,
	`price` real,
	`change` real,
	`change_pct` real,
	`volume` integer,
	`quote_time` text,
	`pts_price` real,
	`pts_time` text,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`ticker`, `slot`)
);
--> statement-breakpoint
CREATE INDEX `idx_prices_ticker_time` ON `prices` (`ticker`,"fetched_at" DESC);--> statement-breakpoint
CREATE TABLE `slack_threads` (
	`thread_ts` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`kind` text NOT NULL,
	`channel` text NOT NULL,
	`created_at` text NOT NULL
);
