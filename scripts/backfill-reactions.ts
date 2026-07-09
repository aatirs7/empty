/**
 * Phase-1 backfill of the historical-reaction database. Replays daily + 4H bars
 * for the SniperBot + QQQ universes and records every zone tap's outcome.
 * 5-min intraday is a follow-on. Run: npm run backfill
 */
import "dotenv/config";
import { loadUniverse } from "../src/lib/scanner";
import { backfillReactions } from "../src/lib/reactions";
import { getMultiStockBars, getIntradayBars, type Bar } from "../src/lib/alpaca";

const DAILY_OPTS = { atrLength: 50, displacement: 1.7, firstTouchOnly: true, useFVG: false };
const FOURH_OPTS = { atrLength: 50, displacement: 1.3, firstTouchOnly: true, useFVG: false };
const FOURH_LOOKBACK_MIN = 3 * 365 * 24 * 60; // ~3 years of 4H bars

async function main() {
  const symbols = [...new Set([...(await loadUniverse("sniper_swing")), ...(await loadUniverse("qqq_0dte"))])];
  console.log(`backfilling reactions for ${symbols.length} symbols (daily + 4H)...`);

  // Daily bars, batched.
  const daily: Record<string, Bar[]> = {};
  for (let i = 0; i < symbols.length; i += 40) {
    Object.assign(daily, await getMultiStockBars(symbols.slice(i, i + 40), 4000));
  }

  let totalDaily = 0;
  let total4h = 0;
  let done = 0;
  for (const sym of symbols) {
    try {
      if (daily[sym]?.length) totalDaily += await backfillReactions(sym, daily[sym], "daily", DAILY_OPTS);
    } catch (e) {
      console.log(`  ${sym} daily error: ${(e as Error).message}`);
    }
    try {
      const fourH = await getIntradayBars(sym, "4Hour", FOURH_LOOKBACK_MIN);
      if (fourH.length) total4h += await backfillReactions(sym, fourH, "4h", FOURH_OPTS);
    } catch (e) {
      console.log(`  ${sym} 4H error: ${(e as Error).message}`);
    }
    done++;
    if (done % 25 === 0) console.log(`  ...${done}/${symbols.length} (daily ${totalDaily}, 4h ${total4h} reactions)`);
  }

  console.log(`\nbackfill complete: ${totalDaily} daily + ${total4h} 4H reactions across ${symbols.length} symbols.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
