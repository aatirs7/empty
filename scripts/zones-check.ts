/**
 * I1 sanity check: print detected zones for a few symbols so the math can be
 * eyeballed against Farrukh's TradingView before wiring anything downstream.
 *
 * Run: npm run zones-check           (AAPL NVDA TSLA)
 *      npm run zones-check -- SPY QQQ
 */
import "dotenv/config";
import { getStockBars, getUnderlyingPrice } from "../src/lib/alpaca";
import { computeZones, type Zone } from "../src/lib/zones";

const args = process.argv.slice(2);
const SYMBOLS = args.length ? args.map((s) => s.toUpperCase()) : ["AAPL", "NVDA", "TSLA"];

function fmt(z: Zone, price: number): string {
  const inside = price >= z.bottom && price <= z.top ? " <-- price INSIDE" : "";
  return `${z.type.padEnd(6)} [${z.bottom.toFixed(2)} - ${z.top.toFixed(2)}]  formed ${z.formedAt.slice(0, 10)}${
    z.used ? "  (used)" : ""
  }${inside}`;
}

async function main() {
  for (const sym of SYMBOLS) {
    try {
      const bars = await getStockBars(sym, 4000); // full available daily history
      const res = computeZones(bars);
      let price = res.lastBar.c;
      try {
        price = await getUnderlyingPrice(sym);
      } catch {
        // fall back to last close if the trade endpoint is unavailable
      }
      const usedCount = res.zones.filter((z) => z.used).length;
      console.log(
        `\n=== ${sym} ===  bars:${bars.length}  price:${price.toFixed(2)}  ATR50:${res.atr.toFixed(2)}  zones:${res.zones.length} (active ${res.active.length}, used ${usedCount})`,
      );
      const activeDemand = res.active.filter((z) => z.type === "demand").sort((a, b) => b.top - a.top);
      const activeSupply = res.active.filter((z) => z.type === "supply").sort((a, b) => a.bottom - b.bottom);
      console.log(`  ACTIVE demand (support, ${activeDemand.length}):`);
      activeDemand.slice(0, 6).forEach((z) => console.log("    ", fmt(z, price)));
      console.log(`  ACTIVE supply (resistance, ${activeSupply.length}):`);
      activeSupply.slice(0, 6).forEach((z) => console.log("    ", fmt(z, price)));
      const recent = [...res.zones].sort((a, b) => b.formedAt.localeCompare(a.formedAt)).slice(0, 14);
      console.log(`  most recent zones (any status):`);
      recent.forEach((z) => console.log("    ", fmt(z, price)));
    } catch (e) {
      console.error(`  ${sym}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
