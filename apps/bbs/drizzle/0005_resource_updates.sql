CREATE TABLE "resource_updates" (
	"synced_at" timestamp (3) with time zone PRIMARY KEY NOT NULL,
	"changes" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_deliveries" DROP CONSTRAINT "bot_deliveries_kind_ck";--> statement-breakpoint
ALTER TABLE "bot_deliveries" ADD CONSTRAINT "bot_deliveries_kind_ck" CHECK ("bot_deliveries"."kind" in ('article', 'digest', 'reply', 'update', 'resources'));