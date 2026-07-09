/**
 * Order-block "zone" engine. PORT of the Pine indicator
 * "HTF OB Tap Signals — Real-Time" (v6), Farrukh's live settings:
 *   HTF = 1 day, ATR length = 50, displacement = 1.7x,
 *   firstTouchOnly = true, wickTouchOnly = true, requireRejection = false, useFVG = false.
 *
 * GUARDRAIL: every number here is code-computed. Zones are never read from a
 * chart image or produced by the model. See STRATEGY.md for the traded rules.
 */
import type { Bar } from "./alpaca";

export interface Zone {
  type: "demand" | "supply";
  bottom: number;
  top: number;
  formedAt: string; // bar timestamp when the zone formed
  used: boolean; // first-touch consumed
}

export interface ZoneOptions {
  atrLength: number;
  displacement: number;
  firstTouchOnly: boolean;
  useFVG: boolean;
  /** Cap zone height at this × ATR, pulling in the DISTAL edge (keeps the proximal
   *  edge price taps). Undefined = no cap (daily). Set for intraday so big HTF
   *  candles don't produce range-wide "zones". */
  maxWidthAtr?: number;
}

export const DEFAULT_ZONE_OPTIONS: ZoneOptions = {
  atrLength: 50,
  displacement: 1.7,
  firstTouchOnly: true,
  useFVG: false,
};

/**
 * Wilder's ATR, matching Pine `ta.atr(length)` (= `ta.rma(ta.tr, length)`).
 * Returns a per-bar array; atr[i] is the ATR value at bar i, NaN before the seed.
 */
export function computeATR(bars: Bar[], length: number): number[] {
  const n = bars.length;
  const tr = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (i === 0) tr[i] = bars[i].h - bars[i].l;
    else {
      const pc = bars[i - 1].c;
      tr[i] = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - pc), Math.abs(bars[i].l - pc));
    }
  }
  const atr = new Array<number>(n).fill(NaN);
  if (n < length) return atr;
  // Seed with the SMA of the first `length` true ranges (Pine rma seeding).
  let seed = 0;
  for (let i = 0; i < length; i++) seed += tr[i];
  atr[length - 1] = seed / length;
  for (let i = length; i < n; i++) {
    atr[i] = (atr[i - 1] * (length - 1) + tr[i]) / length;
  }
  return atr;
}

export interface ZoneResult {
  zones: Zone[]; // all detected, in formation order
  active: Zone[]; // unused zones (not yet first-touched)
  atr: number; // latest ATR value
  lastBar: Bar;
}

/** A bar's range overlaps a zone (wick touch): high into the zone, low into the zone. */
const overlaps = (bar: Bar, z: Zone): boolean => bar.h >= z.bottom && bar.l <= z.top;

/**
 * Detect demand/supply order-block zones from daily OHLC bars (most recent last).
 * Iterates forward: each bar first taps existing unused zones (first-touch), then
 * may form a new zone off a displacement candle.
 */
export function computeZones(bars: Bar[], opts: ZoneOptions = DEFAULT_ZONE_OPTIONS): ZoneResult {
  const { atrLength, displacement, firstTouchOnly } = opts;
  if (bars.length < atrLength + 2) {
    throw new Error(`computeZones: need >= ${atrLength + 2} bars, got ${bars.length}`);
  }
  const atr = computeATR(bars, atrLength);
  const demand: Zone[] = [];
  const supply: Zone[] = [];

  for (let i = atrLength; i < bars.length; i++) {
    const cur = bars[i];
    const prior = bars[i - 1];

    // 1) First-touch: any unused zone this bar taps is now consumed.
    if (firstTouchOnly) {
      for (const z of demand) if (!z.used && overlaps(cur, z)) z.used = true;
      for (const z of supply) if (!z.used && overlaps(cur, z)) z.used = true;
    }

    // 2) Zone formation on a displacement candle following an opposite-color candle.
    const body = Math.abs(cur.c - cur.o);
    const thresh = displacement * atr[i];
    const upImpulse = cur.c > cur.o && body > thresh;
    const downImpulse = cur.c < cur.o && body > thresh;
    const priorBearish = prior.c < prior.o;
    const priorBullish = prior.c > prior.o;

    // Keep ALL zones for all time (full history, no FIFO drop). Old untapped
    // zones persist and remain tradeable; tapped ones are marked used above.
    const cap = opts.maxWidthAtr && atr[i] > 0 ? opts.maxWidthAtr * atr[i] : Infinity;
    if (upImpulse && priorBearish) {
      // demand: price taps the TOP (proximal); pull the bottom (distal) in if too wide.
      const top = prior.o;
      const bottom = Math.max(prior.l, top - cap);
      demand.push({ type: "demand", bottom, top, formedAt: cur.t, used: false });
    }
    if (downImpulse && priorBullish) {
      // supply: price taps the BOTTOM (proximal); pull the top (distal) in if too wide.
      const bottom = prior.o;
      const top = Math.min(prior.h, bottom + cap);
      supply.push({ type: "supply", bottom, top, formedAt: cur.t, used: false });
    }
    // useFVG is off by default; no FVG gate.
  }

  const zones = [...demand, ...supply];
  const active = zones.filter((z) => !z.used);
  return { zones, active, atr: atr[bars.length - 1], lastBar: bars[bars.length - 1] };
}
