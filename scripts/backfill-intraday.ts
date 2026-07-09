/**
 * Intraday reaction backfill for the QQQ 0DTE profile (15Min + 1H). Covers QQQ
 * plus liquid, index-correlated comparables so queryReactions has both a QQQ
 * (symbol) tier and an all-symbols fallback tier at these intraday timeframes.
 * (4H is already covered by the phase-1 backfill.) Run: npm run backfill:intraday
 */
import "dotenv/config";
import { backfillReactions } from "../src/lib/reactions";
import { getIntradayBars } from "../src/lib/alpaca";
import { ALPACA_TF, SCAN_LOOKBACK_MIN } from "../src/lib/timeframes";

const COMPS = [
  "QQQ", "SPY", "IWM", "DIA", "SMH", "XLK",
  "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "GOOG", "TSLA", "AVGO", "AMD",
  "NFLX", "COST", "MU", "CRM", "ADBE", "QCOM", "PLTR", "INTC", "AMAT",
];
const TFS = ["15min", "1h"] as const;
const OPTS = {
  "15min": { atrLength: 50, displacement: 1.2, firstTouchOnly: true, useFVG: false },
  "1h": { atrLength: 50, displacement: 1.25, firstTouchOnly: true, useFVG: false },
} as const;

async function main() {
  let total = 0;
  let done = 0;
  for (const sym of COMPS) {
    for (const tf of TFS) {
      try {
        const bars = await getIntradayBars(sym, ALPACA_TF[tf], SCAN_LOOKBACK_MIN[tf]);
        if (bars.length) {
          const n = await backfillReactions(sym, bars, tf, OPTS[tf]);
          total += n;
          console.log(`  ${sym} ${tf}: ${bars.length} bars -> ${n} reactions`);
        } else {
          console.log(`  ${sym} ${tf}: no bars`);
        }
      } catch (e) {
        console.log(`  ${sym} ${tf} ERROR: ${(e as Error).message}`);
      }
    }
    done++;
    if (done % 5 === 0) console.log(`...${done}/${COMPS.length} symbols (${total} reactions)`);
  }
  console.log(`\nintraday backfill complete: ${total} reactions across ${COMPS.length} symbols (15Min + 1H).`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
