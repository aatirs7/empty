/**
 * Confirmation engine (SniperBot rule: "a touch isn't a signal — wait for proof").
 * On the confirmation timeframe (5-min, SIP), detect institutional defense of a
 * zone: a rejection wick INTO the zone, an engulfing candle, or a strong
 * directional close, accompanied by rising RELATIVE VOLUME. Everything here is
 * code-computed from real bars — no model, no invented numbers.
 */
import { getIntradayBars, type Bar } from "./alpaca";

export interface Confirmation {
  confirmed: boolean;
  executionScore: number; // 0-100 Execution-Quality (how clean the confirmation is)
  relVolume: number; // last candle volume vs the rolling average
  reason: string;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

const NO_DATA: Confirmation = { confirmed: false, executionScore: 0, relVolume: 0, reason: "no intraday data" };

export async function confirmEntry(
  symbol: string,
  direction: "call" | "put",
  zone: { bottom: number; top: number },
  minRelVolume: number,
): Promise<Confirmation> {
  let bars: Bar[];
  try {
    bars = await getIntradayBars(symbol, "5Min", 300);
  } catch {
    return NO_DATA;
  }
  if (bars.length < 6) return { ...NO_DATA, reason: "too few intraday bars" };

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];

  // Relative volume vs the prior ~20 bars (excludes the current candle).
  const window = bars.slice(-21, -1);
  const avgVol = window.reduce((s, b) => s + b.v, 0) / Math.max(1, window.length);
  const relVolume = avgVol > 0 ? last.v / avgVol : 0;

  const body = Math.abs(last.c - last.o);
  const range = Math.max(1e-9, last.h - last.l);
  const upperWick = last.h - Math.max(last.o, last.c);
  const lowerWick = Math.min(last.o, last.c) - last.l;

  let signal = false;
  let why = "";
  let wickRatio = 0;

  if (direction === "call") {
    // Bullish defense of support: the candle reached into/below the zone and
    // buyers pushed it back up.
    const dippedIn = last.l <= zone.top;
    const rejectionWick = lowerWick >= body && lowerWick >= range * 0.4;
    const strongClose = last.c > last.o && last.c >= last.l + range * 0.6;
    const engulf = last.c > last.o && prev.c < prev.o && last.c >= prev.o && last.o <= prev.c;
    signal = dippedIn && (rejectionWick || strongClose || engulf);
    why = !dippedIn ? "price not at the zone" : engulf ? "bullish engulfing" : rejectionWick ? "lower rejection wick" : strongClose ? "strong bullish close" : "no bullish confirmation";
    wickRatio = lowerWick / range;
  } else {
    const poppedIn = last.h >= zone.bottom;
    const rejectionWick = upperWick >= body && upperWick >= range * 0.4;
    const strongClose = last.c < last.o && last.c <= last.h - range * 0.6;
    const engulf = last.c < last.o && prev.c > prev.o && last.c <= prev.o && last.o >= prev.c;
    signal = poppedIn && (rejectionWick || strongClose || engulf);
    why = !poppedIn ? "price not at the zone" : engulf ? "bearish engulfing" : rejectionWick ? "upper rejection wick" : strongClose ? "strong bearish close" : "no bearish confirmation";
    wickRatio = upperWick / range;
  }

  const volOk = relVolume >= minRelVolume;
  const confirmed = signal && volOk;
  const executionScore = confirmed ? Math.round(clamp(40 + wickRatio * 40 + Math.min(relVolume, 3) * 7, 0, 100)) : 0;
  const reason = `${why}${signal && !volOk ? ", but low volume" : ""} (RVOL ${relVolume.toFixed(1)}x)`;

  return { confirmed, executionScore, relVolume: Math.round(relVolume * 100) / 100, reason };
}
