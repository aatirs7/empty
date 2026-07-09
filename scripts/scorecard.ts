/**
 * Print the per-profile scorecard (shadow-only; each strategy vs its own baseline).
 *
 * Run: npm run scorecard
 */
import "dotenv/config";
import { computeScorecard } from "../src/lib/scorecard";

const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
const usd = (x: number) => `${x >= 0 ? "+" : "-"}$${Math.abs(x).toFixed(2)}`;

async function main() {
  const s = await computeScorecard();
  console.log("\n=== VEGA PER-PROFILE SCORECARD (shadow-only, never blended) ===\n");
  for (const p of s.profiles) {
    const st = p.strategy;
    console.log(`${p.label}`);
    if (st.n === 0) {
      console.log(`  no closed setups yet (${p.openShadows} open)\n`);
      continue;
    }
    console.log(
      `  setups n=${st.n}  win ${(st.winRate * 100).toFixed(0)}%  avg ${pct(st.avgReturnPct)}  net ${usd(st.netPnl)}`,
    );
    console.log(`  avg winner ${pct(st.avgWinnerPct)} | avg loser ${pct(st.avgLoserPct)}`);
    console.log(`  baseline n=${p.baseline.n} avg ${pct(p.baseline.avgReturnPct)}  ->  ${p.beatsBaseline == null ? "n/a" : p.beatsBaseline ? "BEATS baseline" : "trails baseline"}\n`);
  }
  console.log(`API cost to date: -$${s.apiCost.toFixed(2)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
