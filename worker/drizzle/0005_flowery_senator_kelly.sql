CREATE TABLE `signals` (
	`ticker` text PRIMARY KEY NOT NULL,
	`side` text NOT NULL,
	`line` text,
	`stop` text,
	`rr` text,
	`headline` text NOT NULL,
	`judged_at` text NOT NULL
);
