-- Unmounted-root guard state of library_root, the owner's confirmation that releases it, and the case queue index (F1a.3). Additive.
ALTER TABLE `library_root` ADD `hold_reason` text;--> statement-breakpoint
ALTER TABLE `library_root` ADD `held_missing` integer;--> statement-breakpoint
ALTER TABLE `library_root` ADD `confirmed_missing` integer;--> statement-breakpoint
ALTER TABLE `library_root` ADD `confirmed_at` integer;--> statement-breakpoint
CREATE INDEX `identification_case_queue_ix` ON `identification_case` (`state`,`created_at`,`id`);
