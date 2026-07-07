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
  const res = await runScan();
  console.log(`scan ${res.runDate}: scanned ${res.scanned}, ${res.candidates} candidates, ${res.validSetups} valid setups`);

  const valid = await db
    .select()
    .from(candidates)
    .where(eq(candidates.runDate, res.runDate));
  const setups = valid.filter((c) => c.setupValid).sort((a, b) => Number(a.distanceToEdgePct) - Number(b.distanceToEdgePct));
  if (setups.length) {
    console.log("\nvalid setups (tapped this session):");
    for (const c of setups) {
      const z = c.zone as { type: string; bottom: number; top: number } | null;
      console.log(
        `  ${c.symbol.padEnd(6)} ${c.direction}  ${c.approach}  ${z ? `${z.type}[${z.bottom}-${z.top}]` : ""}  ${c.distanceToEdgePct}% ${c.clearRunway ? "clear" : "BLOCKED"}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
