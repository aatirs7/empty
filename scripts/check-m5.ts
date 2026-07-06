/**
 * M5 verification (no order placed):
 *  1. assert the pure risk math on a known example
 *  2. live-resolve the first PENDING real-trade proposal to a concrete contract,
 *     quote it, and compute dollars-at-risk (same path as /api/proposals/[id]/preview)
 *
 * Run: npm run check:m5
 */
import "dotenv/config";
import { and, eq, ne, desc } from "drizzle-orm";
import { db } from "../src/db";
import { proposals } from "../src/db/schema";
import { computeRisk } from "../src/lib/risk";
import { resolveContract } from "../src/lib/resolve";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function main() {
  // 1. pure risk math — call, strike 100, premium 3, qty 1, spot 100
  const r = computeRisk({ direction: "call", strike: 100, premiumPerShare: 3, qty: 1, underlyingPrice: 100 });
  assert(r.maxLoss === 300, `maxLoss expected 300, got ${r.maxLoss}`);
  assert(r.breakeven === 103, `breakeven expected 103, got ${r.breakeven}`);
  assert(r.scenarios[0].payoff === -300, `flat payoff expected -300, got ${r.scenarios[0].payoff}`);
  assert(r.scenarios[1].payoff === 200, `+5% payoff expected 200, got ${r.scenarios[1].payoff}`);
  assert(r.scenarios[2].payoff === 700, `+10% payoff expected 700, got ${r.scenarios[2].payoff}`);
  console.log("✅ risk math OK:", JSON.stringify(r));

  // 2. live preview on a pending real-trade proposal
  const [p] = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.status, "pending"), ne(proposals.strategy, "no_trade")))
    .orderBy(desc(proposals.id))
    .limit(1);

  if (!p) {
    console.log("\n(no pending real-trade proposal to preview — run `npm run vega` first)");
    return;
  }

  console.log(`\nLive preview for proposal ${p.id}: ${p.symbol} ${p.strategy} (${p.strikeHint} / ${p.expiryHint})`);
  const direction = p.direction as "call" | "put";
  const resolved = await resolveContract({
    symbol: p.symbol,
    direction,
    strikeHint: p.strikeHint ?? "ATM",
    expiryHint: p.expiryHint ?? "nearest weekly",
  });
  console.log(`  resolved: ${resolved.symbol}  strike $${resolved.strike}  exp ${resolved.expiry}`);
  console.log(`  spot $${resolved.underlyingPrice}  bid ${resolved.bid}  ask ${resolved.ask}  price ${resolved.price}`);

  if (resolved.price == null) {
    console.log("  (no quote — market closed/unpriced; execution would refuse with code=no_quote)");
    return;
  }
  const risk = computeRisk({
    direction,
    strike: resolved.strike,
    premiumPerShare: resolved.price,
    qty: 1,
    underlyingPrice: resolved.underlyingPrice,
  });
  console.log(`  MAX LOSS: $${risk.maxLoss}   breakeven: $${risk.breakeven}`);
  console.log(`  scenarios: ${risk.scenarios.map((s) => `${s.label} -> $${s.payoff}`).join("  |  ")}`);
  console.log("\n✅ M5 resolve + quote + risk path verified (no order placed).");
}

main().catch((err) => {
  console.error("check-m5 failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
