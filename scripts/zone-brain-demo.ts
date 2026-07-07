/**
 * I3 wiring check: build a real zone setup for a symbol and feed it to the Brain,
 * confirming the proposal centers on the zone (direction fixed by the rejection
 * rule, news as color, a zone_read echoed back).
 *
 * Because valid daily-scan taps are rare, pass --force to mark the setup valid so
 * the zone-trade path is exercised regardless of today's tape.
 *
 * Run: npm run zone-demo -- TSLA --force
 */
import "dotenv/config";
import { getStockBars } from "../src/lib/alpaca";
import { buildZoneSetup } from "../src/lib/strategy";
import { runResearch } from "../src/lib/anthropic";

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const sym = (args.find((a) => !a.startsWith("--")) || "TSLA").toUpperCase();

  const bars = await getStockBars(sym, 450);
  const setup = buildZoneSetup(bars);
  if (force && setup.active_zone) setup.setup_valid = true;
  console.log(`${sym} zone setup${force ? " (forced valid)" : ""}:`, JSON.stringify(setup));
  if (!setup.active_zone) {
    console.log("No active zone near price; nothing to feed the Brain.");
    return;
  }

  const res = await runResearch([{ symbol: sym, notes: "zone strategy test", zoneSetup: setup }]);
  console.log(`\ncost ~$${res.costEstimate.toFixed(3)}, searches ${res.searchCount}`);
  for (const p of res.output.proposals) {
    console.log(`\n${p.symbol}: ${p.strategy} (${p.direction}) conf=${p.confidence} priced_in=${p.priced_in_assessment}`);
    console.log(`  zone_read: ${p.zone_read ?? "-"}`);
    console.log(`  rationale: ${p.rationale}`);
    console.log(`  plain:     ${p.plain_explanation}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
