/**
 * Print the paper-month scorecard to the terminal.
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
  console.log("\n=== VEGA PAPER-MONTH SCORECARD ===\n");
  console.log(`Proposals: ${s.counts.totalProposals} total, ${s.counts.realTrades} real, ${s.counts.noTrades} no_trade | open shadows: ${s.counts.openShadows}`);

  console.log("\n1) Overall (closed shadows)");
  console.log(line(s.overall));
  console.log(`  avg winner ${pct(s.overall.avgWinnerPct)} | avg loser ${pct(s.overall.avgLoserPct)}`);

  console.log("\n2) Priced-in read (does 'underdone' beat 'priced_in'?)");
  s.pricedIn.forEach((b) => console.log(line(b)));

  console.log("\n3) Confidence calibration (higher should win more)");
  s.confidence.forEach((b) => console.log(line(b)));

  console.log("\n4) By variant");
  s.variants.forEach((b) => console.log(line(b)));

  console.log("\n5) Baseline (SPY ATM call)");
  console.log(line(s.baseline));

  console.log("\n6) Bottom line");
  console.log(`  net P&L (shadows): ${usd(s.overall.netPnl)}   API cost: -$${s.apiCost.toFixed(2)}   NET AFTER COST: ${usd(s.netAfterCost)}`);
  console.log(`  beats dumb baseline: ${s.beatsBaseline == null ? "n/a (need data)" : s.beatsBaseline ? "YES" : "NO"}`);
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
