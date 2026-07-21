/**
 * Zone strategy layer (STRATEGY.md, locked). Turns detected zones + recent price
 * into a tradeable `zone_setup`.
 *
 * Rules (locked):
 * - Zones are just support/resistance. Their top AND bottom are both levels; the
 *   demand/supply formation label NEVER drives direction.
 * - Direction is STATELESS: which side price is on relative to the tapped edge.
 *     price above the edge (coming down into it)  => call
 *     price below the edge (rising up into it)     => put
 *   This makes the "flip" automatic: once price closes through a zone it is on the
 *   other side, so the same rule yields the opposite trade on the next tap.
 * - Trigger = first edge touched this session (trigger_edge = 'first_touch').
 * - White space is a hard gate: no other zone between recent price and the tapped
 *   edge in the direction of travel.
 *
 * GUARDRAIL: all code-computed. The model never produces an edge, bound, or direction.
 */
import type { Bar } from "./alpaca";
import { computeZones, type Zone, type ZoneOptions, DEFAULT_ZONE_OPTIONS } from "./zones";
import { detectFlipsDetailed, DEFAULT_FLIP_OPTIONS, type FlipRejection } from "./flips";
import { detectBreakoutsDetailed, DEFAULT_BREAKOUT_OPTIONS, type BreakoutRejection } from "./breakout";

export interface ZoneSetup {
  active_zone: { bottom: number; top: number } | null; // no demand/supply label
  tapped_edge: number | null; // the specific edge price is trading against
  trigger_edge: "first_touch";
  approach: "from_above" | "from_below" | null;
  direction: "call" | "put" | null;
  clear_runway: boolean;
  tap_granularity: "daily_scan";
  distance_to_edge_pct: number | null;
  setup_valid: boolean;
  price: number;
  // Flip/breakout fields (absent/`"tap"` for SBv1 tap setups). When setup_kind is
  // "flip" or "breakout", tapped_edge/flipped_boundary is the boundary to retest.
  // "breakout" (SBv2 2026-07-21): a completed 4H candle body-closed outside a DAILY
  // zone into empty space; accepted_at = the qualifying 4h candle, sessions_since_flip
  // = completed 4h bars since it.
  setup_kind?: "tap" | "flip" | "breakout";
  flipped_boundary?: number;
  accepted_at?: string;
  sessions_since_flip?: number;
  empty_space_pct?: number | null;
  space_consumed_pct?: number | null;
}

export interface StrategyOptions {
  proximityPct: number; // price must be within this % of an edge to be a candidate
  approachWindow: number; // bars back used as "recent price" for the white-space gate
  zone: ZoneOptions;
}

export const DEFAULT_STRATEGY_OPTIONS: StrategyOptions = {
  proximityPct: 4,
  approachWindow: 5,
  zone: DEFAULT_ZONE_OPTIONS,
};

const overlaps = (bar: Bar, bottom: number, top: number): boolean => bar.h >= bottom && bar.l <= top;

/** Build up to `limit` tradeable setups from the nearest zones (tapped first,
 *  then nearest within proximity). Single-ticker profiles (QQQ) watch several
 *  levels per timeframe instead of just the closest one. */
export function buildZoneSetups(bars: Bar[], opts: StrategyOptions = DEFAULT_STRATEGY_OPTIONS, limit = 1): ZoneSetup[] {
  const { zones, lastBar } = computeZones(bars, opts.zone);
  const price = lastBar.c;
  const empty: ZoneSetup = {
    active_zone: null,
    tapped_edge: null,
    trigger_edge: "first_touch",
    approach: null,
    direction: null,
    clear_runway: false,
    tap_granularity: "daily_scan",
    distance_to_edge_pct: null,
    setup_valid: false,
    price,
  };
  if (zones.length === 0) return [empty];

  const n = bars.length;
  const recentPrice = bars[Math.max(0, n - 1 - opts.approachWindow)].c;

  interface Cand {
    zone: Zone;
    edge: number;
    approach: "from_above" | "from_below";
    direction: "call" | "put";
    distPct: number;
    tapped: boolean;
  }

  const cands: Cand[] = zones.map((z) => {
    let edge: number;
    let approach: "from_above" | "from_below";
    let direction: "call" | "put";
    if (price > z.top) {
      // price above the zone: it falls to tap the TOP edge from above -> call
      edge = z.top;
      approach = "from_above";
      direction = "call";
    } else if (price < z.bottom) {
      // price below the zone: it rises to tap the BOTTOM edge from below -> put
      edge = z.bottom;
      approach = "from_below";
      direction = "put";
    } else {
      // price inside: side by which way it came over the approach window
      if (price >= recentPrice) {
        approach = "from_below";
        direction = "put";
        edge = z.bottom;
      } else {
        approach = "from_above";
        direction = "call";
        edge = z.top;
      }
    }
    const distPct = (Math.abs(price - edge) / price) * 100;
    const tapped = overlaps(lastBar, z.bottom, z.top) || (price >= z.bottom && price <= z.top);
    return { zone: z, edge, approach, direction, distPct, tapped };
  });

  // A tapped zone fires this session; otherwise the nearest zones within proximity
  // are candidates to watch. Tapped first, then nearest-first.
  const tappedCands = cands.filter((c) => c.tapped).sort((a, b) => a.distPct - b.distPct);
  const nearCands = cands.filter((c) => !c.tapped && c.distPct <= opts.proximityPct).sort((a, b) => a.distPct - b.distPct);
  const ordered = [...tappedCands, ...nearCands];
  if (ordered.length === 0) return [empty];

  // White space (hard gate) — require clear room in the TRADE's direction. For a
  // call (bounce up off support) no nearby zone directly ABOVE; for a put no
  // nearby zone directly BELOW. "Nearby" = within RUNWAY_PCT of price.
  const RUNWAY_PCT = 4;
  const band = price * (RUNWAY_PCT / 100);
  const toSetup = (target: Cand): ZoneSetup => {
    const blocking =
      target.direction === "call"
        ? zones.some((z) => z !== target.zone && z.bottom > target.zone.top && z.bottom <= target.zone.top + band)
        : zones.some((z) => z !== target.zone && z.top < target.zone.bottom && z.top >= target.zone.bottom - band);
    const clearRunway = !blocking;
    return {
      active_zone: { bottom: target.zone.bottom, top: target.zone.top },
      tapped_edge: Math.round(target.edge * 100) / 100,
      trigger_edge: "first_touch",
      approach: target.approach,
      direction: target.direction,
      clear_runway: clearRunway,
      tap_granularity: "daily_scan",
      distance_to_edge_pct: Math.round(target.distPct * 100) / 100,
      setup_valid: target.tapped && clearRunway,
      price,
    };
  };

  // De-dup by zone bounds, take the nearest `limit`.
  const seen = new Set<string>();
  const out: ZoneSetup[] = [];
  for (const c of ordered) {
    const key = `${c.zone.bottom.toFixed(4)}-${c.zone.top.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toSetup(c));
    if (out.length >= limit) break;
  }
  return out;
}

/** Backward-compatible single-setup builder (the nearest/best zone). */
export function buildZoneSetup(bars: Bar[], opts: StrategyOptions = DEFAULT_STRATEGY_OPTIONS): ZoneSetup {
  return buildZoneSetups(bars, opts, 1)[0];
}

// SBv2 won't watch a flip whose retest is already implausibly far away (spec:
// "price has moved too far away from the entry"). Beyond this % from the boundary,
// a retest inside the 1-2 session window is unlikely — drop it.
const FLIP_MAX_DISTANCE_PCT = 12;
const FLIP_RUNWAY_PCT = 4;

export interface FlipBuild {
  setups: ZoneSetup[];
  rejections: Partial<Record<FlipRejection, number>>; // funnel: broke/wicked but not promoted
}

/**
 * Build up to `limit` tradeable FLIP setups (SBv2) AND the rejection funnel: a daily
 * zone that broke and ACCEPTED through, flipped role, awaiting its FIRST retest of the
 * flipped boundary. Same `bars → ZoneSetup[]` shape as buildZoneSetups; direction/edge
 * come from the flip, never a stateless side test. `rejections` tallies why the rest
 * were dropped (wick-only, closed back inside, already retested, >2 sessions, too far).
 */
export function buildFlipSetupsDetailed(bars: Bar[], opts: StrategyOptions = DEFAULT_STRATEGY_OPTIONS, limit = 1): FlipBuild {
  const { zones, lastBar } = computeZones(bars, opts.zone);
  const price = lastBar.c;
  const empty: ZoneSetup = {
    active_zone: null,
    tapped_edge: null,
    trigger_edge: "first_touch",
    approach: null,
    direction: null,
    clear_runway: false,
    tap_granularity: "daily_scan",
    distance_to_edge_pct: null,
    setup_valid: false,
    price,
    setup_kind: "flip",
  };
  if (zones.length === 0) return { setups: [empty], rejections: {} };

  const { flips: rawFlips, rejections } = detectFlipsDetailed(bars, zones, DEFAULT_FLIP_OPTIONS);
  const tally: Partial<Record<FlipRejection, number>> = { ...rejections };
  const flips = rawFlips
    .map((f) => ({ ...f, distPct: (Math.abs(price - f.flippedBoundary) / price) * 100 }))
    .filter((f) => {
      if (f.distPct <= FLIP_MAX_DISTANCE_PCT) return true;
      tally.too_far = (tally.too_far ?? 0) + 1; // price ran too far to plausibly retest soon
      return false;
    })
    .sort((a, b) => a.distPct - b.distPct);
  if (flips.length === 0) return { setups: [empty], rejections: tally };

  const band = price * (FLIP_RUNWAY_PCT / 100);
  const out: ZoneSetup[] = [];
  const seen = new Set<string>();
  for (const f of flips) {
    const key = `${f.zone.bottom.toFixed(4)}-${f.zone.top.toFixed(4)}-${f.direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // White space in the TRADE direction (continuation area): for a call (breaking up)
    // no zone directly above the flipped top within the band; for a put, none below.
    const blocking =
      f.direction === "call"
        ? zones.some((z) => z.bottom > f.zone.top && z.bottom <= f.zone.top + band)
        : zones.some((z) => z.top < f.zone.bottom && z.top >= f.zone.bottom - band);
    out.push({
      active_zone: { bottom: f.zone.bottom, top: f.zone.top },
      tapped_edge: Math.round(f.flippedBoundary * 100) / 100,
      trigger_edge: "first_touch",
      approach: f.direction === "call" ? "from_above" : "from_below", // retest taps the boundary from the accepted side
      direction: f.direction,
      clear_runway: !blocking,
      tap_granularity: "daily_scan",
      distance_to_edge_pct: Math.round(f.distPct * 100) / 100,
      setup_valid: true, // a valid flip awaiting its first live retest
      price,
      setup_kind: "flip",
      flipped_boundary: Math.round(f.flippedBoundary * 100) / 100,
      accepted_at: f.acceptedAt,
      sessions_since_flip: f.sessionsSinceFlip,
    });
    if (out.length >= limit) break;
  }
  return { setups: out.length ? out : [empty], rejections: tally };
}

/** Thin wrapper — flip setups only (unchanged callers). */
export function buildFlipSetups(bars: Bar[], opts: StrategyOptions = DEFAULT_STRATEGY_OPTIONS, limit = 1): ZoneSetup[] {
  return buildFlipSetupsDetailed(bars, opts, limit).setups;
}

export interface BreakoutBuild {
  setups: ZoneSetup[];
  rejections: Partial<Record<BreakoutRejection, number>>;
}

/**
 * SBv2 (2026-07-21 spec): 4H EMPTY-SPACE BREAKOUT & RETEST setups. DAILY bars
 * generate the order-block zones; COMPLETED 4h bars qualify the breakout, the
 * retest state, and the empty space. The current reference price is the last
 * completed 4h close (the 4-hour chart is the execution timeframe).
 */
export function buildBreakoutSetupsDetailed(
  dailyBars: Bar[],
  bars4h: Bar[],
  opts: StrategyOptions = DEFAULT_STRATEGY_OPTIONS,
  limit = 1,
): BreakoutBuild {
  const { zones } = computeZones(dailyBars, opts.zone);
  const price = bars4h.length ? bars4h[bars4h.length - 1].c : dailyBars[dailyBars.length - 1].c;
  const empty: ZoneSetup = {
    active_zone: null,
    tapped_edge: null,
    trigger_edge: "first_touch",
    approach: null,
    direction: null,
    clear_runway: false,
    tap_granularity: "daily_scan",
    distance_to_edge_pct: null,
    setup_valid: false,
    price,
    setup_kind: "breakout",
  };
  if (zones.length === 0 || bars4h.length === 0) return { setups: [empty], rejections: {} };

  const { breakouts, rejections } = detectBreakoutsDetailed(zones, bars4h, price, DEFAULT_BREAKOUT_OPTIONS);
  const out: ZoneSetup[] = [];
  const seen = new Set<string>();
  for (const b of breakouts) {
    const key = `${b.zone.bottom.toFixed(4)}-${b.zone.top.toFixed(4)}-${b.direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      active_zone: b.zone,
      tapped_edge: b.boundary,
      trigger_edge: "first_touch",
      // The retest approaches the boundary from the accepted (breakout) side.
      approach: b.direction === "call" ? "from_above" : "from_below",
      direction: b.direction,
      clear_runway: true, // empty space already validated by the detector
      tap_granularity: "daily_scan",
      distance_to_edge_pct: Math.round((Math.abs(price - b.boundary) / price) * 10000) / 100,
      setup_valid: true, // a qualified breakout awaiting its first retest
      price,
      setup_kind: "breakout",
      flipped_boundary: b.boundary,
      accepted_at: b.breakoutAt,
      sessions_since_flip: b.barsSinceBreakout,
      empty_space_pct: b.emptySpacePct,
      space_consumed_pct: b.consumedPct,
    });
    if (out.length >= limit) break;
  }
  return { setups: out.length ? out : [empty], rejections };
}
