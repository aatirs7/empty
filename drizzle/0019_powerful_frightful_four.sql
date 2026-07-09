CREATE TABLE "activity_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_date" date NOT NULL,
	"profile_id" text,
	"symbol" text,
	"kind" text NOT NULL,
	"direction" text,
	"price" numeric,
	"candidate_id" integer,
	"detail" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
