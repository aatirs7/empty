ALTER TABLE "shadow_outcomes" ALTER COLUMN "kind" SET DEFAULT 'setup';--> statement-breakpoint
ALTER TABLE "shadow_outcomes" ADD COLUMN "candidate_id" integer;--> statement-breakpoint
ALTER TABLE "shadow_outcomes" ADD CONSTRAINT "shadow_outcomes_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;