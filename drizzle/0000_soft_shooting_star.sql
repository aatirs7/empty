CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"proposal_id" integer NOT NULL,
	"alpaca_order_id" text,
	"contract_symbol" text,
	"side" text,
	"qty" integer,
	"limit_price" numeric,
	"filled_price" numeric,
	"status" text,
	"submitted_at" timestamp with time zone,
	"filled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "positions_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"symbol" text NOT NULL,
	"direction" text,
	"strategy" text,
	"strike_hint" text,
	"expiry_hint" text,
	"confidence" numeric,
	"priced_in_assessment" text,
	"rationale" text,
	"sources" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_date" date NOT NULL,
	"status" text NOT NULL,
	"model" text,
	"market_context" text,
	"raw_response" jsonb,
	"search_count" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_estimate" numeric,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchlist" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;