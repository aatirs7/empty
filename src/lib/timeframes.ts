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

const MINUTES_PER_SESSION = 390; // ~6.5h US trading day

export function holdToMinutes(bars: number, tf: string): number {
  return Math.round(bars * (MINUTES_PER_BAR[tf as TF] ?? 60));
}

/** Expected hold in TRADING days (market time, not wall-clock). A 4h-bar hold
 *  spans multiple sessions, so 6 bars = ~3.7 trading days, not "24h". */
export function holdToDays(bars: number, tf: string): number {
  return (bars * (MINUTES_PER_BAR[tf as TF] ?? 60)) / MINUTES_PER_SESSION;
}

/** Explicit, unambiguous hold estimate: minutes/hours within a session, else
 *  trading days. Never "~N bars". */
export function formatHold(bars: number, tf: string): string {
  if (!bars || bars <= 0) return "—";
  if (tf === "daily") return `~${Math.round(bars)} trading day${Math.round(bars) === 1 ? "" : "s"}`;
  const m = holdToMinutes(bars, tf); // market minutes
  if (m < 90) return `~${Math.round(m)} min`;
  if (m < MINUTES_PER_SESSION) return `~${(m / 60).toFixed(1)}h`;
  return `~${(m / MINUTES_PER_SESSION).toFixed(1)} trading days`;
}
