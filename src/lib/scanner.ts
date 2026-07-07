/**
 * Nightly zone scanner. Batches daily bars for the whole universe, runs the
 * zone strategy per symbol, and writes the next session's candidate list.
 * PAPER/analysis only — no orders here.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { universe as universeTable, candidates as candidatesTable } from "../db/schema";
import { getMultiStockBars, type Bar } from "./alpaca";
import { buildZoneSetup } from "./strategy";

const BARS_LOOKBACK_DAYS = 4000; // full available daily history (zones persist for all time)
const CHUNK = 40; // symbols per multi-bar request (respect free-tier limits)

export async function loadUniverse(): Promise<string[]> {
  const rows = await db.select().from(universeTable).where(eq(universeTable.active, true)).orderBy(universeTable.symbol);
  return rows.map((r) => r.symbol);
}

export interface ScanResult {
  runDate: string;
  scanned: number;
  candidates: number;
  validSetups: number;
}

export async function runScan(runDate = new Date().toISOString().slice(0, 10)): Promise<ScanResult> {
  const symbols = await loadUniverse();
  if (symbols.length === 0) throw new Error("universe is empty; seed it first (npm run seed:universe)");

  const barsBySymbol: Record<string, Bar[]> = {};
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const chunk = symbols.slice(i, i + CHUNK);
    const res = await getMultiStockBars(chunk, BARS_LOOKBACK_DAYS);
    Object.assign(barsBySymbol, res);
  }

  const rows: (typeof candidatesTable.$inferInsert)[] = [];
  for (const sym of symbols) {
    const bars = barsBySymbol[sym];
    if (!bars || bars.length < 60) continue;
    let setup;
    try {
      setup = buildZoneSetup(bars);
    } catch {
      continue;
    }
    // A candidate is a symbol approaching an active zone in its travel direction.
    if (!setup.active_zone || setup.distance_to_edge_pct == null) continue;
    rows.push({
      runDate,
      symbol: sym,
      direction: setup.direction,
      approach: setup.approach,
      clearRunway: setup.clear_runway,
      distanceToEdgePct: String(setup.distance_to_edge_pct),
      setupValid: setup.setup_valid,
      price: String(setup.price),
      zone: setup.active_zone,
      setup,
    });
  }

  // Replace today's candidates (idempotent re-runs).
  await db.delete(candidatesTable).where(eq(candidatesTable.runDate, runDate));
  if (rows.length) await db.insert(candidatesTable).values(rows);

  return {
    runDate,
    scanned: symbols.length,
    candidates: rows.length,
    validSetups: rows.filter((r) => r.setupValid).length,
  };
}
