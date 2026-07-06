/**
 * Goal-driven auto-management of open paper positions. Runs on a schedule during
 * market hours (GitHub Actions). No-op unless settings.autoManage is on.
 *
 * Run: npm run manage
 */
import "dotenv/config";
import { autoManagePositions } from "../src/lib/manage";

async function main() {
  const r = await autoManagePositions();
  if (!r.enabled) {
    console.log("auto-manage is off; nothing to do.");
    return;
  }
  console.log(`weekly P&L ${r.weeklyPL} / goal ${r.goal}${r.goalMet ? " (met)" : ""}`);
  if (r.actions.length === 0) {
    console.log("no positions met a close rule.");
  } else {
    for (const a of r.actions) console.log(`closed ${a.symbol}: ${a.reason}`);
  }
}

main().catch((err) => {
  console.error("manage failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
