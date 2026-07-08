ALTER TABLE "orders" ADD COLUMN "exit_price" numeric;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "exit_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "realized_pl" numeric;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "exit_reason" text;