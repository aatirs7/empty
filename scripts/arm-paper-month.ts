/**
 * Arm the paper month for AUTO-TRADING the $500 PAPER account off zone setups.
 * PAPER-ONLY (asserts TRADING_MODE=paper). One-off; safe to re-run.
 *
 * - wipes pre-month test shadow_outcomes
 * - freezes the auto config: auto-buy ON, auto-manage ON (structural close-through
 *   exits), 1-contract sizing, cheap-OTM targeting kept, goal-based exits disabled
 * - prints the frozen config + start date
 *
 * Run: npm run arm
 */
import "dotenv/config";
import { db } from "../src/db";
import { shadowOutcomes } from "../src/db/schema";
import { updateSettings } from "../src/lib/settings";

async function main() {
  if (process.env.TRADING_MODE !== "paper") {
    throw new Error(`GUARDRAIL: TRADING_MODE must be "paper", got "${process.env.TRADING_MODE}". Refusing to arm.`);
  }

  const wiped = await db.delete(shadowOutcomes).returning({ id: shadowOutcomes.id });
  console.log(`wiped ${wiped.length} pre-month shadow_outcomes rows`);

  const s = await updateSettings({
    autoExecute: true, // auto-buy ON
    autoManage: true, // auto-manage ON (structural close-through exits)
    autoMinConfidence: 0, // driven by the zone setups, not a Brain confidence gate
    maxAutoTradesPerDay: 2, // new auto-buys per day (open-position cap still 3)
    maxContracts: 1, // 1-contract sizing
    weeklyGoal: 0, // disable goal-based exits; zone exits are close-through
  });

  const start = new Date().toISOString().slice(0, 10);
  console.log("FROZEN AUTO CONFIG:");
  console.log({
    tradingMode: process.env.TRADING_MODE,
    autoExecute: s.autoExecute,
    autoManage: s.autoManage,
    autoMinConfidence: s.autoMinConfidence,
    maxAutoTradesPerDay: s.maxAutoTradesPerDay,
    maxContracts: s.maxContracts,
    maxContractPrice: s.maxContractPrice,
    maxOpenPositions: process.env.MAX_OPEN_POSITIONS ?? "3",
    weeklyGoal: s.weeklyGoal,
    universe: "frozen (~200 names; incl HOOD/TSLA/NVDA/AMZN)",
  });
  console.log(`paper month ARMED. Config frozen ${start}. First auto-buy: next pre-market zone run.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
