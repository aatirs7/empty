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
  console.log(`\nAUTO-BUY (${res.auto.placed.length} attempted):`);
  for (const pl of res.auto.placed) {
    console.log(
      `  ${pl.symbol}: ${pl.ok ? `PLACED order #${pl.orderId} (${pl.status})` : `skipped — ${pl.error}`}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
