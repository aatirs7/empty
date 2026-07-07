CREATE TABLE "candidates" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_date" date NOT NULL,
	"symbol" text NOT NULL,
	"direction" text,
	"approach" text,
	"clear_runway" boolean DEFAULT false NOT NULL,
	"distance_to_edge_pct" numeric,
	"setup_valid" boolean DEFAULT false NOT NULL,
	"price" numeric,
	"zone" jsonb,
	"setup" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "universe" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"rank" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
