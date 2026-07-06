ALTER TABLE "settings" ADD COLUMN "per_trade_budget" numeric DEFAULT '150' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "max_contracts" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "max_contract_price" numeric DEFAULT '2.5' NOT NULL;