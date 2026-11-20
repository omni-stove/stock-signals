CREATE TABLE `seaj_sales` (
	`month` text PRIMARY KEY NOT NULL,
	`sales` real NOT NULL,
	`yoy_pct` real,
	`mom_pct` real,
	`published_at` text,
	`source` text NOT NULL,
	`fetched_at` text NOT NULL
);
