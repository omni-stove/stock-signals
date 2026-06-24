CREATE TABLE `positions` (
	`ticker` text NOT NULL,
	`account` text NOT NULL,
	`side` text NOT NULL,
	`avg_price` real NOT NULL,
	`qty` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`ticker`, `account`)
);
