CREATE TABLE "monitor_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"prices" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
