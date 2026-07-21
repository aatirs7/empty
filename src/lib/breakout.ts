/**
 * SBv2 — 4H EMPTY-SPACE BREAKOUT & RETEST (Farrukh spec "message (4).txt",
 * 2026-07-21; fully replaces the daily-flip logic).
 *
 * DAILY order-block zones (ATR-50, displacement 1.7×) are the levels; the
 * 4-HOUR chart qualifies everything: a setup exists when a COMPLETED 4h candle
 * closes with its BODY completely outside a daily zone, into valid empty space
 * (no other daily zone immediately ahead), and the FIRST retest of the broken
 * boundary hasn't happened yet. The stored boundary (call: zone top; put: zone
 * bottom) is the entry level — the live monitor buys on the first actual touch.
 *
 * Everything here is pure bar math over SETTLED bars (pass COMPLETED 4h candles
 * only — the caller drops the forming one). No DB, no model, no state table:
 * validity is re-derivable from daily zones + 4h bars alone.
 */
import type { Bar } from "./alpaca";
import type { Zone } from "./zones";

export interface Breakout {
  zone: { bottom: number; top: number };
  direction: "call" | "put"; // call = broke ABOVE (top becomes support); put = broke BELOW
  boundary: number; // the stored retest level
  breakoutAt: string; // the qualifying completed 4h candle's timestamp
  barsSinceBreakout: number; // completed 4h bars since the qualifier
  emptySpacePct: number | null; // boundary -> next daily zone in the breakout direction (% of price); null = unobstructed
  consumedPct: number | null; // how much of that space price has already traveled (0..1); null when unobstructed
}

export type BreakoutRejection =
  | "wick_only" // beyond the boundary by wick, but no body-close outside
  | "closed_back_inside" // a later completed 4h candle closed back inside/through the zone
  | "already_retested" // the first retest already touched the boundary
  | "stale" // breakout too old with no retest
  | "no_empty_space" // another daily zone immediately ahead
  | "space_consumed" // price already traveled most of the available space
  | "too_far"; // unobstructed, but price ran too far to plausibly retest

export const BREAKOUT_REJECTION_LABELS: Record<BreakoutRejection, string> = {
  wick_only: "wick beyond the zone only (no body close outside)",
  closed_back_inside: "4h candle closed back inside the zone",
  already_retested: "first retest already happened",
  stale: "breakout went stale before the retest",
  no_empty_space: "another daily zone immediately ahead (no empty space)",
  space_consumed: "price already traveled most of the empty space",
  too_far: "price ran too far from the boundary",
};

export interface BreakoutOptions {
  staleBars: number; // completed 4h bars a breakout may wait for its retest
  minEmptySpacePct: number; // required room to the next daily zone, % of price
  maxConsumedPct: number; // reject once price has used this fraction of the space
  maxDistancePct: number; // unobstructed fallback: max % from the boundary
}

export const DEFAULT_BREAKOUT_OPTIONS: BreakoutOptions = {
  staleBars: 6, // ~2 sessions of regular-hours 4h candles
  minEmptySpacePct: 2,
  maxConsumedPct: 0.6,
  maxDistancePct: 12, // parity with the old flip distance guard
};

export interface BreakoutDetection {
  breakouts: Breakout[];
  rejections: Partial<Record<BreakoutRejection, number>>;
}

/**
 * Detect live breakout-retest setups from daily zones + COMPLETED 4h bars.
 * `price` is the current reference price (live spot intraday; the last completed
 * 4h close at scan time) — used only for the space-consumed/distance guards.
 *
 * Qualification reading of the spec: "closes completely above/below the zone;
 * the body — not merely the wick — is outside" = the candle's CLOSE is beyond
 * the boundary (a breakout candle normally OPENS inside the zone, so demanding
 * the whole body outside would make the qualifying candle impossible). A poke
 * beyond by high/low with a close back inside is the wick-only rejection.
 */
export function detectBreakoutsDetailed(
  zones: Zone[],
  bars4h: Bar[],
  price: number,
  opts: BreakoutOptions = DEFAULT_BREAKOUT_OPTIONS,
): BreakoutDetection {
  const out: Breakout[] = [];
  const rejections: Partial<Record<BreakoutRejection, number>> = {};
  const reject = (r: BreakoutRejection) => (rejections[r] = (rejections[r] ?? 0) + 1);
  if (bars4h.length === 0) return { breakouts: out, rejections };
  const last = bars4h.length - 1;

  for (const z of zones) {
    // The CURRENT outside-run: the streak of completed 4h candles closing beyond
    // the zone that includes the LAST bar. Its first bar is the qualifying
    // breakout — later outside bars are the same breakout aging, not new ones.
    const lastBar = bars4h[last];
    const direction: "call" | "put" | null = lastBar.c > z.top ? "call" : lastBar.c < z.bottom ? "put" : null;
    if (!direction) {
      // No active breakout. Funnel visibility over the recent window: a run that
      // ended = closed back inside; a poke without any outside close = wick only.
      const recent = bars4h.slice(-opts.staleBars);
      if (recent.some((b) => b.c > z.top || b.c < z.bottom)) reject("closed_back_inside");
      else if (recent.some((b) => b.h > z.top || b.l < z.bottom)) reject("wick_only");
      continue;
    }
    const outside = (b: Bar) => (direction === "call" ? b.c > z.top : b.c < z.bottom);
    let idx = last;
    while (idx > 0 && outside(bars4h[idx - 1])) idx -= 1;

    const boundary = direction === "call" ? z.top : z.bottom;
    // The first retest = any candle AFTER the qualifier whose range already came
    // back to the boundary. If it happened on completed bars, the setup is spent
    // (spec: "each breakout may generate only one trade; after the first retest,
    // retire the setup").
    let retested = false;
    for (let k = idx + 1; k <= last; k++) {
      const b = bars4h[k];
      if (direction === "call" ? b.l <= boundary : b.h >= boundary) {
        retested = true;
        break;
      }
    }
    if (retested) {
      reject("already_retested");
      continue;
    }
    const barsSince = last - idx;
    if (barsSince > opts.staleBars) {
      reject("stale");
      continue;
    }

    // Empty space: the nearest OTHER daily zone strictly beyond the boundary in
    // the breakout direction is the obstacle ("the black area between zones").
    let obstacle: number | null = null;
    for (const other of zones) {
      if (other === z) continue;
      if (direction === "call" && other.bottom > z.top) {
        obstacle = obstacle == null ? other.bottom : Math.min(obstacle, other.bottom);
      } else if (direction === "put" && other.top < z.bottom) {
        obstacle = obstacle == null ? other.top : Math.max(obstacle, other.top);
      }
    }
    let emptySpacePct: number | null = null;
    let consumedPct: number | null = null;
    if (obstacle != null) {
      const space = Math.abs(obstacle - boundary);
      emptySpacePct = Math.round((space / price) * 10000) / 100;
      if (emptySpacePct < opts.minEmptySpacePct) {
        reject("no_empty_space");
        continue;
      }
      const traveled = direction === "call" ? price - boundary : boundary - price;
      consumedPct = Math.round(Math.max(0, traveled / space) * 100) / 100;
      if (consumedPct > opts.maxConsumedPct) {
        reject("space_consumed");
        continue;
      }
    } else {
      // Unobstructed: keep the plain distance guard so a runaway move isn't "watched".
      const distPct = (Math.abs(price - boundary) / price) * 100;
      if (distPct > opts.maxDistancePct) {
        reject("too_far");
        continue;
      }
    }

    out.push({
      zone: { bottom: z.bottom, top: z.top },
      direction,
      boundary: Math.round(boundary * 100) / 100,
      breakoutAt: bars4h[idx].t,
      barsSinceBreakout: barsSince,
      emptySpacePct,
      consumedPct,
    });
  }
  // Nearest-to-price first (the monitor watches the most plausible retests).
  out.sort((a, b) => Math.abs(price - a.boundary) - Math.abs(price - b.boundary));
  return { breakouts: out, rejections };
}
