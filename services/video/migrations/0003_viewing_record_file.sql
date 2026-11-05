-- File each viewing played, so a re-linked file takes its history and watched state along. Additive, no backfill: older rows keep NULL and never move.
ALTER TABLE `viewing_record` ADD `file_id` text;--> statement-breakpoint
CREATE INDEX `viewing_record_file_ix` ON `viewing_record` (`file_id`);