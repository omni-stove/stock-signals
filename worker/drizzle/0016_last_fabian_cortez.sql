CREATE TABLE `earnings_quarters` (
	`ticker` text NOT NULL,
	`period` text NOT NULL,
	`sales` real,
	`operating` real,
	`ordinary` real,
	`net` real,
	`announced_at` text,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`ticker`, `period`)
);
--> statement-breakpoint
CREATE TABLE `memory_prices` (
	`date` text NOT NULL,
	`item` text NOT NULL,
	`session_avg` real NOT NULL,
	`change_pct` real,
	`source` text NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`date`, `item`)
);
--> statement-breakpoint
CREATE TABLE `tw_monthly_revenue` (
	`company` text NOT NULL,
	`month` text NOT NULL,
	`revenue` real NOT NULL,
	`yoy_pct` real,
	`mom_pct` real,
	`published_at` text,
	`source` text NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`company`, `month`)
);
--> statement-breakpoint
ALTER TABLE `earnings` ADD `estimated` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `earnings` ADD `forecast_period` text;--> statement-breakpoint
ALTER TABLE `earnings` ADD `forecast_sales` real;--> statement-breakpoint
ALTER TABLE `earnings` ADD `forecast_operating` real;--> statement-breakpoint
ALTER TABLE `earnings` ADD `forecast_ordinary` real;--> statement-breakpoint
ALTER TABLE `earnings` ADD `forecast_net` real;