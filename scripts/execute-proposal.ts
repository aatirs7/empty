/**
 * Manually execute (approve) a pending proposal — places a PAPER order via the
 * shared execute lib (same path as POST /api/proposals/[id]/approve).
 *
 * Run: npm run execute -- <proposalId>
 */
import "dotenv/config";
import { executeProposal, ExecuteError } from "../src/lib/execute";

async function main() {
  const id = Number(process.argv[2]);
  if (!Number.isInteger(id)) {
    console.error("Usage: npm run execute -- <proposalId>");
    process.exitCode = 1;
    return;
  }
  console.log(`Executing proposal ${id} (manual, paper)...`);
  const res = await executeProposal(id, "manual");
  console.log(`  contract:     ${res.contractSymbol}`);
  console.log(`  alpaca order: ${res.alpacaOrderId}`);
  console.log(`  status:       ${res.orderStatus}${res.filled ? ` (filled @ ${res.filledPrice})` : ""}`);
  console.log(`  max loss:     $${res.risk.maxLoss}   breakeven: $${res.risk.breakeven}`);
  console.log(`  scenarios:    ${res.risk.scenarios.map((s) => `${s.label} -> $${s.payoff}`).join("  |  ")}`);
  console.log(res.filled ? "\n✅ Filled paper order." : `\n⏳ Order ${res.orderStatus} (fills at next open if market closed).`);
}

main().catch((err) => {
  if (err instanceof ExecuteError) {
    console.error(`\n❌ refused (${err.code}): ${err.message}`);
  } else {
    console.error("\n❌ execute failed:", err instanceof Error ? err.message : err);
  }
  process.exitCode = 1;
});
