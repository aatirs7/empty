/**
 * Point-in-time data access for the backtest replay (vega-backtest-spec.md).
 *
 * THE anti-lookahead boundary. Strategy code only ever receives a `StrategyView`,
 * which serves completed bars strictly BEFORE the current simulated day and
 * reaction-DB queries filtered asOf at the source (queryReactions). The current
 * day's bar and future bars exist ONLY on the concrete class (engine-only, for
 * tap detection and outcome walk-forward) and are deliberately absent from the
 * view handed to strategy logic. The clock is monotonic — rewinding throws.
 */
import { getMultiStockBars, type Bar } from "../alpaca";
import { queryReactions, type ReactionQuery, type ReactionStats } from "../reactions";
import { predict, type Prediction } from "../predict";
import { indexTrend, type MarketContext } from "../sniper";
import { barDate, sessionCloseUtc } from "./clock";

export class BacktestLookaheadError extends Error {}

export interface PointInTimeOptions {
  symbols: string[]; // universe + index symbols, deduped by load()
  from: string; // first replay day (YYYY-MM-DD)
  to: string; // last replay day
  /** Bar history depth before `from` — default 4000 days, matching the nightly
   *  scanner (zones persist for all time; a shallower window changes the zone set). */
  lookbackDays?: number;
  /** Calendar days fetched past `to` so walk-forward outcomes near the window
   *  end aren't all truncated. Reachable ONLY via futureBars (engine-only). */
  forwardPadDays?: number;
}

/** What replayed strategy code is allowed to see. No today-bar, no future access. */
export interface StrategyView {
  /** Completed bars strictly before the current day (most recent last).
   *  `windowDays` mirrors live fetch windows (e.g. getStockBars(sym, 400)). */
  bars(symbol: string, windowDays?: number): Bar[];
  /** Reaction-DB stats with the asOf cutoff injected at the source. */
  reactionStats(q: Omit<ReactionQuery, "asOf">): Promise<ReactionStats>;
  /** predict() with the asOf cutoff injected. */
  prediction(
    symbol: string,
    spot: number,
    timeframe: string,
    direction: "call" | "put",
    approach: string,
    marketAlign?: number,
  ): Promise<Prediction>;
  /** SPY/QQQ trend context, same math + window as the live monitor. */
  marketContext(): MarketContext;
}

const CHUNK = 40; // symbols per multi-bar request (matches the scanner)
const DAY_MS = 86_400_000;

export class PointInTimeData {
  private day = ""; // current simulated day (empty until first advanceTo)
  private asOfMoment = new Date(0);
  private prefixCache = new Map<string, Bar[]>();
  private prefixIdx = new Map<string, number>(); // first index with barDate >= day

  private constructor(private readonly all: Map<string, Bar[]>) {}

  static async load(opts: PointInTimeOptions): Promise<PointInTimeData> {
    const lookback = opts.lookbackDays ?? 4000;
    const pad = opts.forwardPadDays ?? 45;
    const symbols = [...new Set(opts.symbols)];
    const end = new Date(new Date(`${opts.to}T00:00:00Z`).getTime() + pad * DAY_MS);
    const span = Math.ceil((end.getTime() - (new Date(`${opts.from}T00:00:00Z`).getTime() - lookback * DAY_MS)) / DAY_MS);
    const all = new Map<string, Bar[]>();
    for (let i = 0; i < symbols.length; i += CHUNK) {
      const batch = await getMultiStockBars(symbols.slice(i, i + CHUNK), span, end);
      for (const [sym, bars] of Object.entries(batch)) all.set(sym, bars);
    }
    return new PointInTimeData(all);
  }

  /** Advance the simulated clock. MONOTONIC — moving backwards is a hard error. */
  advanceTo(day: string): void {
    if (this.day && day <= this.day) {
      throw new BacktestLookaheadError(`advanceTo(${day}) would rewind the clock from ${this.day}`);
    }
    this.day = day;
    this.asOfMoment = sessionCloseUtc(day);
    this.prefixCache.clear();
    this.prefixIdx.clear();
  }

  asOf(): Date {
    return new Date(this.asOfMoment);
  }
  currentDay(): string {
    return this.day;
  }

  private idx(symbol: string): number {
    const cached = this.prefixIdx.get(symbol);
    if (cached != null) return cached;
    const bars = this.all.get(symbol) ?? [];
    // binary search: first index with barDate(t) >= day
    let lo = 0;
    let hi = bars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (barDate(bars[mid].t) < this.day) lo = mid + 1;
      else hi = mid;
    }
    this.prefixIdx.set(symbol, lo);
    return lo;
  }

  // ---- StrategyView surface -------------------------------------------------

  bars(symbol: string, windowDays?: number): Bar[] {
    if (!this.day) throw new BacktestLookaheadError("bars() before advanceTo()");
    let prefix = this.prefixCache.get(symbol);
    if (!prefix) {
      prefix = (this.all.get(symbol) ?? []).slice(0, this.idx(symbol));
      this.prefixCache.set(symbol, prefix);
    }
    if (windowDays == null) return prefix;
    const cutoff = barDate(new Date(new Date(`${this.day}T00:00:00Z`).getTime() - windowDays * DAY_MS).toISOString());
    // binary search within the prefix for the first bar >= cutoff
    let lo = 0;
    let hi = prefix.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (barDate(prefix[mid].t) < cutoff) lo = mid + 1;
      else hi = mid;
    }
    return prefix.slice(lo);
  }

  reactionStats(q: Omit<ReactionQuery, "asOf">): Promise<ReactionStats> {
    return queryReactions({ ...q, asOf: this.asOf() });
  }

  prediction(
    symbol: string,
    spot: number,
    timeframe: string,
    direction: "call" | "put",
    approach: string,
    marketAlign = 0,
  ): Promise<Prediction> {
    return predict(symbol, spot, timeframe, direction, approach, marketAlign, this.asOf());
  }

  marketContext(): MarketContext {
    // Live monitor: indexTrend over getStockBars("SPY"/"QQQ", 90).
    try {
      return { spy: indexTrend(this.bars("SPY", 90)), qqq: indexTrend(this.bars("QQQ", 90)) };
    } catch {
      return { spy: 0, qqq: 0 };
    }
  }

  /** The narrowed view handed to strategy code. Deliberately has NO todayBar /
   *  futureBars / allBars — the self-test asserts their absence at runtime. */
  view(): StrategyView {
    return {
      bars: (s, w) => this.bars(s, w),
      reactionStats: (q) => this.reactionStats(q),
      prediction: (s, spot, tf, dir, app, ma) => this.prediction(s, spot, tf, dir, app, ma),
      marketContext: () => this.marketContext(),
    };
  }

  // ---- ENGINE-ONLY (never on StrategyView) ----------------------------------

  /** The current day's bar — the "live tape" used ONLY for tap detection and
   *  entry approximation, never handed to strategy logic. */
  todayBar(symbol: string): Bar | null {
    if (!this.day) throw new BacktestLookaheadError("todayBar() before advanceTo()");
    const bars = this.all.get(symbol) ?? [];
    const i = this.idx(symbol);
    return i < bars.length && barDate(bars[i].t) === this.day ? bars[i] : null;
  }

  /** Bars strictly AFTER the current day — outcome walk-forward only. */
  futureBars(symbol: string, horizon: number): Bar[] {
    if (!this.day) throw new BacktestLookaheadError("futureBars() before advanceTo()");
    const bars = this.all.get(symbol) ?? [];
    let i = this.idx(symbol);
    if (i < bars.length && barDate(bars[i].t) === this.day) i += 1; // skip today
    return bars.slice(i, i + horizon);
  }

  /** Full raw series (trading-day derivation, baselines). Engine-only. */
  allBars(symbol: string): Bar[] {
    return this.all.get(symbol) ?? [];
  }
}
