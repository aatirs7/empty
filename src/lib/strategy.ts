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
  // SB 15M (owner 2026-07-21): the live tap needs the WHOLE zone picture, not just
  // this setup's zone — "empty space" means the candle sits outside EVERY active
  // zone, and the entry level must be the FIRST boundary in the direction of travel.
  // htf_atr is the same ATR the zones were built from (HTF ATR length 50), used for
  // the touch tolerance (0.05-0.10 ATR).
  active_zones?: { bottom: number; top: number }[];
  htf_atr?: number;
  // Zone-to-zone swing (owner 2026-08-24): the underlying take-profit = the near edge
  // of the NEXT opposing Daily zone. Read back by the swing exit (zoneOfPosition).
  predictedTarget?: number | null;
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
  const { zones, active, atr, lastBar } = computeZones(bars, opts.zone);
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
      // Carried for SB 15M's live empty-space + first-boundary checks (harmless
      // extra jsonb for the other profiles). "Active" = untapped zones, i.e. what
      // the indicator still draws, plus this setup's own zone.
      active_zones: [
        { bottom: target.zone.bottom, top: target.zone.top },
        ...active
          .filter((z) => z !== target.zone)
          .map((z) => ({ bottom: z.bottom, top: z.top })),
      ],
      htf_atr: Math.round(atr * 10000) / 10000,
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

/** Minimum underlying room (entry -> next opposing zone) for a zone-swing setup. */
export const ZONE_SWING_MIN_MOVE = 10; // dollars

/**
 * Daily Empty-Space Zone-to-Zone Swing (owner 2026-08-24, `zone-zoneswing.txt`).
 * Find a setup where price sits in CLEAN EMPTY SPACE next to a Daily zone, with the
 * NEXT opposing Daily zone at least $10 of underlying away as the target:
 *   Bullish — nearest zone BELOW price is support; tap its TOP edge (facing the empty
 *     space) from above => CALL; TP = near (bottom) edge of the nearest zone ABOVE.
 *   Bearish — nearest zone ABOVE price is resistance; tap its BOTTOM edge from below
 *     => PUT; TP = near (top) edge of the nearest zone BELOW.
 * Empty space is guaranteed by construction (nearest-below/nearest-above neighbours,
 * nothing between). The zone edge facing the empty space is the tap/entry; the near
 * edge of the next opposing zone is `predictedTarget`. Exits are underlying-driven.
 */
export function buildZoneSwingSetups(bars: Bar[], opts: StrategyOptions = DEFAULT_STRATEGY_OPTIONS, limit = 1): ZoneSetup[] {
  const { active, atr, lastBar } = computeZones(bars, opts.zone);
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
  if (active.length < 2) return [empty];
  // Must be in clean empty space — not sitting inside a zone.
  if (active.some((z) => price >= z.bottom && price <= z.top)) return [empty];

  const below = active.filter((z) => z.top < price).sort((a, b) => b.top - a.top); // nearest-below first
  const above = active.filter((z) => z.bottom > price).sort((a, b) => a.bottom - b.bottom); // nearest-above first
  const allZonesJson = active.map((z) => ({ bottom: z.bottom, top: z.top }));

  const cands: { zone: Zone; entry: number; target: number; direction: "call" | "put"; approach: "from_above" | "from_below" }[] = [];
  if (below.length && above.length) {
    // Bullish: support below, target = the zone above.
    const entry = below[0].top;
    const target = above[0].bottom;
    if (target - entry >= ZONE_SWING_MIN_MOVE) cands.push({ zone: below[0], entry, target, direction: "call", approach: "from_above" });
    // Bearish: resistance above, target = the zone below.
    const bEntry = above[0].bottom;
    const bTarget = below[0].top;
    if (bEntry - bTarget >= ZONE_SWING_MIN_MOVE) cands.push({ zone: above[0], entry: bEntry, target: bTarget, direction: "put", approach: "from_below" });
  }
  if (!cands.length) return [empty];

  // Nearest actionable entry first (whichever edge price is closer to taps next).
  cands.sort((a, b) => Math.abs(price - a.entry) - Math.abs(price - b.entry));
  return cands.slice(0, limit).map((c) => ({
    active_zone: { bottom: c.zone.bottom, top: c.zone.top },
    tapped_edge: Math.round(c.entry * 100) / 100,
    trigger_edge: "first_touch",
    approach: c.approach,
    direction: c.direction,
    clear_runway: true, // empty space to the next opposing zone by construction
    tap_granularity: "daily_scan",
    distance_to_edge_pct: Math.round((Math.abs(price - c.entry) / price) * 10000) / 100,
    setup_valid: true,
    price,
    predictedTarget: Math.round(c.target * 100) / 100,
    active_zones: allZonesJson,
    htf_atr: Math.round(atr * 10000) / 10000,
  }));
}

/**
 * Was the entry zone REJECTED on a completed 4H candle within the last 2 trading days?
 * (message (9).txt two-touch confirmation.) CALL/demand: a 4H candle dipped to tap the
 * zone top and CLOSED back ABOVE it. PUT/supply: a 4H candle rose to tap the zone bottom
 * and CLOSED back BELOW it. Returns the confirming candle's timestamp, or null.
 */
function confirmed4hRejection(completed4h: Bar[], zone: Zone, direction: "call" | "put"): string | null {
  if (!completed4h.length) return null;
  const dates = [...new Set(completed4h.map((b) => b.t.slice(0, 10)))].sort();
  const recent2 = new Set(dates.slice(-2)); // confirmation no older than 2 trading days
  const recent = completed4h.filter((b) => recent2.has(b.t.slice(0, 10)));
  for (let i = recent.length - 1; i >= 0; i--) {
    const b = recent[i];
    if (direction === "call") {
      if (b.l <= zone.top && b.c > zone.top) return b.t; // tapped demand top, closed above
    } else {
      if (b.h >= zone.bottom && b.c < zone.bottom) return b.t; // tapped supply bottom, closed below
    }
  }
  return null;
}

/**
 * 4H Empty-Space Zone-to-Zone Swing (owner 2026-09-09, `message (9).txt`). Same 1D /
 * ATR-50 / 1.7 zones as zone_swing, but with a TWO-TOUCH confirmation on 4H candles:
 * the entry zone must have been REJECTED by a completed 4H candle within the last 2
 * trading days (tap + close back through the facing edge). The live retap of that same
 * confirmed zone is the trigger (handled by entryKind "zone_swing_tap"). Target = the
 * next opposing zone through clean empty space; strike ~$2 ITM past it (contract config).
 */
export function buildZoneSwing4hSetups(dailyBars: Bar[], bars4h: Bar[], opts: StrategyOptions = DEFAULT_STRATEGY_OPTIONS, limit = 1): ZoneSetup[] {
  const { active, atr, lastBar } = computeZones(dailyBars, opts.zone);
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
  if (active.length < 2) return [empty];
  if (active.some((z) => price >= z.bottom && price <= z.top)) return [empty]; // price inside a zone
  const completed4h = bars4h.filter((b) => Date.parse(b.t) + 4 * 60 * 60_000 <= Date.now());
  if (!completed4h.length) return [empty];

  const below = active.filter((z) => z.top < price).sort((a, b) => b.top - a.top); // nearest-below first
  const above = active.filter((z) => z.bottom > price).sort((a, b) => a.bottom - b.bottom); // nearest-above first
  const allZonesJson = active.map((z) => ({ bottom: z.bottom, top: z.top }));
  const minMove = Math.max(2, price * 0.02); // meaningful zone-to-zone room (scales with price)

  const cands: { zone: Zone; entry: number; target: number; direction: "call" | "put"; approach: "from_above" | "from_below"; confirmedAt: string }[] = [];
  if (below.length && above.length) {
    // Bullish: nearest demand zone below (entry), nearest supply zone above (target).
    const entryZone = below[0];
    const entry = entryZone.top;
    const target = above[0].bottom;
    const conf = confirmed4hRejection(completed4h, entryZone, "call");
    if (conf && target - entry >= minMove) cands.push({ zone: entryZone, entry, target, direction: "call", approach: "from_above", confirmedAt: conf });
    // Bearish: nearest supply zone above (entry), nearest demand zone below (target).
    const sZone = above[0];
    const sEntry = sZone.bottom;
    const sTarget = below[0].top;
    const sConf = confirmed4hRejection(completed4h, sZone, "put");
    if (sConf && sEntry - sTarget >= minMove) cands.push({ zone: sZone, entry: sEntry, target: sTarget, direction: "put", approach: "from_below", confirmedAt: sConf });
  }
  if (!cands.length) return [empty];

  cands.sort((a, b) => Math.abs(price - a.entry) - Math.abs(price - b.entry));
  return cands.slice(0, limit).map((c) => ({
    active_zone: { bottom: c.zone.bottom, top: c.zone.top },
    tapped_edge: Math.round(c.entry * 100) / 100,
    trigger_edge: "first_touch",
    approach: c.approach,
    direction: c.direction,
    clear_runway: true, // empty space to the next opposing zone by construction
    tap_granularity: "daily_scan",
    distance_to_edge_pct: Math.round((Math.abs(price - c.entry) / price) * 10000) / 100,
    setup_valid: true,
    price,
    predictedTarget: Math.round(c.target * 100) / 100,
    accepted_at: c.confirmedAt, // the confirming 4H rejection candle (two-touch)
    active_zones: allZonesJson,
    htf_atr: Math.round(atr * 10000) / 10000,
  }));
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
