ALTER TABLE "proposals" ADD COLUMN "variant" text DEFAULT 'news_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "zone_setup" jsonb;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "zone_read" text;