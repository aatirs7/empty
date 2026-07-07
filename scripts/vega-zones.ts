/**
 * Pre-market zone research: researches the latest scan's VALID zone setups with
 * the zone_setup fed to the Brain as the highest-weight signal. Proposals are
 * tagged variant='news_plus_zones'. No-op when the last scan had no valid setups.
 *
 * Run: npm run vega:zones
 */
import "dotenv/config";
import { runZoneResearch } from "../src/lib/run-vega";

async function main() {
  const res = await runZoneResearch();
  if (!res) {
    console.log("No valid zone setups from the latest scan. Nothing to research today.");
    return;
  }
  console.log(`zone run #${res.runId}: ${res.proposalsInserted} proposals (variant=news_plus_zones)`);
  for (const p of res.result.output.proposals) {
    console.log(`\n  ${p.symbol} ${p.strategy} (${p.direction}) conf=${p.confidence}`);
    if (p.zone_read) console.log(`     zone: ${p.zone_read}`);
    console.log(`     ${p.rationale}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
