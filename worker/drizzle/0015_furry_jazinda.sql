CREATE TABLE `large_holdings` (
	`doc_id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`filer` text NOT NULL,
	`report_kind` text NOT NULL,
	`special` integer NOT NULL,
	`submit_date` text NOT NULL,
	`ratio` real,
	`prev_ratio` real,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_large_holdings_ticker_date` ON `large_holdings` (`ticker`,"submit_date" DESC);