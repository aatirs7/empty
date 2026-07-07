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

export function buildZoneSetup(bars: Bar[], opts: StrategyOptions = DEFAULT_STRATEGY_OPTIONS): ZoneSetup {
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
  if (zones.length === 0) return empty;

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

  // A tapped zone fires this session; otherwise the nearest zone within proximity is a candidate to watch.
  const tappedCands = cands.filter((c) => c.tapped).sort((a, b) => a.distPct - b.distPct);
  const nearCands = cands.filter((c) => !c.tapped && c.distPct <= opts.proximityPct).sort((a, b) => a.distPct - b.distPct);
  const target = tappedCands[0] ?? nearCands[0];
  if (!target) return empty;

  // White space (hard gate): no OTHER zone between recent price and the tapped edge.
  const lo = Math.min(recentPrice, target.edge);
  const hi = Math.max(recentPrice, target.edge);
  const blocking = zones.some((z) => z !== target.zone && z.top >= lo && z.bottom <= hi);
  const clearRunway = !blocking;

  const setupValid = target.tapped && clearRunway;

  return {
    active_zone: { bottom: target.zone.bottom, top: target.zone.top },
    tapped_edge: Math.round(target.edge * 100) / 100,
    trigger_edge: "first_touch",
    approach: target.approach,
    direction: target.direction,
    clear_runway: clearRunway,
    tap_granularity: "daily_scan",
    distance_to_edge_pct: Math.round(target.distPct * 100) / 100,
    setup_valid: setupValid,
    price,
  };
}
