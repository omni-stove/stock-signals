CREATE TABLE `investor_flows` (
	`week_start` text NOT NULL,
	`week_end` text NOT NULL,
	`investor` text NOT NULL,
	`net_value` real NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`week_start`, `investor`)
);
--> statement-breakpoint
CREATE INDEX `idx_investor_flows_week` ON `investor_flows` ("week_start" DESC);--> statement-breakpoint
CREATE TABLE `market_short_ratio` (
	`date` text PRIMARY KEY NOT NULL,
	`ratio` real NOT NULL,
	`restricted_ratio` real,
	`unrestricted_ratio` real,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `short_positions` (
	`ticker` text NOT NULL,
	`calc_date` text NOT NULL,
	`holder` text NOT NULL,
	`ratio` real,
	`qty` integer,
	`lapsed` integer NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`ticker`, `calc_date`, `holder`)
);
--> statement-breakpoint
CREATE INDEX `idx_short_positions_ticker_date` ON `short_positions` (`ticker`,"calc_date" DESC);--> statement-breakpoint
CREATE TABLE `stock_lending` (
	`ticker` text NOT NULL,
	`date` text NOT NULL,
	`listed` integer NOT NULL,
	`excess_shares` integer,
	`max_fee` real,
	`fee` real,
	`fee_days` integer,
	`restriction` text,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`ticker`, `date`)
);
--> statement-breakpoint
CREATE INDEX `idx_stock_lending_ticker_date` ON `stock_lending` (`ticker`,"date" DESC);--> statement-breakpoint
ALTER TABLE `fundamentals` ADD `forecast_sales` real;--> statement-breakpoint
ALTER TABLE `fundamentals` ADD `forecast_ordinary` real;--> statement-breakpoint
ALTER TABLE `fundamentals` ADD `forecast_net` real;--> statement-breakpoint
ALTER TABLE `fundamentals` ADD `forecast_dividend` real;--> statement-breakpoint
ALTER TABLE `fundamentals` ADD `forecast_announced_at` text;