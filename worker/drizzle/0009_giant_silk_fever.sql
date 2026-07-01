CREATE TABLE `live_indexes` (
	`key` text NOT NULL,
	`slot` text NOT NULL,
	`source` text NOT NULL,
	`price` real,
	`change` real,
	`change_pct` real,
	`quote_time` text,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`key`, `slot`)
);
--> statement-breakpoint
CREATE INDEX `idx_live_indexes_key_time` ON `live_indexes` (`key`,"fetched_at" DESC);