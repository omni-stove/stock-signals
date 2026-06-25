CREATE TABLE `user_profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`risk_tolerance` text,
	`hold_style` text,
	`max_position_pct` real,
	`note` text,
	`updated_at` text NOT NULL
);
