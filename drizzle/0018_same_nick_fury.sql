CREATE TABLE "api_costs" (
	"id" serial PRIMARY KEY NOT NULL,
	"profile_id" text,
	"source" text NOT NULL,
	"symbol" text,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"search_count" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
