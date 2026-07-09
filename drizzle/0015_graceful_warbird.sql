CREATE TABLE "profile_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"auto_execute" boolean DEFAULT false NOT NULL,
	"auto_manage" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_settings_profile_id_unique" UNIQUE("profile_id")
);
--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "profile_id" text DEFAULT 'zones_legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "profile_id" text DEFAULT 'zones_legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "shadow_outcomes" ADD COLUMN "profile_id" text DEFAULT 'zones_legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "universe" ADD COLUMN "profile_id" text DEFAULT 'zones_legacy' NOT NULL;