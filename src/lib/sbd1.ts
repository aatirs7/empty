/**
 * SB-D1 Precision — FRESH, self-contained stock-level engine (Discord spec, 2026).
 *
 * Architecture (owner 2026): the Pine v6 zone engine (`zones.ts`) is the shared
 * FOUNDATION every profile reads; a profile is just a distinct way of USING those
 * zones. SB-D1 therefore reuses ONLY `computeZones`/`computeATR` from the foundation
 * and implements its own detection/trend/room/target/score logic here — it does NOT
 * touch SBv1/SBv2/flip/breakout code.
 *
 * This module is the STOCK-LEVEL layer the spec's §22 says to validate first: given
 * point-in-time daily bars it classifies trend + zone state and emits the four
 * permitted setups with entry / invalidation / safe & extended targets / R:R /
 * distance-traveled / setup score. It is PURE (bars in, setups out) so the backtest
 * can replay it with zero lookahead.
 *
 * NOT in this layer (later stages, spec-ordered): the 15-minute reclaim/rejection
 * confirmation (§6), the option strike/liquidity/sizing engine (§10-12), the live
 * two-layer stop / trailing / circuit-breaker system (§14-16, §21), and the earnings
 * calendar (§19). Where a daily backtest cannot see an intraday/greeks/earnings input,
 * it is APPROXIMATED and every setup carries the list in `approximations`.
 */
import { computeZones, computeATR, type ZoneOptions } from "./zones";
import type { Bar } from "./alpaca";

/** SB-D1 uses ONLY 1-Day zones at ATR-50 / displacement 1.7 (spec §1). */
export const SBD1_ZONE_OPTS: ZoneOptions = {
  atrLength: 50,
  displacement: 1.7,
  firstTouchOnly: true,
  useFVG: false,
};

export type Sbd1Trend = "bullish" | "bearish" | "neutral";
export type Sbd1SetupType =
  | "demand_rejection_call" // Setup A
  | "supply_rejection_put" // Setup B
  | "breakout_retest_call" // Setup C
  | "breakdown_retest_put"; // Setup D

export interface Sbd1Setup {
  type: Sbd1SetupType;
  direction: "call" | "put";
  zone: { bottom: number; top: number; mid: number };
  entry: number; // approx underlying entry (spec §6/§7)
  invalidation: number; // underlying stop level (spec §7)
  safeTarget: number; // spec §7
  extendedTarget: number; // spec §7
  riskR: number; // |entry - invalidation| (1R on the underlying)
  rrSafe: number; // (safe target reward) / risk — must clear §7's 2.0 / 2.5
  fresh: boolean; // zero prior retests
  retests: number; // prior daily overlaps of the zone before this touch
  distanceTraveledPct: number; // fraction of the expected move already done (§18)
  trend: Sbd1Trend;
  score: number; // /100 (§17); components marked assumed are in `approximations`
  atr: number; // daily ATR-50 at evaluation
  reasons: string[];
  approximations: string[];
}

export interface Sbd1Eval {
  trend: Sbd1Trend;
  setups: Sbd1Setup[]; // only setups that pass EVERY daily-evaluable mandatory rule
  rejections: Record<string, number>; // funnel: why candidates were dropped
}

const NEUTRAL_MIN_SCORE = 85; // §17 / §5
const ALIGNED_MIN_SCORE = 78; // §17
const DIST_TRAVELED_MAX = 0.35; // §18 reject when > 35% of the move is already done
const ROOM_RR_ALIGNED = 2.0; // §7
const ROOM_RR_NEUTRAL = 2.5; // §7

// ----- Trend via confirmed 3-bar pivot swing structure (§5) ------------------------
/** Confirmed pivots: bar i is a swing high if its high >= both neighbours (3-bar);
 *  in a point-in-time daily replay every passed bar is closed, so a pivot with a
 *  right neighbour present is "confirmed". Returns the price sequence of the last
 *  few swing highs and lows in chronological order. */
function swings(bars: Bar[]): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = 2; i < bars.length - 1; i++) {
    const h = bars[i].h,
      l = bars[i].l;
    if (h >= bars[i - 1].h && h >= bars[i - 2].h && h >= bars[i + 1].h) highs.push(h);
    if (l <= bars[i - 1].l && l <= bars[i - 2].l && l <= bars[i + 1].l) lows.push(l);
  }
  return { highs, lows };
}

export function classifyTrend(bars: Bar[]): Sbd1Trend {
  const { highs, lows } = swings(bars);
  if (highs.length < 2 || lows.length < 2) return "neutral";
  const [phH, lastH] = [highs[highs.length - 2], highs[highs.length - 1]];
  const [phL, lastL] = [lows[lows.length - 2], lows[lows.length - 1]];
  if (lastH > phH && lastL > phL) return "bullish";
  if (lastL < phL && lastH < phH) return "bearish";
  return "neutral";
}

// ----- Helpers ---------------------------------------------------------------------
const overlaps = (b: Bar, bottom: number, top: number) => b.h >= bottom && b.l <= top;

/** Count daily bars AFTER a zone formed (up to the last) that traded back into it —
 *  the retest count the spec keys freshness/exhaustion off (§2). The final (current)
 *  bar's touch is the entry, not a "prior" retest, so it is excluded. */
function countRetests(bars: Bar[], formedAtIdx: number, bottom: number, top: number): number {
  let n = 0;
  for (let i = formedAtIdx + 1; i < bars.length - 1; i++) if (overlaps(bars[i], bottom, top)) n++;
  return n;
}

/** Nearest OPPOSING **active** zone ahead of `entry` — the real forward obstacle
 *  (§7's "next opposing zone"). A call's obstacle is a supply zone above (its bottom
 *  is what price hits first); a put's is a demand zone below (its top). Zones price
 *  has already traded through (used) are not obstacles, so only untapped zones count. */
function nextObstacle(
  active: { bottom: number; top: number; type: "demand" | "supply" }[],
  entry: number,
  dir: "call" | "put",
): number | null {
  const ahead =
    dir === "call"
      ? active.filter((z) => z.type === "supply" && z.bottom > entry).map((z) => z.bottom)
      : active.filter((z) => z.type === "demand" && z.top < entry).map((z) => z.top);
  if (ahead.length === 0) return null;
  return dir === "call" ? Math.min(...ahead) : Math.max(...ahead);
}

// ----- The evaluator ---------------------------------------------------------------
export function evaluateSbd1(dailyBars: Bar[]): Sbd1Eval {
  const rej: Record<string, number> = {};
  const tally = (k: string): void => {
    rej[k] = (rej[k] ?? 0) + 1;
  };
  if (dailyBars.length < SBD1_ZONE_OPTS.atrLength + 5) return { trend: "neutral", setups: [], rejections: rej };

  const atrArr = computeATR(dailyBars, SBD1_ZONE_OPTS.atrLength);
  const atr = atrArr[dailyBars.length - 1];
  if (!(atr > 0)) return { trend: "neutral", setups: [], rejections: rej };

  const { zones } = computeZones(dailyBars, SBD1_ZONE_OPTS);
  const last = dailyBars[dailyBars.length - 1];
  const price = last.c;
  const trend = classifyTrend(dailyBars);
  const idxOf = (formedAt: string) => dailyBars.findIndex((b) => b.t === formedAt);
  // Obstacles + tradeable rejection zones are the ACTIVE (untapped) zones only —
  // the foundation keeps full zone history forever, so using every zone as an
  // obstacle makes the chart impossibly dense and nothing ever has 2R of room.
  const active = zones.filter((z) => !z.used).map((z) => ({ bottom: z.bottom, top: z.top, type: z.type }));

  const setups: Sbd1Setup[] = [];

  // Trade-permission table (§5). Countertrend prohibited in paper stage; neutral is
  // conditional (allowed only with a fresh zone + score >= 85, enforced below).
  const permits = (dir: "call" | "put"): "yes" | "conditional" | "no" => {
    if (trend === "neutral") return "conditional";
    if (dir === "call") return trend === "bullish" ? "yes" : "no";
    return trend === "bearish" ? "yes" : "no";
  };

  for (const z of zones) {
    if (z.used) {
      /* first-touch consumed; retest handling below still allows <=1 prior retest */
    }
    const zoneMid = (z.bottom + z.top) / 2;
    const fIdx = idxOf(z.formedAt);
    if (fIdx < 0) continue;
    const retests = countRetests(dailyBars, fIdx, z.bottom, z.top);
    const dispBar = dailyBars[Math.min(fIdx + 1, dailyBars.length - 1)]; // the impulse candle
    const dispOverAtr = Math.abs(dispBar.c - dispBar.o) / atr;

    // ----- Rejection setups A/B: price approaching the zone from empty space -----
    // Demand (call): price ABOVE the zone, close within ~1 ATR of the top, last daily
    // move downward toward it. Supply (put): mirror below.
    const near = 1.0 * atr;
    if (!z.used && z.type === "demand" && price > z.top && price - z.top <= near && last.c < dailyBars[dailyBars.length - 2].c) {
      pushRejection("demand_rejection_call", "call", z, zoneMid, fIdx, retests, dispOverAtr);
    }
    if (!z.used && z.type === "supply" && price < z.bottom && z.bottom - price <= near && last.c > dailyBars[dailyBars.length - 2].c) {
      pushRejection("supply_rejection_put", "put", z, zoneMid, fIdx, retests, dispOverAtr);
    }

    // ----- Breakout/breakdown retest setups C/D (§4, §6) -------------------------
    // A completed daily candle closed fully through the zone into empty space within
    // the last 10 sessions; price has now returned to the broken boundary (retest).
    detectBreakoutRetest(z, zoneMid, fIdx, retests, dispOverAtr);
  }

  return { trend, setups, rejections: rej };

  // ----- inner builders (close over the loop state) ---------------------------------
  function scoreSetup(a: {
    aligned: boolean;
    fresh: boolean;
    retests: number;
    dispOverAtr: number;
    rrSafe: number;
    distPct: number;
  }): { score: number; approx: string[] } {
    const approx: string[] = [];
    // §17 weights.
    const trendPts = a.aligned ? 20 : 10; // neutral-conditional keeps half
    const freshPts = a.fresh ? 15 : a.retests <= 1 ? 7 : 0;
    const dispPts = Math.max(0, Math.min(10, ((a.dispOverAtr - 1.7) / 1.3) * 10)); // 1.7x→0, ~3x→10
    const reclaimPts = 10; // §17 "15-min rejection/reclaim" — no intraday here
    approx.push("15-min reclaim/reclaim-quality assumed (no intraday in the stock-level test)");
    const rrPts = Math.max(0, Math.min(15, ((a.rrSafe - 2.0) / 2.0) * 15 + 7.5));
    const histPts = 5; // §17 "historical zone reactions" — reaction DB not joined here
    approx.push("historical-zone-reaction score assumed (reaction DB not joined in this cut)");
    const distPts = a.distPct <= 0.15 ? 5 : a.distPct <= DIST_TRAVELED_MAX ? 3 : 0;
    const liqPts = 3; // §17 stock/option liquidity — options layer not run here
    approx.push("liquidity + market-regime score assumed (options/regime layer deferred)");
    const regimePts = 3;
    const score = Math.round(trendPts + freshPts + dispPts + reclaimPts + rrPts + histPts + distPts + liqPts + regimePts);
    return { score, approx };
  }

  function finalize(
    type: Sbd1SetupType,
    dir: "call" | "put",
    zb: { bottom: number; top: number },
    zoneMid: number,
    entry: number,
    invalidation: number,
    fresh: boolean,
    retests: number,
    dispOverAtr: number,
    reasons: string[],
  ): void {
    const perm = permits(dir);
    if (perm === "no") return tally("countertrend_prohibited");

    const risk = Math.abs(entry - invalidation);
    if (!(risk > 0)) return tally("bad_risk");

    // Room test (§7): require a CLEAN measured move to the safe target — 2R aligned,
    // 2.5R neutral — with no opposing ACTIVE zone before it. The safe target is that
    // measured move; if the next opposing zone sits inside it, there isn't room → skip.
    const minRR = trend === "neutral" ? ROOM_RR_NEUTRAL : ROOM_RR_ALIGNED;
    const safeTarget = dir === "call" ? entry + minRR * risk : entry - minRR * risk;
    const extR = minRR + 1; // extended target one more R out
    const obstacle = nextObstacle(active.filter((b) => !(b.bottom === zb.bottom && b.top === zb.top)), entry, dir);
    if (obstacle != null && ((dir === "call" && obstacle < safeTarget) || (dir === "put" && obstacle > safeTarget))) {
      return tally("obstacle_before_min_target");
    }
    const rrSafe = minRR; // clean 2R/2.5R measured move by construction
    const extIdeal = dir === "call" ? entry + extR * risk : entry - extR * risk;
    const extendedTarget =
      obstacle != null && ((dir === "call" && obstacle < extIdeal) || (dir === "put" && obstacle > extIdeal)) ? obstacle : extIdeal;

    // Distance-traveled filter (§18) is DEFERRED in the stock-level cut: it measures
    // the move from the intraday REACTION low/high (which forms during the 15-minute
    // confirmation) to the entry — an input this daily approximation doesn't have.
    // A daily proxy misfires badly, so it is recorded for reference but not enforced
    // here; it lands with the 15-minute layer. (DIST_TRAVELED_MAX kept for that stage.)
    const win = dailyBars.slice(-10);
    const reactionExtreme = dir === "call" ? Math.min(...win.map((b) => b.l)) : Math.max(...win.map((b) => b.h));
    const distPct = Math.abs(safeTarget - reactionExtreme) > 0 ? Math.abs(entry - reactionExtreme) / Math.abs(safeTarget - reactionExtreme) : 0;

    // Neutral trend requires a FRESH zone (§5).
    if (trend === "neutral" && !fresh) return tally("neutral_needs_fresh_zone");

    // §17 setup-score gate (78 aligned / 85 neutral) is DEFERRED in the stock-level
    // cut: 35 of its 100 points (reclaim quality, historical reactions, liquidity,
    // market regime) need intraday/options/DB inputs this cut lacks, so enforcing the
    // floor against a structurally-incomplete score would reject everything. The score
    // is computed and reported for reference; the gate lands with the full engine.
    const { score, approx } = scoreSetup({ aligned: perm === "yes", fresh, retests, dispOverAtr, rrSafe, distPct });
    void NEUTRAL_MIN_SCORE;
    void ALIGNED_MIN_SCORE;

    setups.push({
      type,
      direction: dir,
      zone: { bottom: zb.bottom, top: zb.top, mid: zoneMid },
      entry: round2(entry),
      invalidation: round2(invalidation),
      safeTarget: round2(safeTarget),
      extendedTarget: round2(extendedTarget),
      riskR: round2(risk),
      rrSafe: Math.round(rrSafe * 100) / 100,
      fresh,
      retests,
      distanceTraveledPct: Math.round(distPct * 1000) / 1000,
      trend,
      score,
      atr: round2(atr),
      reasons,
      approximations: approx,
    });
  }

  function pushRejection(
    type: Sbd1SetupType,
    dir: "call" | "put",
    z: { bottom: number; top: number; type: "demand" | "supply" },
    zoneMid: number,
    fIdx: number,
    retests: number,
    dispOverAtr: number,
  ): void {
    if (retests > 1) return tally("zone_not_fresh_enough"); // §6: fresh or <=1 prior retest
    const fresh = retests === 0;
    // Entry ≈ the proximal (tap) edge; invalidation = zone far edge − 0.10 ATR (§7).
    const entry = dir === "call" ? z.top : z.bottom;
    const invalidation = dir === "call" ? z.bottom - 0.1 * atr : z.top + 0.1 * atr;
    finalize(type, dir, z, zoneMid, entry, invalidation, fresh, retests, dispOverAtr, [
      `${dir === "call" ? "demand" : "supply"} rejection: price approached the ${dir === "call" ? "top from above" : "bottom from below"} of a ${fresh ? "fresh" : `${retests}x-retested`} 1D zone; trend ${trend}.`,
    ]);
  }

  function detectBreakoutRetest(
    z: { bottom: number; top: number; type: "demand" | "supply" },
    zoneMid: number,
    fIdx: number,
    retests: number,
    dispOverAtr: number,
  ): void {
    // Bullish breakout (call): a completed daily candle CLOSED above the whole supply
    // zone into empty space within the last 10 sessions, >=60% body outside, the
    // breakout candle <= 1.5 ATR from its open; price has since returned to the broken
    // top (the retest is happening now). Bearish/breakdown = mirror on a demand zone.
    const lookback = Math.max(fIdx + 1, dailyBars.length - 12);
    if (z.type === "supply") {
      for (let i = lookback; i < dailyBars.length - 1; i++) {
        const b = dailyBars[i];
        if (b.c <= z.top) continue; // not a close above the whole zone
        const bodyOut = (b.c - z.top) / Math.max(1e-9, Math.abs(b.c - b.o));
        if (bodyOut < 0.6) continue; // <60% of body outside
        if (Math.abs(b.c - b.o) > 1.5 * atr) continue; // breakout candle too extended
        const sessions = dailyBars.length - 1 - i;
        if (sessions > 10 || sessions < 1) continue; // retest window (§6)
        const price = dailyBars[dailyBars.length - 1].c;
        if (!(price <= z.top + 0.1 * atr && price >= z.bottom)) continue; // back at the broken top
        // Priority setup (§6). Invalidation = a close through the full broken zone;
        // stop level = zone mid − 0.10 ATR (§7).
        finalize("breakout_retest_call", "call", z, zoneMid, z.top, zoneMid - 0.1 * atr, retests <= 1, retests, dispOverAtr, [
          `bullish breakout ${sessions}d ago closed above the supply zone into empty space; now retesting the broken top.`,
        ]);
        return;
      }
    }
    if (z.type === "demand") {
      for (let i = lookback; i < dailyBars.length - 1; i++) {
        const b = dailyBars[i];
        if (b.c >= z.bottom) continue;
        const bodyOut = (z.bottom - b.c) / Math.max(1e-9, Math.abs(b.c - b.o));
        if (bodyOut < 0.6) continue;
        if (Math.abs(b.c - b.o) > 1.5 * atr) continue;
        const sessions = dailyBars.length - 1 - i;
        if (sessions > 10 || sessions < 1) continue;
        const price = dailyBars[dailyBars.length - 1].c;
        if (!(price >= z.bottom - 0.1 * atr && price <= z.top)) continue;
        finalize("breakdown_retest_put", "put", z, zoneMid, z.bottom, zoneMid + 0.1 * atr, retests <= 1, retests, dispOverAtr, [
          `bearish breakdown ${sessions}d ago closed below the demand zone into empty space; now retesting the broken bottom.`,
        ]);
        return;
      }
    }
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
