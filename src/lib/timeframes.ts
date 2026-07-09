/**
 * Timeframe helpers. One place to map our zone-timeframe ids to Alpaca bar
 * intervals and to real minutes, so hold times can be shown as "expected minutes
 * to play out" (Farrukh's ask) instead of an ambiguous bar count.
 */
export type TF = "daily" | "4h" | "1h" | "15min";

/** Alpaca bar interval for an intraday timeframe. */
export const ALPACA_TF: Record<Exclude<TF, "daily">, string> = {
  "4h": "4Hour",
  "1h": "1Hour",
  "15min": "15Min",
};

/** Approx trading minutes one bar covers (daily = one ~6.5h session). */
export const MINUTES_PER_BAR: Record<TF, number> = { daily: 390, "4h": 240, "1h": 60, "15min": 15 };

/** Lookback window (minutes) to fetch for a scan/backfill of each intraday tf. */
export const SCAN_LOOKBACK_MIN: Record<Exclude<TF, "daily">, number> = {
  "4h": 365 * 24 * 60, // ~1y
  "1h": 240 * 24 * 60, // ~8mo
  "15min": 150 * 24 * 60, // ~5mo (finer bars → enough taps in less calendar time)
};

export function holdToMinutes(bars: number, tf: string): number {
  return Math.round(bars * (MINUTES_PER_BAR[tf as TF] ?? 60));
}

/** Human hold estimate: minutes for intraday, days for daily. */
export function formatHold(bars: number, tf: string): string {
  if (tf === "daily") return `~${bars}d`;
  const m = holdToMinutes(bars, tf);
  if (m < 90) return `~${m} min`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `~${h}h ${mm}m` : `~${h}h`;
}
