CREATE TABLE "settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"auto_execute" boolean DEFAULT false NOT NULL,
	"auto_min_confidence" numeric DEFAULT '0.7' NOT NULL,
	"max_auto_trades_per_day" integer DEFAULT 2 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "execution_mode" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "direction" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "strike" numeric;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "expiry" date;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "underlying_price" numeric;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "max_loss" numeric;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "breakeven" numeric;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "scenarios" jsonb;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "plain_explanation" text;