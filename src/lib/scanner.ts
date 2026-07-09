/**
 * Nightly zone scanner. For each ACTIVE profile, batches daily bars for that
 * profile's universe, runs the zone strategy with the profile's options, and
 * writes the next session's candidate list tagged with the profile id.
 * PAPER/analysis only — no orders here.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { universe as universeTable, candidates as candidatesTable, researchRuns } from "../db/schema";
import { getMultiStockBars, type Bar } from "./alpaca";
import { buildZoneSetup } from "./strategy";
import { classifyAndScore } from "./playbook";
import { activeProfiles, type Profile } from "./profiles";

const BARS_LOOKBACK_DAYS = 4000; // full available daily history (zones persist for all time)
const CHUNK = 40; // symbols per multi-bar request (respect free-tier limits)

/** Symbols in a profile's universe (active rows tagged with that profile). */
export async function loadUniverse(profileId: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(universeTable)
    .where(and(eq(universeTable.active, true), eq(universeTable.profileId, profileId)))
    .orderBy(universeTable.symbol);
  return rows.map((r) => r.symbol);
}

export interface ScanResult {
  profileId: string;
  runDate: string;
  scanned: number;
  candidates: number;
  validSetups: number;
}

async function scanProfile(profile: Profile, runDate: string): Promise<ScanResult> {
  const symbols = await loadUniverse(profile.id);
  const base: ScanResult = { profileId: profile.id, runDate, scanned: symbols.length, candidates: 0, validSetups: 0 };
  if (symbols.length === 0) return base;

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
      setup = buildZoneSetup(bars, profile.strategy);
    } catch {
      continue;
    }
    if (!setup.active_zone || setup.distance_to_edge_pct == null) continue;

    let score: number | null = null;
    let playbook: string | null = null;
    if ((setup.direction === "call" || setup.direction === "put") && setup.active_zone) {
      try {
        const pb = classifyAndScore(bars, setup.active_zone, setup.direction, Number(setup.price));
        score = pb.score;
        playbook = pb.playbook;
      } catch {
        score = null;
      }
    }

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
      score,
      playbook,
      profileId: profile.id,
    });
  }

  // Replace this profile's candidates for the runDate (idempotent re-runs).
  await db
    .delete(candidatesTable)
    .where(and(eq(candidatesTable.runDate, runDate), eq(candidatesTable.profileId, profile.id)));
  if (rows.length) await db.insert(candidatesTable).values(rows);

  return { ...base, candidates: rows.length, validSetups: rows.filter((r) => r.setupValid).length };
}

export async function runScan(runDate = new Date().toISOString().slice(0, 10)): Promise<ScanResult[]> {
  const results: ScanResult[] = [];
  for (const profile of activeProfiles()) {
    results.push(await scanProfile(profile, runDate));
  }

  const totalScanned = results.reduce((s, r) => s + r.scanned, 0);
  const totalValid = results.reduce((s, r) => s + r.validSetups, 0);
  const perProfile = results.map((r) => `${r.profileId}: ${r.validSetups}/${r.candidates}`).join(", ");

  // Log the scan as a run so it shows on the Log page with its time.
  await db.insert(researchRuns).values({
    runDate,
    status: "complete",
    model: "scan",
    marketContext: `Scanned ${totalScanned} names across ${results.length} profiles — ${totalValid} live setups (${perProfile}).`,
    searchCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    costEstimate: "0",
  });

  return results;
}
