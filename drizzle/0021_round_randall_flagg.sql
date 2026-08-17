CREATE TABLE "vegamade_positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"shares" integer NOT NULL,
	"entry_price" numeric NOT NULL,
	"target" numeric NOT NULL,
	"stop" numeric NOT NULL,
	"zone_bottom" numeric NOT NULL,
	"zone_top" numeric NOT NULL,
	"entry_order_id" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"exit_price" numeric,
	"exit_at" timestamp with time zone,
	"exit_reason" text,
	"realized_pl" numeric
);
