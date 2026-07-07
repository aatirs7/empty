/**
 * Zone strategy layer (STRATEGY.md rules) on top of the raw zone engine.
 * Turns detected zones + recent price action into a tradeable `zone_setup`:
 * approach direction, the rejection rule (fade the approach), the white-space
 * hard gate, and daily-scan tap validity.
 *
 * GUARDRAIL: all code-computed. The model never produces a zone bound, distance,
 * or direction — it only reasons over this object.
 */
import type { Bar } from "./alpaca";
import { computeZones, type Zone, type ZoneOptions, DEFAULT_ZONE_OPTIONS } from "./zones";

export interface ZoneSetup {
  active_zone: { type: "demand" | "supply"; bottom: number; top: number } | null;
  approach: "from_above" | "from_below" | "inside" | null;
  direction: "call" | "put" | null;
  clear_runway: boolean;
  tap_granularity: "daily_scan";
  distance_to_edge_pct: number | null;
  setup_valid: boolean;
  price: number;
}

export interface StrategyOptions {
  proximityPct: number; // price must be within this % of a zone edge to be a candidate
  slopeWindow: number; // bars used to read approach direction
  zone: ZoneOptions;
}

export const DEFAULT_STRATEGY_OPTIONS: StrategyOptions = {
  proximityPct: 4,
  slopeWindow: 3,
  zone: DEFAULT_ZONE_OPTIONS,
};

/** Net price change over the last `window` bars (sign = approach direction). */
function recentSlope(bars: Bar[], window: number): number {
  const n = bars.length;
  const from = bars[Math.max(0, n - 1 - window)].c;
  return bars[n - 1].c - from;
}

export function buildZoneSetup(bars: Bar[], opts: StrategyOptions = DEFAULT_STRATEGY_OPTIONS): ZoneSetup {
  const { active, lastBar } = computeZones(bars, opts.zone);
  const price = lastBar.c;
  const empty: ZoneSetup = {
    active_zone: null,
    approach: null,
    direction: null,
    clear_runway: false,
    tap_granularity: "daily_scan",
    distance_to_edge_pct: null,
    setup_valid: false,
    price,
  };
  if (active.length === 0) return empty;

  const slope = recentSlope(bars, opts.slopeWindow);
  const movingDown = slope < 0;
  const movingUp = slope > 0;

  type Cand = { zone: Zone; approach: "from_above" | "from_below" | "inside"; nearEdge: number; distPct: number };
  const cands: Cand[] = active.map((z) => {
    if (price > z.top) return { zone: z, approach: "from_above", nearEdge: z.top, distPct: ((price - z.top) / price) * 100 };
    if (price < z.bottom)
      return { zone: z, approach: "from_below", nearEdge: z.bottom, distPct: ((z.bottom - price) / price) * 100 };
    return { zone: z, approach: "inside", nearEdge: price, distPct: 0 };
  });

  // Keep only zones in the direction of travel (or ones price sits inside), within proximity.
  const eligible = cands
    .filter((c) => {
      if (c.approach === "inside") return true;
      if (c.approach === "from_above") return movingDown; // above a zone, falling toward it
      return movingUp; // below a zone, rising toward it
    })
    .filter((c) => c.distPct <= opts.proximityPct);

  if (eligible.length === 0) return empty;

  eligible.sort((a, b) => a.distPct - b.distPct);
  const target = eligible[0];

  // Rejection rule: fade the approach. Tap from above -> call; from below -> put.
  let direction: "call" | "put";
  if (target.approach === "from_above") direction = "call";
  else if (target.approach === "from_below") direction = "put";
  else direction = movingDown ? "call" : "put";

  // White space (hard gate): no OTHER active zone between price and the target near edge.
  const lo = Math.min(price, target.nearEdge);
  const hi = Math.max(price, target.nearEdge);
  const blocking = active.some((z) => z !== target.zone && z.top >= lo && z.bottom <= hi);
  const clearRunway = !blocking;

  // Daily-scan tap validity: today's candle wicked into the zone, or price sits inside it.
  const wicked = lastBar.h >= target.zone.bottom && lastBar.l <= target.zone.top;
  const inside = target.approach === "inside";
  const setupValid = clearRunway && (wicked || inside);

  return {
    active_zone: { type: target.zone.type, bottom: target.zone.bottom, top: target.zone.top },
    approach: target.approach,
    direction,
    clear_runway: clearRunway,
    tap_granularity: "daily_scan",
    distance_to_edge_pct: Math.round(target.distPct * 100) / 100,
    setup_valid: setupValid,
    price,
  };
}
