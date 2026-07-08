CREATE TABLE "position_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"contract_symbol" text NOT NULL,
	"entry_premium" numeric,
	"peak_pct" numeric DEFAULT '0' NOT NULL,
	"stop_stage" integer DEFAULT 0 NOT NULL,
	"trims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "position_state_contract_symbol_unique" UNIQUE("contract_symbol")
);
--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "score" integer;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "playbook" text;