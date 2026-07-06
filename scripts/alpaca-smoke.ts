/**
 * M1 — Alpaca paper smoke test.
 *
 * Confirms the paper keys + options access work end to end:
 *   1. read the account
 *   2. get the underlying spot price
 *   3. resolve one near-ATM call ~1-4 weeks out off the live chain
 *   4. place a paper limit BUY order, qty 1
 *   5. poll for the fill and read it back
 *
 * Options fill only during US market hours (09:30-16:00 ET). Outside those
 * hours the order will sit as `accepted`/`new` and fill at the next open —
 * that still proves the plumbing works.
 *
 * Run: npm run smoke
 */
import "dotenv/config";
import {
  getAccount,
  getUnderlyingPrice,
  listOptionContracts,
  getOptionQuotes,
  midPrice,
  placeOptionOrder,
  waitForFill,
  type OptionContract,
} from "../src/lib/alpaca";

const UNDERLYING = process.env.SMOKE_SYMBOL ?? "AAPL";

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysFromNow(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

async function main() {
  console.log(`\n=== Vega M1: Alpaca paper smoke test (${UNDERLYING}) ===\n`);

  // 1. Account
  const account = await getAccount();
  console.log("Account:");
  console.log(`  status:               ${account.status}`);
  console.log(`  options level:        ${account.options_trading_level ?? account.options_approved_level ?? "?"}`);
  console.log(`  buying power:         $${account.buying_power}`);
  if (account.status !== "ACTIVE") {
    console.warn("  ! account is not ACTIVE — orders may be rejected.");
  }

  // 2. Spot
  const spot = await getUnderlyingPrice(UNDERLYING);
  console.log(`\nSpot ${UNDERLYING}: $${spot.toFixed(2)}`);

  // 3. Resolve a near-ATM call ~1-4 weeks out
  const contracts = await listOptionContracts({
    underlyingSymbol: UNDERLYING,
    type: "call",
    expirationDateGte: ymd(daysFromNow(5)),
    expirationDateLte: ymd(daysFromNow(35)),
    strikePriceGte: spot * 0.9,
    strikePriceLte: spot * 1.1,
    limit: 500,
  });
  if (contracts.length === 0) {
    throw new Error("No option contracts returned in the 5-35 day / ±10% window. Try a different SMOKE_SYMBOL.");
  }
  // nearest expiry, then strike nearest spot
  const nearestExpiry = contracts
    .map((c) => c.expiration_date)
    .sort()[0];
  const atExpiry = contracts.filter((c) => c.expiration_date === nearestExpiry);
  const pick: OptionContract = atExpiry.reduce((best, c) =>
    Math.abs(Number(c.strike_price) - spot) < Math.abs(Number(best.strike_price) - spot) ? c : best,
  );
  console.log(`\nChosen contract:`);
  console.log(`  ${pick.symbol}`);
  console.log(`  strike $${pick.strike_price}  expiry ${pick.expiration_date}  tradable=${pick.tradable}`);

  // 4. Price it
  const quotes = await getOptionQuotes([pick.symbol]);
  const quote = quotes[pick.symbol];
  const mid = midPrice(quote);
  if (quote) {
    console.log(`  quote: bid $${quote.bp}  ask $${quote.ap}  mid $${mid?.toFixed(2) ?? "n/a"}`);
  } else {
    console.log("  quote: none available (data delayed or market closed).");
  }
  // marketable buy: use ask when we have it, else mid, else a nominal floor
  const limitPrice = Math.max(0.01, Number((quote?.ap && quote.ap > 0 ? quote.ap : mid ?? 0.05).toFixed(2)));
  console.log(`  limit price: $${limitPrice.toFixed(2)}`);

  // 5. Place order
  console.log(`\nPlacing paper BUY limit order, qty 1 ...`);
  const order = await placeOptionOrder({ symbol: pick.symbol, qty: 1, side: "buy", limitPrice });
  console.log(`  order id:   ${order.id}`);
  console.log(`  status:     ${order.status}`);

  // 6. Poll for fill + read back
  const final = await waitForFill(order.id, 20_000, 1500);
  console.log(`\nFinal order state:`);
  console.log(`  status:            ${final.status}`);
  console.log(`  filled qty:        ${final.filled_qty}`);
  console.log(`  filled avg price:  ${final.filled_avg_price ?? "—"}`);
  console.log(`  filled at:         ${final.filled_at ?? "—"}`);

  if (final.status === "filled") {
    console.log(`\n✅ M1 pass: paper option order filled.`);
  } else if (final.status === "rejected" || final.status === "canceled") {
    console.log(`\n❌ Order ${final.status}. Check account options level and buying power.`);
    process.exitCode = 1;
  } else {
    console.log(
      `\n⏳ Order is "${final.status}" (not yet filled). If the US market is closed, it will fill at the next open. Re-run during market hours to see it fill.`,
    );
  }
}

main().catch((err) => {
  console.error("\n❌ Smoke test failed:\n", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
