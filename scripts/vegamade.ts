/**
 * VegaMade v4 daily runner (paper shares). Run after the close.
 *   npm run vegamade -- --dry   # show what it WOULD do, place nothing
 *   npm run vegamade            # live paper (requires vegamade_v1 autoExecute ON)
 */
import "dotenv/config";
import { runVegaMade } from "../src/lib/vegamade";

async function main() {
  const dryRun = process.argv.includes("--dry");
  const r = await runVegaMade({ dryRun });
  console.log(`VegaMade v4 ${dryRun ? "(DRY RUN)" : "(LIVE PAPER)"} — ${r.ranAt}`);
  console.log(`Regime: ${r.regimeOk ? "ON (risk-on)" : "OFF (risk-off, longs paused)"}`);
  const show = (label: string, xs: string[]) => {
    console.log(`\n${label} (${xs.length}):`);
    for (const x of xs) console.log(`  - ${x}`);
  };
  show("EXITS", r.managed);
  show("ENTRIES", r.entered);
  show("SKIPS", r.skipped);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
