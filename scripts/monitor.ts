/**
 * Vega live intraday zone monitor (I6). A persistent worker: during market hours
 * it ticks every ~30s, firing the instant price taps a candidate's zone. Run it on
 * an always-on host (Railway/Render/Fly) or locally while the market is open.
 *
 *   npm run monitor
 *
 * Env: MONITOR_INTERVAL_MS (default 30000), DATA_FEED (iex|sip, default iex).
 * PAPER-ONLY: refuses to start unless TRADING_MODE=paper.
 */
import "dotenv/config";
import { monitorTick } from "../src/lib/monitor";
import { getClock } from "../src/lib/alpaca";

const INTERVAL = Number(process.env.MONITOR_INTERVAL_MS ?? 30_000);
const CLOSED_SLEEP = 5 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (process.env.TRADING_MODE !== "paper") {
    throw new Error(`GUARDRAIL: TRADING_MODE must be "paper", got "${process.env.TRADING_MODE}". Refusing to start.`);
  }
  console.log(`Vega intraday monitor started (interval ${INTERVAL}ms, feed ${process.env.DATA_FEED ?? "iex"}).`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const clock = await getClock();
      if (!clock.is_open) {
        console.log(`[${new Date().toISOString()}] market closed; next open ${clock.next_open}. Sleeping.`);
        await sleep(CLOSED_SLEEP);
        continue;
      }
      const fires = await monitorTick();
      for (const f of fires) {
        console.log(
          `[${new Date().toISOString()}] TAP ${f.symbol} ${f.direction} @ ${f.price} -> ${f.placed ? "BOUGHT" : "skipped"} (${f.detail})`,
        );
      }
    } catch (e) {
      console.error(`[${new Date().toISOString()}] tick error:`, e instanceof Error ? e.message : e);
    }
    await sleep(INTERVAL);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
