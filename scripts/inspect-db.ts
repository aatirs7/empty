/**
 * Quick DB inspector — prints the latest run and its proposals.
 * Run: npm run inspect
 */
import "dotenv/config";
import { desc, eq } from "drizzle-orm";
import { db } from "../src/db";
import { researchRuns, proposals, orders } from "../src/db/schema";

async function main() {
  const [run] = await db.select().from(researchRuns).orderBy(desc(researchRuns.id)).limit(1);
  if (!run) {
    console.log("No research runs yet.");
    return;
  }
  console.log("Latest research_run:");
  console.log(`  id ${run.id}  date ${run.runDate}  status ${run.status}  model ${run.model}`);
  console.log(`  searches ${run.searchCount}  in ${run.inputTokens}  out ${run.outputTokens}  cost $${run.costEstimate}`);
  console.log(`  market_context: ${run.marketContext?.slice(0, 160) ?? "—"}...`);

  const rows = await db.select().from(proposals).where(eq(proposals.runId, run.id)).orderBy(proposals.symbol);
  console.log(`\nProposals for run ${run.id} (${rows.length}):`);
  for (const p of rows) {
    const trade = p.strategy === "no_trade" ? "no_trade" : `${p.strategy} ${p.strikeHint} / ${p.expiryHint}`;
    console.log(`  ${p.symbol.padEnd(5)} ${trade.padEnd(34)} conf ${p.confidence}  ${p.pricedInAssessment}  [${p.status}]`);
  }

  const orderRows = await db.select().from(orders).orderBy(desc(orders.id)).limit(5);
  console.log(`\nRecent orders (${orderRows.length}):`);
  for (const o of orderRows) {
    console.log(
      `  #${o.id} p${o.proposalId} ${o.contractSymbol} [${o.executionMode}] ${o.status} ` +
        `fill=${o.filledPrice ?? "—"} maxLoss=$${o.maxLoss} be=$${o.breakeven}`,
    );
  }
}

main().catch((err) => {
  console.error("inspect failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
