/**
 * Walk-forward outcome recorder (Stage 1). Given a signal (entry, direction,
 * target, zone) and the FORWARD daily bars, records what actually happened —
 * independent of any exit rule, so results aren't a function of exit tuning.
 *
 * Rules mirror the live system exactly:
 * - Invalidation = a daily CLOSE back through the zone (call: close < zone.bottom;
 *   put: close > zone.top) — same as monitor.ts swing invalidation.
 * - Target touch = the bar's high/low reaching the target in trade direction.
 * - TIE RULE: target touch and invalidation in the SAME daily bar → invalidation
 *   wins (conservative). `tie` is recorded so the report can state how often the
 *   rule mattered.
 * - MFE/MAE use the identical math as computeReactions (high/low vs entry).
 */
import type { Bar } from "../alpaca";

export interface SignalOutcome {
  targetHit: boolean; // target reached BEFORE invalidation (tie → false)
  targetTouched: boolean; // target reached at ANY point in the window (vs-random comparison)
  barsToTarget: number | null;
  invalidated: boolean;
  invalidatedAtBar: number | null;
  invalidatedFirst: boolean;
  tie: boolean;
  mfePct: number;
  maePct: number;
  ret1d: number | null;
  ret2d: number | null;
  ret3d: number | null;
  ret5d: number | null;
  ret10d: number | null;
  forwardBars: number;
  outcomeStatus: "complete" | "truncated";
}

export const DEFAULT_HORIZON = 15; // forward trading days measured per signal

export function walkForward(
  entry: number,
  direction: "call" | "put",
  target: number | null,
  zone: { bottom: number; top: number },
  forward: Bar[],
  horizon = DEFAULT_HORIZON,
): SignalOutcome {
  const bars = forward.slice(0, horizon);
  const retAt = (d: number): number | null =>
    bars.length >= d ? Math.round(((bars[d - 1].c - entry) / entry) * 1e6) / 1e6 : null;

  let targetHit = false;
  let targetTouched = false;
  let barsToTarget: number | null = null;
  let invalidated = false;
  let invalidatedAtBar: number | null = null;
  let tie = false;
  let mfe = 0;
  let mae = 0;
  let settled = false; // target-vs-invalidation race decided (MFE/MAE keep accruing)

  for (let d = 1; d <= bars.length; d++) {
    const b = bars[d - 1];
    const fav = direction === "call" ? (b.h - entry) / entry : (entry - b.l) / entry;
    const adv = direction === "call" ? (b.l - entry) / entry : (entry - b.h) / entry;
    if (fav > mfe) mfe = fav;
    if (adv < mae) mae = adv;

    const touchedToday = target != null && (direction === "call" ? b.h >= target : b.l <= target);
    const invalidatedToday = direction === "call" ? b.c < zone.bottom : b.c > zone.top;
    if (touchedToday) targetTouched = true;

    if (!settled) {
      if (touchedToday && invalidatedToday) {
        // Both in one daily bar — order within the day is unknowable at daily
        // granularity. Conservative: the invalidation wins.
        tie = true;
        invalidated = true;
        invalidatedAtBar = d;
        settled = true;
      } else if (touchedToday) {
        targetHit = true;
        barsToTarget = d;
        settled = true;
      } else if (invalidatedToday) {
        invalidated = true;
        invalidatedAtBar = d;
        settled = true;
      }
    }
  }

  return {
    targetHit,
    targetTouched,
    barsToTarget,
    invalidated,
    invalidatedAtBar,
    invalidatedFirst: invalidated && !targetHit,
    tie,
    mfePct: Math.round(mfe * 1e6) / 1e6,
    maePct: Math.round(mae * 1e6) / 1e6,
    ret1d: retAt(1),
    ret2d: retAt(2),
    ret3d: retAt(3),
    ret5d: retAt(5),
    ret10d: retAt(10),
    forwardBars: bars.length,
    outcomeStatus: bars.length >= horizon ? "complete" : "truncated",
  };
}
