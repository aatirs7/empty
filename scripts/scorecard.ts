/**
 * Print the per-account scorecard — a summary of REAL trading activity.
 *
 * Run: npm run scorecard
 */
import "dotenv/config";
import { computeScorecard } from "../src/lib/scorecard";

const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
const usd = (x: number) => `${x >= 0 ? "+" : "-"}$${Math.abs(x).toFixed(2)}`;

async function main() {
  const s = await computeScorecard();
  console.log("\n=== VEGA SCORECARD (real activity, per account) ===\n");
  for (const p of s.profiles) {
    console.log(`${p.label}: net ${usd(p.netPnl)} (realized ${usd(p.realizedPnl)}, ${p.openCount} open ${usd(p.unrealizedPnl)})`);
    if (p.closed > 0) {
      console.log(`  ${p.closed} closed · win ${(p.winRate * 100).toFixed(0)}% (${p.wins}W/${p.losses}L) · avg win ${pct(p.avgWinPct)} / loss ${pct(p.avgLossPct)} · avg hold ${p.avgHoldDays}d`);
      console.log(`  best ${usd(p.bestPnl)} / worst ${usd(p.worstPnl)} · API cost ${usd(-p.apiCost)}`);
    } else {
      console.log(`  no closed trades yet`);
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
