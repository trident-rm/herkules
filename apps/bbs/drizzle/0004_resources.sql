CREATE TABLE "resource_catalog" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"tree" jsonb NOT NULL,
	"synced_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "resource_catalog_singleton" CHECK ("resource_catalog"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "resource_pages" (
	"id" text NOT NULL,
	"staged" boolean DEFAULT false NOT NULL,
	"title" text NOT NULL,
	"html" text NOT NULL,
	"attachments" jsonb NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "resource_pages_id_staged_pk" PRIMARY KEY("id","staged")
);
