/**
 * Daily order-block FLIP detection (SBv2, sniperbot-daily-swing-v2.md). PAPER/analysis.
 *
 * A "flip" is a daily zone that price BROKE and ACCEPTED through (a completed daily
 * close beyond the ENTIRE zone, which also captures the overnight-gap-and-hold case),
 * so the zone reverses role:
 *   - broke + accepted ABOVE a zone → the TOP becomes support → first tap of the TOP = CALL
 *   - broke + accepted BELOW a zone → the BOTTOM becomes resistance → first tap of the BOTTOM = PUT
 *
 * We only return flips that are still awaiting their FIRST retest and are NOT invalid:
 *   - never accepted (only wicked through)              → no acceptance candle, dropped
 *   - a later daily candle CLOSED back inside the zone  → flip failed, dropped
 *   - the first retest already printed on a daily bar   → we missed the live entry, dropped
 *   - > maxSessionsSinceFlip completed sessions old     → stale, dropped
 *
 * Every check is derivable from the settled daily bars, so no persistent flip-state
 * table is needed — the scan re-derives the whole watchlist each day.
 *
 * GUARDRAIL: all code-computed. The model never produces a boundary or direction.
 */
import type { Bar } from "./alpaca";
import type { Zone } from "./zones";

export interface Flip {
  zone: { bottom: number; top: number };
  direction: "call" | "put";
  /** The flipped boundary price to watch for the first retest (top for a call, bottom for a put). */
  flippedBoundary: number;
  acceptedAt: string; // timestamp of the acceptance (break-and-close) daily candle
  sessionsSinceFlip: number; // completed daily candles since acceptance (0 = accepted on the last close)
}

export interface FlipOptions {
  maxSessionsSinceFlip: number; // spec: > 2 sessions since confirmation invalidates
}

export const DEFAULT_FLIP_OPTIONS: FlipOptions = { maxSessionsSinceFlip: 2 };

/**
 * Analyze one zone for a flip in the given direction. Returns the Flip if a valid,
 * not-yet-first-retested flip exists, else null. `bars` must be settled daily bars,
 * most recent last (exclude any in-progress candle before calling for a live re-check).
 */
function analyzeFlip(bars: Bar[], z: Zone, direction: "call" | "put", opts: FlipOptions): Flip | null {
  const lastIdx = bars.length - 1;
  const boundary = direction === "call" ? z.top : z.bottom;
  // "beyond" = accepted on the correct side of the WHOLE zone.
  const beyond = (c: number) => (direction === "call" ? c > z.top : c < z.bottom);

  // Most recent acceptance candle: it closes beyond while the prior close was not
  // beyond (the break that established current acceptance).
  let k = -1;
  for (let i = lastIdx; i >= 1; i--) {
    if (beyond(bars[i].c) && !beyond(bars[i - 1].c)) {
      k = i;
      break;
    }
  }
  if (k === -1) return null; // never accepted (only wicked, or no break) → not a flip

  const sessionsSinceFlip = lastIdx - k;
  if (sessionsSinceFlip > opts.maxSessionsSinceFlip) return null; // stale

  // Inspect the candles AFTER acceptance for invalidations.
  for (let j = k + 1; j <= lastIdx; j++) {
    // Closed back inside/through the zone against the flip → flip failed.
    if (!beyond(bars[j].c)) return null;
    // First retest already happened on a completed daily bar → we missed the live entry.
    const tappedBoundary = direction === "call" ? bars[j].l <= z.top : bars[j].h >= z.bottom;
    if (tappedBoundary) return null;
  }

  return { zone: { bottom: z.bottom, top: z.top }, direction, flippedBoundary: boundary, acceptedAt: bars[k].t, sessionsSinceFlip };
}

/**
 * Detect every valid, not-yet-first-retested daily flip across the given zones.
 * A single zone can only flip one way at a time (price is on one side), so at most
 * one of {call, put} returns for each zone.
 */
export function detectFlips(bars: Bar[], zones: Zone[], opts: FlipOptions = DEFAULT_FLIP_OPTIONS): Flip[] {
  const flips: Flip[] = [];
  for (const z of zones) {
    const call = analyzeFlip(bars, z, "call", opts);
    if (call) {
      flips.push(call);
      continue;
    }
    const put = analyzeFlip(bars, z, "put", opts);
    if (put) flips.push(put);
  }
  return flips;
}
