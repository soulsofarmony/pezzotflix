CREATE TABLE `artwork` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`type` text NOT NULL,
	`language` text,
	`source` text NOT NULL,
	`local_path` text NOT NULL,
	`remote_ref` text,
	`width` integer,
	`height` integer,
	`selected` integer DEFAULT false NOT NULL,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `catalog_item`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "artwork_type_ck" CHECK(type IN ('poster', 'backdrop', 'logo', 'still', 'thumbnail'))
);
--> statement-breakpoint
CREATE INDEX `artwork_item_type_ix` ON `artwork` (`item_id`,`type`);--> statement-breakpoint
CREATE TABLE `catalog_item` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`category` text,
	`parent_id` text,
	`season_number` integer,
	`episode_number` integer,
	`extra_type` text,
	`edition_label` text,
	`title` text NOT NULL,
	`original_title` text,
	`sort_title` text NOT NULL,
	`year` integer,
	`duration_ms` integer,
	`added_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "catalog_item_kind_ck" CHECK(kind IN ('movie', 'series', 'season', 'episode', 'extra'))
);
--> statement-breakpoint
CREATE INDEX `catalog_item_parent_ix` ON `catalog_item` (`parent_id`);--> statement-breakpoint
CREATE INDEX `catalog_item_kind_sort_ix` ON `catalog_item` (`kind`,`sort_title`,`id`);--> statement-breakpoint
CREATE INDEX `catalog_item_added_ix` ON `catalog_item` (`added_at`,`id`);--> statement-breakpoint
CREATE TABLE `chapter` (
	`file_id` text NOT NULL,
	`chapter_index` integer NOT NULL,
	`title` text,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	PRIMARY KEY(`file_id`, `chapter_index`),
	FOREIGN KEY (`file_id`) REFERENCES `media_file`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `credit` (
	`item_id` text NOT NULL,
	`person_id` text NOT NULL,
	`role` text NOT NULL,
	`character` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	PRIMARY KEY(`item_id`, `person_id`, `role`),
	FOREIGN KEY (`item_id`) REFERENCES `catalog_item`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `domain_event` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `domain_event_created_ix` ON `domain_event` (`created_at`);--> statement-breakpoint
CREATE TABLE `external_id` (
	`item_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	PRIMARY KEY(`item_id`, `provider`),
	FOREIGN KEY (`item_id`) REFERENCES `catalog_item`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `external_id_lookup_ix` ON `external_id` (`provider`,`external_id`);--> statement-breakpoint
CREATE TABLE `external_subtitle` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`rel_path` text NOT NULL,
	`language` text,
	`is_forced` integer DEFAULT false NOT NULL,
	`is_sdh` integer DEFAULT false NOT NULL,
	`format` text NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `media_file`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_subtitle_path_uq` ON `external_subtitle` (`file_id`,`rel_path`);--> statement-breakpoint
CREATE TABLE `field_lock` (
	`item_id` text NOT NULL,
	`field` text NOT NULL,
	`source` text NOT NULL,
	`locked_at` integer NOT NULL,
	PRIMARY KEY(`item_id`, `field`),
	FOREIGN KEY (`item_id`) REFERENCES `catalog_item`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "field_lock_source_ck" CHECK(source IN ('manual', 'tmdb', 'wikidata', 'filename', 'container'))
);
--> statement-breakpoint
CREATE TABLE `identification_case` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`parsed` text,
	`candidates` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `media_file`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "identification_case_state_ck" CHECK(state IN ('pending', 'auto_matched', 'needs_review', 'resolved', 'ignored'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identification_case_file_uq` ON `identification_case` (`file_id`);--> statement-breakpoint
CREATE INDEX `identification_case_state_ix` ON `identification_case` (`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `item_field` (
	`item_id` text NOT NULL,
	`field` text NOT NULL,
	`source` text NOT NULL,
	`value` text NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`item_id`, `field`, `source`),
	FOREIGN KEY (`item_id`) REFERENCES `catalog_item`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "item_field_source_ck" CHECK(source IN ('manual', 'tmdb', 'wikidata', 'filename', 'container'))
);
--> statement-breakpoint
CREATE TABLE `job` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_at` integer NOT NULL,
	`last_error` text,
	`idempotency_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "job_state_ck" CHECK(state IN ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_idempotency_uq` ON `job` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `job_claim_ix` ON `job` (`state`,`run_at`,`priority`);--> statement-breakpoint
CREATE TABLE `library_root` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`mount_path` text NOT NULL,
	`hint` text NOT NULL,
	`status` text DEFAULT 'online' NOT NULL,
	`last_scan_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "library_root_hint_ck" CHECK(hint IN ('movies', 'series', 'mixed')),
	CONSTRAINT "library_root_status_ck" CHECK(status IN ('online', 'offline'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_root_mount_uq` ON `library_root` (`mount_path`);--> statement-breakpoint
CREATE TABLE `media_file` (
	`id` text PRIMARY KEY NOT NULL,
	`root_id` text NOT NULL,
	`rel_path` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`mtime_ms` integer NOT NULL,
	`fingerprint` text,
	`container` text,
	`duration_ms` integer,
	`bit_rate` integer,
	`state` text DEFAULT 'discovered' NOT NULL,
	`facts` text,
	`analyzed_at` integer,
	`missing_since` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`root_id`) REFERENCES `library_root`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_file_state_ck" CHECK(state IN ('discovered', 'analyzed', 'identified', 'needs_review', 'missing', 'removed', 'ignored'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_file_root_path_uq` ON `media_file` (`root_id`,`rel_path`);--> statement-breakpoint
CREATE INDEX `media_file_fingerprint_ix` ON `media_file` (`fingerprint`);--> statement-breakpoint
CREATE TABLE `media_link` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`item_id` text NOT NULL,
	`origin` text NOT NULL,
	`confidence` real,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `media_file`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `catalog_item`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_link_origin_ck" CHECK(origin IN ('auto', 'manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_link_file_item_uq` ON `media_link` (`file_id`,`item_id`);--> statement-breakpoint
CREATE INDEX `media_link_item_ix` ON `media_link` (`item_id`);--> statement-breakpoint
CREATE TABLE `media_stream` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`stream_index` integer NOT NULL,
	`type` text NOT NULL,
	`codec` text,
	`profile` text,
	`language` text,
	`title` text,
	`is_default` integer DEFAULT false NOT NULL,
	`is_forced` integer DEFAULT false NOT NULL,
	`is_sdh` integer DEFAULT false NOT NULL,
	`is_commentary` integer DEFAULT false NOT NULL,
	`attrs` text NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `media_file`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_stream_type_ck" CHECK(type IN ('video', 'audio', 'subtitle', 'attachment', 'data'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_stream_file_idx_uq` ON `media_stream` (`file_id`,`stream_index`);--> statement-breakpoint
CREATE TABLE `person` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`external_ref` text
);
--> statement-breakpoint
CREATE TABLE `playback_progress` (
	`profile_id` text NOT NULL,
	`item_id` text NOT NULL,
	`position_ms` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`file_id` text,
	`audio_stream_index` integer,
	`subtitle_track_id` text,
	`client_ts` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`profile_id`, `item_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `profile`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `catalog_item`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `playback_progress_recent_ix` ON `playback_progress` (`profile_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `profile` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`avatar` text,
	`prefs` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_cache` (
	`provider` text NOT NULL,
	`cache_key` text NOT NULL,
	`response` text NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`provider`, `cache_key`)
);
--> statement-breakpoint
CREATE TABLE `viewing_record` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`item_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`max_position_ms` integer DEFAULT 0 NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profile`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `catalog_item`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `viewing_record_profile_ix` ON `viewing_record` (`profile_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `watch_state` (
	`profile_id` text NOT NULL,
	`item_id` text NOT NULL,
	`watched` integer NOT NULL,
	`watched_at` integer,
	`play_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`profile_id`, `item_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `profile`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `catalog_item`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `watchlist_entry` (
	`profile_id` text NOT NULL,
	`item_id` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`profile_id`, `item_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `profile`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `catalog_item`(`id`) ON UPDATE no action ON DELETE cascade
);
