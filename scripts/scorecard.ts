/**
 * Print the paper-month scorecard (shadow-only: zone setups vs SPY baseline).
 *
 * Run: npm run scorecard
 */
import "dotenv/config";
import { computeScorecard, type Bucket } from "../src/lib/scorecard";

const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
const usd = (x: number) => `${x >= 0 ? "+" : "-"}$${Math.abs(x).toFixed(2)}`;
const line = (b: Bucket) =>
  `  ${b.label.padEnd(12)} n=${String(b.n).padStart(3)}  win ${(b.winRate * 100).toFixed(0).padStart(3)}%  avg ${pct(b.avgReturnPct).padStart(7)}  pnl ${usd(b.netPnl)}`;

async function main() {
  const s = await computeScorecard();
  console.log("\n=== VEGA PAPER-MONTH SCORECARD (shadow-only) ===\n");
  console.log(`Zone setups shadowed: ${s.counts.setupsShadowed} (closed ${s.counts.closedShadows}, open ${s.counts.openShadows})`);

  console.log("\n1) Strategy (closed zone-setup shadows)");
  console.log(line(s.strategy));
  console.log(`  avg winner ${pct(s.strategy.avgWinnerPct)} | avg loser ${pct(s.strategy.avgLoserPct)}`);

  console.log("\n2) By variant");
  s.variants.forEach((b) => console.log(line(b)));

  console.log("\n3) Baseline (SPY ATM call)");
  console.log(line(s.baseline));

  console.log("\n4) Bottom line");
  console.log(`  strategy net: ${usd(s.strategy.netPnl)}   API cost: -$${s.apiCost.toFixed(2)}   NET AFTER COST: ${usd(s.netAfterCost)}`);
  console.log(`  beats dumb baseline: ${s.beatsBaseline == null ? "n/a (need data)" : s.beatsBaseline ? "YES" : "NO"}`);
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
