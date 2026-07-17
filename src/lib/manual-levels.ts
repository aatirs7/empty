/**
 * QQQ Manual level storage (owner-entered levels → qqq_manual candidates).
 *
 * Levels CARRY FORWARD (owner 2026-07-17): if no levels are entered today, the most
 * recent day's list is cloned into fresh candidate rows for today at the first
 * market-open monitor tick — directions re-derived from the LIVE spot (a level below
 * price = CALL support, above = PUT resistance), fresh ids so the once-per-level-per-
 * day tap dedup and proposal dedup work normally. Saving in the editor still replaces
 * today's rows wholesale.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { candidates } from "../db/schema";
import { getUnderlyingPrice } from "./alpaca";

export const MANUAL_PROFILE_ID = "qqq_manual";
export const MANUAL_SYMBOL = "QQQ";
// Synthetic zone half-width around a manual level (±0.15%): the machinery expects a
// zone with real height (playbook scoring, at-zone band, wrong-way check).
const HALF_BAND = 0.0015;
// All manual levels read the 15min reaction bucket (nearest intraday sample).
const DB_TIMEFRAME = "15min";

export interface SaveResult {
  saved: number;
  spot: number;
  levels: { level: number; direction: string }[];
}

/** Replace `runDate`'s manual candidates with this level list (directions from the
 *  live spot). `carriedFrom` marks rows cloned from a previous day. */
export async function saveManualLevels(rawLevels: number[], runDate: string, carriedFrom?: string): Promise<SaveResult> {
  const levels = [...new Set(rawLevels.filter((n): n is number => Number.isFinite(n) && n > 0))];
  const spot = await getUnderlyingPrice(MANUAL_SYMBOL);
  const enteredAt = new Date().toISOString();

  const rows = levels.map((level) => {
    const direction = level < spot ? "call" : "put";
    const approach = direction === "call" ? "from_above" : "from_below";
    const zone = {
      bottom: Math.round(level * (1 - HALF_BAND) * 100) / 100,
      top: Math.round(level * (1 + HALF_BAND) * 100) / 100,
    };
    const distance = Math.round((Math.abs(spot - level) / spot) * 10000) / 100;
    return {
      runDate,
      symbol: MANUAL_SYMBOL,
      direction,
      approach,
      clearRunway: false,
      distanceToEdgePct: String(distance),
      setupValid: true,
      price: String(spot),
      zone,
      // Shaped like a ZoneSetup where it matters (execute.ts reads active_zone for the
      // live wrong-way check); `manual` carries the owner's input + carry provenance.
      setup: {
        setup_valid: true,
        active_zone: zone,
        direction,
        approach,
        distance_to_edge_pct: distance,
        price: spot,
        manual: { level, enteredAt, ...(carriedFrom ? { carriedFrom } : {}) },
      },
      score: null,
      playbook: "Manual Level",
      profileId: MANUAL_PROFILE_ID,
      timeframe: DB_TIMEFRAME,
    };
  });

  await db.delete(candidates).where(and(eq(candidates.runDate, runDate), eq(candidates.profileId, MANUAL_PROFILE_ID)));
  if (rows.length) await db.insert(candidates).values(rows);
  return { saved: rows.length, spot, levels: rows.map((r) => ({ level: (r.setup.manual as { level: number }).level, direction: r.direction })) };
}

/** The most recent day that has manual levels (today included), with the list. */
export async function latestManualLevels(): Promise<{ runDate: string; levels: number[] } | null> {
  const [latest] = await db
    .select({ d: candidates.runDate })
    .from(candidates)
    .where(eq(candidates.profileId, MANUAL_PROFILE_ID))
    .orderBy(desc(candidates.runDate))
    .limit(1);
  if (!latest) return null;
  const rows = await db
    .select()
    .from(candidates)
    .where(and(eq(candidates.runDate, latest.d), eq(candidates.profileId, MANUAL_PROFILE_ID)));
  const levels = [
    ...new Set(rows.map((r) => (r.setup as { manual?: { level?: number } } | null)?.manual?.level).filter((n): n is number => n != null)),
  ];
  return { runDate: latest.d, levels };
}

/** If today has no manual levels, clone the most recent day's list into today
 *  (fresh candidate ids, directions off the live spot). Returns true if carried. */
export async function carryForwardManualLevels(today: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: candidates.id })
    .from(candidates)
    .where(and(eq(candidates.runDate, today), eq(candidates.profileId, MANUAL_PROFILE_ID)))
    .limit(1);
  if (existing) return false; // today's levels are in (fresh or already carried)
  const prev = await latestManualLevels();
  if (!prev || prev.levels.length === 0) return false; // nothing to carry
  await saveManualLevels(prev.levels, today, prev.runDate);
  return true;
}
