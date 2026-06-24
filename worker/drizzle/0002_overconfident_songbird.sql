PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_positions` (
	`user_id` text NOT NULL,
	`ticker` text NOT NULL,
	`account` text NOT NULL,
	`side` text NOT NULL,
	`avg_price` real NOT NULL,
	`qty` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `ticker`, `account`)
);
--> statement-breakpoint
INSERT INTO `__new_positions`("user_id", "ticker", "account", "side", "avg_price", "qty", "updated_at") SELECT "user_id", "ticker", "account", "side", "avg_price", "qty", "updated_at" FROM `positions`;--> statement-breakpoint
DROP TABLE `positions`;--> statement-breakpoint
ALTER TABLE `__new_positions` RENAME TO `positions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;