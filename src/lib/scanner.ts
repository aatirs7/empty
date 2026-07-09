/**
 * Nightly zone scanner. For each ACTIVE profile, batches daily bars for that
 * profile's universe, runs the zone strategy with the profile's options, and
 * writes the next session's candidate list tagged with the profile id.
 * PAPER/analysis only — no orders here.
 */
import { and, eq, notInArray } from "drizzle-orm";
import { db } from "../db";
import { universe as universeTable, candidates as candidatesTable, researchRuns } from "../db/schema";
import { getMultiStockBars, getIntradayBars, type Bar } from "./alpaca";
import { buildZoneSetup } from "./strategy";
import { classifyAndScore } from "./playbook";
import { activeProfiles, type Profile, type ZoneTimeframe } from "./profiles";
import { ALPACA_TF, SCAN_LOOKBACK_MIN } from "./timeframes";

const BARS_LOOKBACK_DAYS = 4000; // full available daily history (zones persist for all time)
const CHUNK = 40; // symbols per multi-bar request (respect free-tier limits)
const FOURH_SCAN_LOOKBACK_MIN = 365 * 24 * 60; // ~1 year of 4H bars for the scan

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

/** Scan one timeframe (daily batched, 4H per-symbol) → profile+timeframe candidates. */
async function scanTimeframe(
  profile: Profile,
  ztf: ZoneTimeframe,
  symbols: string[],
  runDate: string,
): Promise<{ candidates: number; valid: number }> {
  const barsBySymbol: Record<string, Bar[]> = {};
  if (ztf.timeframe === "daily") {
    for (let i = 0; i < symbols.length; i += CHUNK) {
      Object.assign(barsBySymbol, await getMultiStockBars(symbols.slice(i, i + CHUNK), BARS_LOOKBACK_DAYS));
    }
  } else {
    // Intraday (4h / 1h / 15min): fetch the right Alpaca interval + lookback.
    const alpacaTf = ALPACA_TF[ztf.timeframe];
    const lookback = SCAN_LOOKBACK_MIN[ztf.timeframe] ?? FOURH_SCAN_LOOKBACK_MIN;
    for (const sym of symbols) {
      try {
        barsBySymbol[sym] = await getIntradayBars(sym, alpacaTf, lookback);
      } catch {
        /* skip this symbol/timeframe */
      }
    }
  }

  const strat = { ...profile.strategy, zone: ztf.opts };
  const rows: (typeof candidatesTable.$inferInsert)[] = [];
  for (const sym of symbols) {
    const bars = barsBySymbol[sym];
    if (!bars || bars.length < 60) continue;
    let setup;
    try {
      setup = buildZoneSetup(bars, strat);
    } catch {
      continue;
    }
    if (!setup.active_zone || setup.distance_to_edge_pct == null) continue;

    let score: number | null = null;
    let playbook: string | null = null;
    if ((setup.direction === "call" || setup.direction === "put") && setup.active_zone) {
      try {
        const pb = classifyAndScore(bars, setup.active_zone, setup.direction, Number(setup.price));
        score = pb.displayScore; // UI ranking score (non-saturating); the live gate uses pb.score in monitor.ts
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
      timeframe: ztf.timeframe,
    });
  }

  // Replace this profile+timeframe's candidates for the runDate (idempotent).
  await db
    .delete(candidatesTable)
    .where(and(eq(candidatesTable.runDate, runDate), eq(candidatesTable.profileId, profile.id), eq(candidatesTable.timeframe, ztf.timeframe)));
  if (rows.length) await db.insert(candidatesTable).values(rows);

  return { candidates: rows.length, valid: rows.filter((r) => r.setupValid).length };
}

export async function scanProfile(profile: Profile, runDate: string): Promise<ScanResult> {
  const symbols = await loadUniverse(profile.id);
  const base: ScanResult = { profileId: profile.id, runDate, scanned: symbols.length, candidates: 0, validSetups: 0 };
  if (symbols.length === 0) return base;
  // Purge candidates from timeframes this profile no longer scans (e.g. QQQ's old
  // daily rows after the intraday switch) so the monitor never trades a stale tf.
  const keepTfs = profile.zoneTimeframes.map((z) => z.timeframe);
  await db
    .delete(candidatesTable)
    .where(and(eq(candidatesTable.runDate, runDate), eq(candidatesTable.profileId, profile.id), notInArray(candidatesTable.timeframe, keepTfs)));
  let candidates = 0;
  let validSetups = 0;
  for (const ztf of profile.zoneTimeframes) {
    const r = await scanTimeframe(profile, ztf, symbols, runDate);
    candidates += r.candidates;
    validSetups += r.valid;
  }
  return { ...base, candidates, validSetups };
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
