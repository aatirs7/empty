ALTER TABLE "settings" ADD COLUMN "auto_manage" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "weekly_goal" numeric DEFAULT '100' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "risk_tolerance" text DEFAULT 'balanced' NOT NULL;