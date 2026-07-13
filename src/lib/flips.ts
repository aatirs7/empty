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

/** Why a broken/accepted zone was NOT promoted to a live flip (funnel audit).
 *  `too_far` is applied downstream in buildFlipSetupsDetailed (distance filter). */
export type FlipRejection = "wick_only" | "closed_back_inside" | "already_retested" | "stale" | "too_far";

/** Human labels for the funnel line in the scan log / daily report. */
export const FLIP_REJECTION_LABELS: Record<FlipRejection, string> = {
  wick_only: "wick-through only (no acceptance)",
  closed_back_inside: "closed back inside the zone",
  already_retested: "first retest already happened",
  stale: ">2 sessions since acceptance",
  too_far: "price too far to retest soon",
};

type FlipCheck = { flip: Flip } | { reason: FlipRejection } | null;

/**
 * Analyze one zone for a flip in the given direction. Returns `{ flip }` for a valid
 * not-yet-first-retested flip, `{ reason }` when the zone broke/wicked but failed an
 * invalidation (funnel audit), or `null` when the zone was never even approached (not
 * a flip candidate). `bars` must be settled daily bars, most recent last.
 */
function analyzeFlip(bars: Bar[], z: Zone, direction: "call" | "put", opts: FlipOptions): FlipCheck {
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
  if (k === -1) {
    // No acceptance close. If price WICKED beyond recently without closing beyond,
    // that's the spec's "wick-through only" rejection; otherwise it never approached.
    const window = opts.maxSessionsSinceFlip + 1;
    const wicked = (b: Bar) => (direction === "call" ? b.h > z.top : b.l < z.bottom);
    for (let i = lastIdx; i >= Math.max(0, lastIdx - window); i--) {
      if (wicked(bars[i]) && !beyond(bars[i].c)) return { reason: "wick_only" };
    }
    return null; // never approached — not a flip candidate
  }

  const sessionsSinceFlip = lastIdx - k;
  if (sessionsSinceFlip > opts.maxSessionsSinceFlip) return { reason: "stale" };

  // Inspect the candles AFTER acceptance for invalidations.
  for (let j = k + 1; j <= lastIdx; j++) {
    if (!beyond(bars[j].c)) return { reason: "closed_back_inside" };
    const tappedBoundary = direction === "call" ? bars[j].l <= z.top : bars[j].h >= z.bottom;
    if (tappedBoundary) return { reason: "already_retested" };
  }

  return { flip: { zone: { bottom: z.bottom, top: z.top }, direction, flippedBoundary: boundary, acceptedAt: bars[k].t, sessionsSinceFlip } };
}

export interface FlipDetection {
  flips: Flip[];
  rejections: Partial<Record<FlipRejection, number>>; // funnel tally (one per zone, most-informative)
}

/**
 * Detect every valid, not-yet-first-retested daily flip across the given zones, and
 * tally WHY the rest were rejected (funnel audit). A single zone can only flip one
 * way at a time, so at most one of {call, put} promotes; the rejection recorded is the
 * most informative of the two directions' checks (at most one per zone).
 */
export function detectFlipsDetailed(bars: Bar[], zones: Zone[], opts: FlipOptions = DEFAULT_FLIP_OPTIONS): FlipDetection {
  const flips: Flip[] = [];
  const rejections: Partial<Record<FlipRejection, number>> = {};
  for (const z of zones) {
    const call = analyzeFlip(bars, z, "call", opts);
    if (call && "flip" in call) {
      flips.push(call.flip);
      continue;
    }
    const put = analyzeFlip(bars, z, "put", opts);
    if (put && "flip" in put) {
      flips.push(put.flip);
      continue;
    }
    // Neither direction is a valid flip; record the most informative rejection reason.
    const r = call && "reason" in call ? call : put && "reason" in put ? put : null;
    if (r) rejections[r.reason] = (rejections[r.reason] ?? 0) + 1;
  }
  return { flips, rejections };
}

/** Thin wrapper — valid flips only (unchanged callers). */
export function detectFlips(bars: Bar[], zones: Zone[], opts: FlipOptions = DEFAULT_FLIP_OPTIONS): Flip[] {
  return detectFlipsDetailed(bars, zones, opts).flips;
}
