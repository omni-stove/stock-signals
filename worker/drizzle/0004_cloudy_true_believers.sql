CREATE TABLE `market_news` (
	`url` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`topic` text NOT NULL,
	`published_at` text,
	`r2_key` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_market_news_fetched` ON `market_news` ("fetched_at" DESC);