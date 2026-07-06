/**
 * Reconcile the watchlist to exactly the SEED symbols: insert any that are
 * missing, mark SEED symbols active, and deactivate everything else (rows are
 * kept for history, just active=false). Idempotent.
 *
 * Run: npm run seed
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { watchlist } from "../src/db/schema";

// 3 most liquid names — tight signal over broad coverage (keeps ~$20/mo target).
const SEED: { symbol: string; notes: string }[] = [
  { symbol: "AAPL", notes: "mega-cap tech, very liquid options" },
  { symbol: "NVDA", notes: "AI bellwether, high implied volatility" },
  { symbol: "TSLA", notes: "high beta, headline-driven, heavy options volume" },
];

async function main() {
  const seedSymbols = new Set(SEED.map((s) => s.symbol));
  const existing = await db.select().from(watchlist);
  const haveSymbols = new Set(existing.map((r) => r.symbol));

  // insert missing seed symbols (active)
  const toInsert = SEED.filter((s) => !haveSymbols.has(s.symbol));
  if (toInsert.length > 0) {
    await db.insert(watchlist).values(toInsert.map((s) => ({ symbol: s.symbol, notes: s.notes, active: true })));
    console.log(`Inserted: ${toInsert.map((s) => s.symbol).join(", ")}`);
  }

  // reconcile active flags for existing rows
  for (const row of existing) {
    const shouldBeActive = seedSymbols.has(row.symbol);
    if (row.active !== shouldBeActive) {
      await db.update(watchlist).set({ active: shouldBeActive }).where(eq(watchlist.id, row.id));
      console.log(`${shouldBeActive ? "Activated" : "Deactivated"}: ${row.symbol}`);
    }
  }

  const active = await db.select({ symbol: watchlist.symbol }).from(watchlist).where(eq(watchlist.active, true));
  console.log(`Active watchlist (${active.length}): ${active.map((r) => r.symbol).join(", ")}`);
}

main().catch((err) => {
  console.error("Seed failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
