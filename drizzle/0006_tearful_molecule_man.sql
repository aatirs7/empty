CREATE TABLE "shadow_outcomes" (
	"id" serial PRIMARY KEY NOT NULL,
	"proposal_id" integer,
	"kind" text DEFAULT 'proposal' NOT NULL,
	"symbol" text NOT NULL,
	"variant" text,
	"direction" text,
	"contract_symbol" text,
	"strike" numeric,
	"expiry" date,
	"entry_at" timestamp with time zone,
	"entry_underlying" numeric,
	"entry_premium" numeric,
	"mark_premium" numeric,
	"mark_at" timestamp with time zone,
	"exit_at" timestamp with time zone,
	"exit_underlying" numeric,
	"exit_premium" numeric,
	"return_pct" numeric,
	"win" boolean,
	"status" text DEFAULT 'open' NOT NULL,
	"exit_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shadow_outcomes" ADD CONSTRAINT "shadow_outcomes_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;