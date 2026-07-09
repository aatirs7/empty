/**
 * Shadow-outcome runner. Opens shadows for recent real-trade proposals + a daily
 * SPY baseline, marks open shadows to the bid, and closes any that hit the exit
 * rule (TP +50% / SL -40% / expiry). Scheduled through the market day.
 *
 * Run: npm run shadow
 */
import "dotenv/config";
import { runShadow } from "../src/lib/shadow";

async function main() {
  const r = await runShadow();
  console.log(
    `shadow: opened ${r.openedSetups} setup(s) + ${r.openedBaselines} baseline(s), marked ${r.marked}, closed ${r.closed}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
