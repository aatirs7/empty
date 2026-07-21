/**
 * Simulated backtest clock. Trading days are derived from SPY's actual daily
 * bars (a date is a trading day iff SPY printed a bar) — holiday and half-day
 * aware with zero holiday tables. The clock only ever moves FORWARD.
 */
import type { Bar } from "../alpaca";

/** YYYY-MM-DD (UTC date part) of a bar timestamp. Alpaca daily bars are stamped
 *  at the session date, so the date slice is the trading day. */
export const barDate = (t: string): string => t.slice(0, 10);

/** Trading days in [from, to] (inclusive), ascending, derived from SPY bars. */
export function tradingDaysFromBars(spyBars: Bar[], from: string, to: string): string[] {
  const days = new Set<string>();
  for (const b of spyBars) {
    const d = barDate(b.t);
    if (d >= from && d <= to) days.add(d);
  }
  return [...days].sort();
}

/** 16:00 ET (session close) of a YYYY-MM-DD day, as a UTC Date — DST-aware. */
export function sessionCloseUtc(day: string): Date {
  // 16:00 ET is 20:00 UTC under EDT and 21:00 UTC under EST; pick whichever
  // candidate formats to 16h in America/New_York.
  for (const h of [20, 21]) {
    const d = new Date(`${day}T${String(h).padStart(2, "0")}:00:00Z`);
    const et = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(d);
    if (Number(et) === 16) return d;
  }
  return new Date(`${day}T21:00:00Z`);
}

export class BacktestClock {
  private i = 0;
  constructor(private readonly days: string[]) {
    if (days.length === 0) throw new Error("BacktestClock: no trading days in window");
  }
  day(): string {
    return this.days[this.i];
  }
  index(): number {
    return this.i;
  }
  done(): boolean {
    return this.i >= this.days.length;
  }
  /** Advance one trading day. Returns false when the window is exhausted. */
  advance(): boolean {
    this.i += 1;
    return this.i < this.days.length;
  }
  /** The asOf moment handed to the point-in-time data layer for the current day. */
  sessionCloseUtc(): Date {
    return sessionCloseUtc(this.day());
  }
}
