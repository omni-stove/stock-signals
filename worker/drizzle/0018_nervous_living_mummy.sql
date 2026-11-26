CREATE TABLE `jsf_balance` (
	`ticker` text NOT NULL,
	`date` text NOT NULL,
	`loan_new` integer,
	`loan_repay` integer,
	`loan_qty` integer,
	`lend_new` integer,
	`lend_repay` integer,
	`lend_qty` integer,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`ticker`, `date`)
);
--> statement-breakpoint
CREATE INDEX `idx_jsf_balance_ticker_date` ON `jsf_balance` (`ticker`,"date" DESC);