/**
 * Historical Reaction Database. Replays historical bars and records EVERY zone
 * tap's outcome (approach, edge, rejected/continued, MFE/MAE, move, time, ATR/vol
 * expansion, pattern, fingerprint). `queryReactions` matches a live setup to
 * similar prior reactions and returns hit rate / expected move / targets WITH a
 * sample size and a minimum-sample honesty gate. All code-computed from real bars.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { reactions, type ReactionRow } from "../db/schema";
import { computeZones, type ZoneOptions, DEFAULT_ZONE_OPTIONS } from "./zones";
import type { Bar } from "./alpaca";

const MIN_SAMPLE = 20;

interface TfTuning {
  hold: number; // forward bars to measure the reaction over
  respect: number; // favorable move that counts as "respected" (fraction)
}
function tuning(timeframe: string): TfTuning {
  switch (timeframe) {
    case "15min":
      return { hold: 8, respect: 0.003 }; // ~2h forward; small intraday moves
    case "1h":
      return { hold: 7, respect: 0.005 }; // ~1 session forward
    case "4h":
      return { hold: 12, respect: 0.012 };
    default:
      return { hold: 10, respect: 0.02 }; // daily
  }
}

const overlaps = (b: Bar, bottom: number, top: number) => b.h >= bottom && b.l <= top;

/** Safe numeric string for a DB numeric column (0 if not finite). */
const num = (x: number, dp = 4): string => String(Number.isFinite(x) ? Math.round(x * 10 ** dp) / 10 ** dp : 0);
const validDate = (t: string): boolean => !Number.isNaN(new Date(t).getTime());

/** Minimal pattern label (mirrors playbook.classifyPlaybook, kept local). */
function patternLabel(recentCloses: number[], zone: { bottom: number; top: number }, direction: "call" | "put"): string {
  const last = recentCloses[recentCloses.length - 1];
  const anyBelow = recentCloses.some((c) => c < zone.bottom);
  const anyAbove = recentCloses.some((c) => c > zone.top);
  if (direction === "call") {
    if (anyBelow && last > zone.top) return "Support Reclaim";
    if (recentCloses.some((c) => c <= zone.top) && last > zone.top) return "Support Retest";
    return "Support Bounce";
  }
  if (anyAbove && last < zone.bottom) return "Breakout Rejection";
  if (recentCloses.some((c) => c >= zone.bottom) && last < zone.bottom) return "Resistance Retest";
  return "Resistance Rejection";
}

/** Replay bars and produce one reaction record per tap event (entry into a zone). */
export function computeReactions(symbol: string, bars: Bar[], timeframe: string, opts: ZoneOptions = DEFAULT_ZONE_OPTIONS): (typeof reactions.$inferInsert)[] {
  if (bars.length < opts.atrLength + 20) return [];
  const { hold, respect } = tuning(timeframe);
  // All zones without first-touch consumption, so every tap is a data point.
  const { zones } = computeZones(bars, { ...opts, firstTouchOnly: false });
  const timeIndex = new Map(bars.map((b, i) => [b.t, i]));
  const out: (typeof reactions.$inferInsert)[] = [];

  for (const zone of zones) {
    const formIdx = timeIndex.get(zone.formedAt);
    if (formIdx == null) continue;
    let wasInside = false;
    for (let t = formIdx + 2; t < bars.length - hold; t++) {
      const inside = overlaps(bars[t], zone.bottom, zone.top);
      const entryEvent = inside && !wasInside; // a fresh tap (entered from outside)
      wasInside = inside;
      if (!entryEvent) continue;

      const prevClose = bars[t - 1].c;
      const approach = prevClose > zone.top ? "from_above" : prevClose < zone.bottom ? "from_below" : null;
      if (!approach) continue; // ambiguous (already inside) — skip
      const direction: "call" | "put" = approach === "from_above" ? "call" : "put";
      const tappedEdge = approach === "from_above" ? "top" : "bottom";
      const entry = bars[t].c;
      if (entry <= 0 || !validDate(zone.formedAt) || !validDate(bars[t].t)) continue;

      // MFE (favorable) + MAE (adverse) over the forward window, in trade direction.
      let mfe = 0;
      let mae = 0;
      let barsToPeak = 0;
      for (let d = 1; d <= hold && t + d < bars.length; d++) {
        const b = bars[t + d];
        const fav = direction === "call" ? (b.h - entry) / entry : (entry - b.l) / entry;
        const adv = direction === "call" ? (b.l - entry) / entry : (entry - b.h) / entry;
        if (fav > mfe) {
          mfe = fav;
          barsToPeak = d;
        }
        if (adv < mae) mae = adv;
      }
      const respected = mfe >= respect;

      // ATR / volume expansion at the tap (vs the prior 20 bars).
      const win = bars.slice(Math.max(0, t - 20), t);
      const avgRange = win.length ? win.reduce((s, b) => s + (b.h - b.l), 0) / win.length : 0;
      const avgVol = win.length ? win.reduce((s, b) => s + b.v, 0) / win.length : 0;
      const atrExpansion = avgRange > 0 ? (bars[t].h - bars[t].l) / avgRange : 1;
      const volExpansion = avgVol > 0 ? bars[t].v / avgVol : 1;

      const pattern = patternLabel(bars.slice(Math.max(0, t - 9), t + 1).map((b) => b.c), zone, direction);

      out.push({
        symbol,
        timeframe,
        zoneType: zone.type,
        zoneBottom: num(zone.bottom),
        zoneTop: num(zone.top),
        approach,
        tappedEdge,
        direction,
        formedAt: new Date(zone.formedAt),
        tappedAt: new Date(bars[t].t),
        outcome: respected ? "rejected" : "continued",
        entryPrice: num(entry),
        mfePct: num(mfe, 6),
        maePct: num(mae, 6),
        movePts: num(mfe * entry, 2),
        movePct: num(mfe, 6),
        barsToPeak,
        atrExpansion: num(atrExpansion, 2),
        volExpansion: num(volExpansion, 2),
        pattern,
        fingerprint: { approach, zoneType: zone.type ?? "", pattern, timeframe },
        source: "backfill",
      });
    }
  }
  return out;
}

/** Backfill: replace a symbol/timeframe's backfilled reactions with a fresh replay. */
export async function backfillReactions(symbol: string, bars: Bar[], timeframe: string, opts?: ZoneOptions): Promise<number> {
  const rows = computeReactions(symbol, bars, timeframe, opts);
  await db.delete(reactions).where(and(eq(reactions.symbol, symbol), eq(reactions.timeframe, timeframe), eq(reactions.source, "backfill")));
  // chunked insert (avoid oversized statements)
  for (let i = 0; i < rows.length; i += 500) await db.insert(reactions).values(rows.slice(i, i + 500));
  return rows.length;
}

export interface ReactionQuery {
  symbol: string;
  timeframe: string;
  direction: "call" | "put";
  approach: string; // from_above | from_below
  pattern?: string;
  spot: number;
}

export interface ReactionStats {
  n: number;
  hitRate: number; // fraction that respected (fade worked)
  avgMovePct: number;
  avgMovePts: number;
  avgBarsToPeak: number;
  avgMaePct: number;
  continuationRate: number; // broke through (fade failed)
  safeTarget: number | null; // spot ± p25 MFE
  mainTarget: number | null; // spot ± median MFE
  stretchTarget: number | null; // spot ± p75 MFE
  expectedHold: number; // bars
  lowConfidence: boolean; // below the min-sample threshold
  bucket: string; // which widening tier matched
}

const pctile = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

/** Match a live setup to similar prior reactions, widening the bucket until it has
 *  enough sample. Always returns the sample size + a low-confidence flag. */
export async function queryReactions(q: ReactionQuery): Promise<ReactionStats> {
  const base = [eq(reactions.timeframe, q.timeframe), eq(reactions.approach, q.approach)];
  // Tier 1: symbol + approach + pattern. Tier 2: symbol + approach. Tier 3: approach (all symbols).
  const tiers: { where: ReturnType<typeof and>; label: string }[] = [
    { where: and(eq(reactions.symbol, q.symbol), ...base, ...(q.pattern ? [eq(reactions.pattern, q.pattern)] : [])), label: "symbol+pattern" },
    { where: and(eq(reactions.symbol, q.symbol), ...base), label: "symbol" },
    { where: and(...base), label: "all-symbols" },
  ];

  let rows: ReactionRow[] = [];
  let bucket = "all-symbols";
  for (const tier of tiers) {
    rows = await db.select().from(reactions).where(tier.where);
    bucket = tier.label;
    if (rows.length >= MIN_SAMPLE) break;
  }

  const n = rows.length;
  const mfes = rows.map((r) => Number(r.mfePct));
  const respected = rows.filter((r) => r.outcome === "rejected").length;
  const dirSign = q.direction === "call" ? 1 : -1;
  const toTarget = (mfe: number) => (mfe > 0 ? Math.round((q.spot * (1 + dirSign * mfe)) * 100) / 100 : null);

  return {
    n,
    hitRate: n ? respected / n : 0,
    avgMovePct: n ? Math.round((mfes.reduce((a, b) => a + b, 0) / n) * 10000) / 100 : 0,
    avgMovePts: n ? Math.round((mfes.reduce((a, b) => a + b, 0) / n) * q.spot * 100) / 100 : 0,
    avgBarsToPeak: n ? Math.round((rows.reduce((a, r) => a + (r.barsToPeak ?? 0), 0) / n) * 10) / 10 : 0,
    avgMaePct: n ? Math.round((rows.reduce((a, r) => a + Number(r.maePct), 0) / n) * 10000) / 100 : 0,
    continuationRate: n ? (n - respected) / n : 0,
    safeTarget: toTarget(pctile(mfes, 0.25)),
    mainTarget: toTarget(pctile(mfes, 0.5)),
    stretchTarget: toTarget(pctile(mfes, 0.75)),
    expectedHold: n ? Math.round((rows.reduce((a, r) => a + (r.barsToPeak ?? 0), 0) / n)) : 0,
    lowConfidence: n < MIN_SAMPLE,
    bucket,
  };
}
