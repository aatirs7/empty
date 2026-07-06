/**
 * Operation Vega — the daily research run.
 *
 * Loads the active watchlist from Neon, runs The Brain, and persists the run +
 * proposals (status `pending`). It NEVER places orders. Also runs in GitHub
 * Actions (M4).
 *
 * Run: npm run vega
 */
import "dotenv/config";
import { runAndPersist } from "../src/lib/run-vega";
import { ResearchParseError } from "../src/lib/anthropic";

/**
 * True when it's a weekday and ET is within the pre-market window (08:00–09:15).
 * Uses the IANA tz database so DST is handled automatically. The GitHub Actions
 * job fires two crons (12:30 + 13:30 UTC); only the one that lands in this window
 * proceeds, so exactly one real run happens per weekday year-round.
 */
function inPreMarketWindowET(): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const isWeekday = !["Sat", "Sun"].includes(weekday);
  const mins = hour * 60 + minute;
  return isWeekday && mins >= 8 * 60 && mins <= 9 * 60 + 15;
}

async function main() {
  // Scheduled runs only proceed in the ET pre-market window. Manual runs
  // (workflow_dispatch sets VEGA_FORCE) and local runs bypass the guard.
  if (!process.env.VEGA_FORCE && process.env.GITHUB_ACTIONS && !inPreMarketWindowET()) {
    console.log("Outside the ET pre-market window (08:00–09:15) — skipping this scheduled trigger.");
    return;
  }

  console.log(`\n=== Operation Vega — research run ===\n`);
  const started = Date.now();

  const { runId, result, proposalsInserted, auto } = await runAndPersist();

  console.log(JSON.stringify(result.output, null, 2));

  console.log("\n--- run persisted ---");
  console.log(`  run id:         ${runId}`);
  console.log(`  status:         complete`);
  console.log(`  proposals:      ${proposalsInserted}`);
  console.log(`  model:          ${result.model}`);
  console.log(`  input tokens:   ${result.inputTokens}`);
  console.log(`  output tokens:  ${result.outputTokens}`);
  console.log(`  web searches:   ${result.searchCount}`);
  console.log(`  est. cost:      $${result.costEstimate.toFixed(4)}`);
  console.log(`  wall time:      ${((Date.now() - started) / 1000).toFixed(1)}s`);

  console.log("\n--- auto-execute ---");
  if (!auto.enabled) {
    console.log("  disabled (human-in-the-loop). Enable in settings to auto-place high-confidence trades.");
  } else {
    console.log(`  enabled: minConfidence=${auto.minConfidence} maxTradesPerDay=${auto.maxTradesPerDay} alreadyToday=${auto.alreadyPlacedToday}`);
    if (auto.placed.length === 0) console.log("  no qualifying proposals this run.");
    for (const p of auto.placed) {
      console.log(`  ${p.symbol}: ${p.ok ? `PLACED order ${p.orderId} (${p.status})` : `skipped (${p.error})`}`);
    }
  }

  console.log(`\n✅ Run ${runId} written to Neon (research_runs + proposals).`);
}

main().catch((err) => {
  if (err instanceof ResearchParseError) {
    console.error("\n❌ The Brain returned unparseable output; run marked `failed` with raw text stored.\n");
    console.error(err.rawText);
  } else {
    console.error("\n❌ Operation Vega failed:\n", err instanceof Error ? err.message : err);
  }
  process.exitCode = 1;
});
