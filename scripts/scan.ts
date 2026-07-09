/**
 * Nightly scanner entrypoint. Runs the zone scan over the universe and writes
 * the next session's candidates. Scheduled after close via GitHub Actions.
 *
 * Run: npm run scan
 */
import "dotenv/config";
import { runScan } from "../src/lib/scanner";
import { db } from "../src/db";
import { candidates } from "../src/db/schema";
import { eq } from "drizzle-orm";

async function main() {
  const results = await runScan();
  const runDate = results[0]?.runDate ?? new Date().toISOString().slice(0, 10);
  for (const r of results) {
    console.log(`scan ${r.runDate} [${r.profileId}]: scanned ${r.scanned}, ${r.candidates} candidates, ${r.validSetups} valid setups`);
  }

  const valid = await db
    .select()
    .from(candidates)
    .where(eq(candidates.runDate, runDate));
  const setups = valid.filter((c) => c.setupValid).sort((a, b) => Number(a.distanceToEdgePct) - Number(b.distanceToEdgePct));
  if (setups.length) {
    console.log("\nvalid setups (tapped this session):");
    for (const c of setups) {
      const z = c.zone as { bottom: number; top: number } | null;
      console.log(
        `  ${c.symbol.padEnd(6)} ${c.direction}  ${c.approach}  ${z ? `zone[${z.bottom}-${z.top}]` : ""}  ${c.distanceToEdgePct}% ${c.clearRunway ? "clear" : "BLOCKED"}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
