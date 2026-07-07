ALTER TABLE "shadow_outcomes" DROP CONSTRAINT "shadow_outcomes_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE "shadow_outcomes" ADD CONSTRAINT "shadow_outcomes_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE set null ON UPDATE no action;