/**
 * SBv2 — 4H EMPTY-SPACE BREAKOUT & RETEST backtest (the NEW 2026-07-21 logic;
 * the Stage-1/2 engines replay the RETIRED flip logic and refuse sbv2).
 *
 * Replay model (mirrors the live path):
 * - DAILY zones from full-history daily bars strictly before the session
 *   (scanner parity), via the same `computeZones`.
 * - Breakouts qualified by `detectBreakoutsDetailed` (the live detector) over
 *   COMPLETED 4h bars — re-evaluated whenever a 4h candle completes mid-session,
 *   like the hourly live re-scan.
 * - Entry: the FIRST 15-minute bar whose range touches the stored boundary
 *   (call: low <= boundary; put: high >= boundary). One trade per breakout.
 *   Entry premium from the contract's REAL 15-minute option bar at that moment
 *   (vwap + modeled half-spread); contract = live price-first band $1.00-1.50
 *   ideal $1.20, weekly Friday >= 2 days, strike window 4% OTM / 3% ITM.
 * - Exits, chronological on real 15m option bars (conservative within-bar
 *   ordering: stop before take-profit): -25% stop off the entry ask, +100%
 *   take-profit, completed-4h close back inside the zone (at the candle's
 *   completion time), catastrophe floor / expiry salvage / expiry intrinsic.
 * - Portfolio pass applies the live account protections in entry order:
 *   3 trades/day, maxOpenPositions, 2 same-direction, 2 per sector, and the
 *   3-losses-today stop (risk-only intel).
 *
 * Anti-lookahead: daily bars via PointInTimeData (asOf-owned); 4h/15m served
 * only up to the step time via completed-interval slicing. No model calls, no
 * broker imports, writes ONLY backtest_* tables. Deterministic.
 */
import { db } from "../../db";
import { backtestRuns, backtestSignals, backtestTrades } from "../../db/schema";
import { and, eq } from "drizzle-orm";
import { getIntradayBars, getOptionBars, type Bar, type OptionBar } from "../alpaca";
import { getProfile } from "../profiles";
import { computeZones } from "../zones";
import { detectBreakoutsDetailed, DEFAULT_BREAKOUT_OPTIONS, type Breakout } from "../breakout";
import { sectorOf } from "../intel";
import { loadUniverse } from "../scanner";
import { PointInTimeData } from "./data";
import { tradingDaysFromBars, barDate } from "./clock";
import { hashConfig } from "./random";
import { signalInsertRows, spyBaseline, type Stage1SignalRecord } from "./engine";
import { DEFAULT_SPREAD, type SpreadConfig, askOf, bidOf, strikeGrid, occSymbol, pickFridayExpiry } from "./pricing";

const MIN_15M = 15 * 60_000;
const MIN_4H = 4 * 60 * 60_000;
const DAY_MS = 86_400_000;

export interface Sbv2BreakoutConfig {
  from: string;
  to: string;
  universe?: string[];
  seed?: string;
  label?: string;
  dryRun?: boolean;
}

function etMinutes(ms: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date(ms));
  return Number(parts.find((p) => p.type === "hour")?.value ?? 0) * 60 + Number(parts.find((p) => p.type === "minute")?.value ?? 0);
}

/** Completed-interval prefix: bars whose interval ended at or before tMs. */
function completedUpTo(all: Bar[], tMs: number, intervalMs: number): Bar[] {
  let lo = 0;
  let hi = all.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Date.parse(all[mid].t) + intervalMs <= tMs) lo = mid + 1;
    else hi = mid;
  }
  return all.slice(0, lo);
}

// ---------------------------------------------------------------------------
// Exit simulation — pure, exported for breakout-check.ts assertions.
// ---------------------------------------------------------------------------
export interface BreakoutExitInput {
  entryAsk: number;
  direction: "call" | "put";
  zone: { bottom: number; top: number };
  strike: number;
  expiry: string; // YYYY-MM-DD
  entryMs: number;
  optionBars15: OptionBar[]; // the contract's real 15m bars, entry..expiry
  bars4h: Bar[]; // the underlying's 4h bars covering the hold (completed-checked inside)
  underlyingDailyCloseAtExpiry: number | null; // for intrinsic settlement
  spread: SpreadConfig;
  stopLoss: number; // -0.25
  takeProfit: number; // 1.0
  catastropheFloor: number; // 0.10
  catastropheDays: number; // 2
}
export interface BreakoutExitResult {
  exitMs: number;
  exitBid: number;
  exitReason: string;
}

export function simulateBreakoutExit(inp: BreakoutExitInput): BreakoutExitResult {
  const stopPremium = inp.entryAsk * (1 + inp.stopLoss);
  const tpPremium = inp.entryAsk * (1 + inp.takeProfit);
  const expiryMs = Date.parse(`${inp.expiry}T21:00:00Z`);
  let lastBid = bidOf(inp.entryAsk, inp.spread);
  let lastMs = inp.entryMs;

  // Pre-compute 4h invalidation moments: a COMPLETED 4h candle closing back
  // inside the zone (call: close < zone.top; put: close > zone.bottom), after entry.
  const invalidations = inp.bars4h
    .map((b) => ({ doneMs: Date.parse(b.t) + MIN_4H, close: b.c }))
    .filter((x) => x.doneMs > inp.entryMs)
    .filter((x) => (inp.direction === "call" ? x.close < inp.zone.top : x.close > inp.zone.bottom));
  const firstInvalidMs = invalidations.length ? invalidations[0].doneMs : null;

  for (const ob of inp.optionBars15) {
    const barStart = Date.parse(ob.t);
    if (barStart < inp.entryMs) continue;
    const barEnd = barStart + MIN_15M;
    // 4h invalidation lands BEFORE this option bar → sell at this bar's open-side bid.
    if (firstInvalidMs != null && firstInvalidMs <= barStart) {
      return { exitMs: barEnd, exitBid: Math.max(0.01, bidOf(ob.o, inp.spread)), exitReason: "4h_close_back_inside" };
    }
    // Conservative within-bar order: stop first, then take-profit.
    if (bidOf(ob.l, inp.spread) <= stopPremium) {
      return { exitMs: barEnd, exitBid: Math.max(0.01, stopPremium * (1 - inp.spread.stopSlippagePct)), exitReason: "stop_-25%" };
    }
    if (bidOf(ob.h, inp.spread) >= tpPremium) {
      return { exitMs: barEnd, exitBid: tpPremium, exitReason: "target_+100%" };
    }
    lastBid = bidOf(ob.c, inp.spread);
    lastMs = barEnd;
    const dteDays = Math.ceil((expiryMs - barEnd) / DAY_MS);
    if (lastBid <= inp.catastropheFloor && dteDays <= inp.catastropheDays) {
      return { exitMs: barEnd, exitBid: lastBid, exitReason: "catastrophe" };
    }
    // Expiry-day salvage: flatten in the last half hour of the expiry session.
    if (barDate(ob.t) === inp.expiry && etMinutes(barEnd) >= 15 * 60 + 30) {
      return { exitMs: barEnd, exitBid: lastBid, exitReason: "expiry_salvage" };
    }
  }
  // Option bars ran out (halted/thin/expired between prints): settle at intrinsic
  // when past expiry, else at the last real mark.
  if (lastMs >= expiryMs - DAY_MS && inp.underlyingDailyCloseAtExpiry != null) {
    const intrinsic =
      inp.direction === "call"
        ? Math.max(0, inp.underlyingDailyCloseAtExpiry - inp.strike)
        : Math.max(0, inp.strike - inp.underlyingDailyCloseAtExpiry);
    return { exitMs: expiryMs, exitBid: Math.round(intrinsic * 100) / 100, exitReason: "expiry_intrinsic" };
  }
  return { exitMs: lastMs, exitBid: lastBid, exitReason: "data_end" };
}

// ---------------------------------------------------------------------------
// The replay.
// ---------------------------------------------------------------------------
interface SimTrade {
  signalIndex: number;
  symbol: string;
  direction: "call" | "put";
  day: string;
  entryMs: number;
  entryHourEt: number;
  occ: string;
  strike: number;
  expiry: string;
  qty: number;
  entryAsk: number;
  exitMs: number;
  exitDay: string;
  exitBid: number;
  exitReason: string;
  plUsd: number;
  fees: number;
  inPortfolio: boolean;
  portfolioSkip?: string;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

function tradeStats(trades: SimTrade[]) {
  const n = trades.length;
  const wins = trades.filter((t) => t.plUsd > 0);
  const losses = trades.filter((t) => t.plUsd <= 0);
  const grossWin = wins.reduce((a, t) => a + t.plUsd, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.plUsd, 0));
  const mean = (xs: number[]) => (xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return {
    n,
    netPl: round2(trades.reduce((a, t) => a + t.plUsd, 0)),
    winRate: n ? Math.round((wins.length / n) * 1000) / 10 : null,
    avgWinUsd: mean(wins.map((t) => t.plUsd)),
    avgLossUsd: mean(losses.map((t) => t.plUsd)),
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : null,
    t1RatePct: null, // no trims in this strategy
    t2RatePct: null,
    breakevenAfterT1Pct: null,
    stopRatePct: n ? Math.round((trades.filter((t) => t.exitReason.startsWith("stop")).length / n) * 1000) / 10 : null,
  };
}

function groupStats(trades: SimTrade[], key: (t: SimTrade) => string) {
  const groups = new Map<string, SimTrade[]>();
  for (const t of trades) groups.set(key(t), [...(groups.get(key(t)) ?? []), t]);
  return [...groups.entries()]
    .map(([k, xs]) => ({ key: k, n: xs.length, netPl: round2(xs.reduce((a, t) => a + t.plUsd, 0)), winRate: Math.round((xs.filter((t) => t.plUsd > 0).length / xs.length) * 1000) / 10 }))
    .sort((a, b) => b.n - a.n);
}

export async function runSbv2Breakout(cfg: Sbv2BreakoutConfig) {
  const profile = getProfile("sbv2");
  if (profile.setupKind !== "breakout") throw new Error("live sbv2 is no longer the breakout strategy — this replay would be stale");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cfg.from) || !/^\d{4}-\d{2}-\d{2}$/.test(cfg.to) || cfg.from > cfg.to) throw new Error(`bad window ${cfg.from}..${cfg.to}`);
  const universe = (cfg.universe && cfg.universe.length ? cfg.universe : await loadUniverse("sbv2")).slice().sort();
  if (universe.length === 0) throw new Error("empty sbv2 universe");

  const spread = DEFAULT_SPREAD;
  const exitCfg = {
    stopLoss: profile.exit.swingStopLoss ?? -0.25,
    takeProfit: profile.exit.swingTakeProfit ?? 1.0,
    catastropheFloor: profile.exit.catastropheFloor ?? 0.1,
    catastropheDays: profile.exit.catastropheDays ?? 2,
  };
  const canonical = {
    profileId: "sbv2",
    strategy: "4h_empty_space_breakout_retest",
    from: cfg.from,
    to: cfg.to,
    granularity: "intraday",
    universe,
    seed: cfg.seed ?? "",
    constants: {
      breakout: DEFAULT_BREAKOUT_OPTIONS,
      contract: profile.contract,
      caps: { maxPerDay: profile.caps.maxTradesPerDay ?? 3, maxOpen: profile.caps.maxOpenPositions, sameDirCap: 2, sectorCap: 2, sessionLossStop: 3 },
      exit: exitCfg,
      spread,
      minDays: 2,
    },
  };
  const configHash = hashConfig(canonical);

  // Daily bars (zones need full history — scanner parity) via the Stage-1 layer.
  const daily = await PointInTimeData.load({ symbols: [...universe, "SPY", "QQQ"], from: cfg.from, to: cfg.to });
  const days = tradingDaysFromBars(daily.allBars("SPY"), cfg.from, cfg.to);
  if (days.length === 0) throw new Error("no trading days in window");

  // 4h + 15m underlying bars for the window (+left context), fetched once per symbol.
  const windowDays = Math.ceil((Date.parse(cfg.to) - Date.parse(cfg.from)) / DAY_MS) + 10;
  const end = new Date(`${cfg.to}T23:59:59Z`);
  const bars4hBySym = new Map<string, Bar[]>();
  const bars15BySym = new Map<string, Bar[]>();
  for (const sym of universe) {
    bars4hBySym.set(sym, await getIntradayBars(sym, "4Hour", (windowDays + 40) * 24 * 60, end));
    bars15BySym.set(sym, await getIntradayBars(sym, "15Min", windowDays * 24 * 60, end));
  }

  const signals: Stage1SignalRecord[] = [];
  const trades: SimTrade[] = [];
  const skips: Record<string, number> = {};
  const skip = (why: string) => (skips[why] = (skips[why] ?? 0) + 1);
  const tradedBreakouts = new Set<string>(); // one trade per breakout, across the whole run

  for (const day of days) {
    daily.advanceTo(day);
    for (const sym of universe) {
      const dBars = daily.bars(sym);
      if (dBars.length < 60) continue;
      let zones;
      try {
        zones = computeZones(dBars, profile.strategy.zone).zones;
      } catch {
        continue;
      }
      if (zones.length === 0) continue;
      const all4h = bars4hBySym.get(sym) ?? [];
      const day15 = (bars15BySym.get(sym) ?? []).filter((b) => barDate(b.t) === day);
      if (day15.length === 0) continue;

      let count4h = -1;
      let watch: Breakout[] = [];
      for (const b of day15) {
        const T = Date.parse(b.t) + MIN_15M; // decisions at the bar's completion
        // REGULAR HOURS ONLY: the live monitor ticks 9:25-16:05 ET, so a touch on an
        // extended-hours bar (SIP serves pre/post-market 15m bars) can never trade.
        const etm = etMinutes(T);
        if (etm < 9 * 60 + 45 || etm > 16 * 60) continue;
        const c4 = completedUpTo(all4h, T, MIN_4H);
        if (c4.length < 30) break;
        if (c4.length !== count4h) {
          count4h = c4.length;
          const price = c4[c4.length - 1].c; // live scan's reference = last completed 4h close
          watch = detectBreakoutsDetailed(zones, c4, price, DEFAULT_BREAKOUT_OPTIONS).breakouts;
        }
        for (const bo of watch) {
          const key = `${sym}|${bo.zone.bottom.toFixed(4)}|${bo.zone.top.toFixed(4)}|${bo.direction}`;
          if (tradedBreakouts.has(key)) continue;
          const touched = bo.direction === "call" ? b.l <= bo.boundary : b.h >= bo.boundary;
          if (!touched) continue;
          tradedBreakouts.add(key); // the first retest is the ONLY trade this breakout gets

          // Entry: at the boundary (gap-through opens use the bar's open — the live
          // monitor would have seen that price first).
          const gapThrough = bo.direction === "call" ? b.o < bo.boundary : b.o > bo.boundary;
          const entryUnderlying = gapThrough ? b.o : bo.boundary;
          const entryMs = T; // seen at the bar's completion tick (minute-cron parity: labeled)

          const sigIndex = signals.length;
          signals.push({
            symbol: sym,
            firedAt: new Date(entryMs),
            day,
            direction: bo.direction,
            setupKind: "breakout",
            playbookType: "4H Breakout Retest",
            score: null,
            zoneBottom: bo.zone.bottom,
            zoneTop: bo.zone.top,
            tappedEdge: bo.boundary,
            approach: bo.direction === "call" ? "from_above" : "from_below",
            entryUnderlying: round2(entryUnderlying),
            entryApprox: true,
            gapThrough,
            statedTarget: null, // spec: no underlying targets — premium rules only
            statedProbability: null,
            statedConfidence: null,
            statedSampleSize: null,
            statedHoldBars: null,
            predictionBucket: null,
            gates: {
              scan: "replayed_completed_4h",
              trigger: "first_touch_15m_bar",
              cancel_4h_close_inside: "replayed",
              risk_layer: "portfolio_pass",
              confirmation: "none_by_spec",
              news: "none_by_spec",
              model: "none_by_spec",
            },
            wouldTradeLive: true, // provisional — the portfolio pass decides
            outcome: {
              targetHit: false,
              targetTouched: false,
              barsToTarget: null,
              invalidated: false,
              invalidatedAtBar: null,
              invalidatedFirst: false,
              tie: false,
              mfePct: 0,
              maePct: 0,
              ret1d: null,
              ret2d: null,
              ret3d: null,
              ret5d: null,
              ret10d: null,
              forwardBars: 0,
              outcomeStatus: "complete",
            },
          });

          // ---- Contract: live price-first band over the REAL 15m chain ----------
          const expiry = pickFridayExpiry(day, 2);
          const strikes = strikeGrid(entryUnderlying, bo.direction, profile.contract.otmPct, profile.contract.itmPct);
          const occs = strikes.map((k) => occSymbol(sym, expiry, bo.direction, k));
          let chain: Record<string, OptionBar[]> = {};
          try {
            chain = await getOptionBars(occs, day, day, "15Min");
          } catch {
            skip("chain_fetch_failed");
            continue;
          }
          const priced = occs
            .map((occ, i) => {
              const obars = chain[occ] ?? [];
              const at = obars.filter((ob) => Date.parse(ob.t) + MIN_15M <= entryMs).at(-1);
              return at ? { occ, strike: strikes[i], at } : null;
            })
            .filter((x): x is NonNullable<typeof x> => x != null)
            .filter((x) => x.at.n >= spread.minTrades && x.at.v >= spread.minVolume)
            .map((x) => ({ ...x, ask: round2(askOf(x.at.vw, spread)) }))
            .filter((x) => x.ask >= profile.contract.priceFloor && x.ask <= profile.contract.priceCap);
          if (priced.length === 0) {
            skip("no_contract_in_band");
            continue;
          }
          const chosen = priced.reduce((best, x) => (Math.abs(x.ask - profile.contract.priceIdeal) < Math.abs(best.ask - profile.contract.priceIdeal) ? x : best));

          let series: OptionBar[] = [];
          try {
            series = (await getOptionBars([chosen.occ], day, expiry, "15Min"))[chosen.occ] ?? [];
          } catch {
            skip("series_fetch_failed");
            continue;
          }
          const expiryClose = (() => {
            const b = (daily.allBars(sym) ?? []).find((x) => barDate(x.t) === expiry);
            return b ? b.c : null;
          })();
          const exit = simulateBreakoutExit({
            entryAsk: chosen.ask,
            direction: bo.direction,
            zone: bo.zone,
            strike: chosen.strike,
            expiry,
            entryMs,
            optionBars15: series,
            bars4h: all4h,
            underlyingDailyCloseAtExpiry: expiryClose,
            spread,
            ...exitCfg,
          });
          const fees = spread.feePerContractRoundTrip;
          const plUsd = round2((exit.exitBid - chosen.ask) * 100 - fees);
          trades.push({
            signalIndex: sigIndex,
            symbol: sym,
            direction: bo.direction,
            day,
            entryMs,
            entryHourEt: Math.floor(etMinutes(entryMs) / 60),
            occ: chosen.occ,
            strike: chosen.strike,
            expiry,
            qty: 1,
            entryAsk: chosen.ask,
            exitMs: exit.exitMs,
            exitDay: barDate(new Date(exit.exitMs).toISOString()),
            exitBid: exit.exitBid,
            exitReason: exit.exitReason,
            plUsd,
            fees,
            inPortfolio: false,
          });
        }
      }
    }
  }

  // ---- Portfolio pass: the live account protections, in entry order ----------
  const maxPerDay = profile.caps.maxTradesPerDay ?? 3;
  const maxOpen = profile.caps.maxOpenPositions;
  const byDay = new Map<string, number>();
  const lossesByDay = new Map<string, number>();
  const open: { exitMs: number; direction: string; sector: string; plUsd: number; exitDay: string }[] = [];
  for (const t of [...trades].sort((a, b) => a.entryMs - b.entryMs)) {
    // realize exits that completed before this entry (drives the session-loss stop)
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i].exitMs <= t.entryMs) {
        const done = open.splice(i, 1)[0];
        if (done.plUsd < 0) lossesByDay.set(done.exitDay, (lossesByDay.get(done.exitDay) ?? 0) + 1);
      }
    }
    const sector = sectorOf(t.symbol);
    const dayCount = byDay.get(t.day) ?? 0;
    let deny = "";
    if ((lossesByDay.get(t.day) ?? 0) >= 3) deny = "session_loss_stop";
    else if (dayCount >= maxPerDay) deny = "daily_cap";
    else if (open.length >= maxOpen) deny = "open_cap";
    else if (open.filter((o) => o.direction === t.direction).length >= 2) deny = "same_direction_cap";
    else if (open.filter((o) => o.sector === sector).length >= 2) deny = "sector_cap";
    if (deny) {
      t.portfolioSkip = deny;
      continue;
    }
    byDay.set(t.day, dayCount + 1);
    open.push({ exitMs: t.exitMs, direction: t.direction, sector, plUsd: t.plUsd, exitDay: t.exitDay });
    t.inPortfolio = true;
  }
  for (const s of signals) s.wouldTradeLive = false;
  for (const t of trades) if (t.inPortfolio) signals[t.signalIndex].wouldTradeLive = true;
  const taken = trades.filter((t) => t.inPortfolio);
  let equity = 1000;
  let peak = 1000;
  let maxDrawdown = 0;
  let streak = 0;
  let worstStreak = 0;
  for (const t of [...taken].sort((a, b) => a.exitMs - b.exitMs)) {
    equity = round2(equity + t.plUsd);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, round2(equity - peak));
    streak = t.plUsd < 0 ? streak + 1 : 0;
    worstStreak = Math.max(worstStreak, streak);
  }

  const metrics = {
    intraday: {
      allTrades: tradeStats(trades),
      portfolio: { taken: taken.length, pl: round2(taken.reduce((a, t) => a + t.plUsd, 0)), endEquity: equity, maxDrawdown, worstStreak, stats: tradeStats(taken) },
      skips: { ...skips, ...Object.fromEntries(Object.entries(trades.reduce<Record<string, number>>((m, t) => (t.portfolioSkip ? ((m[`portfolio_${t.portfolioSkip}`] = (m[`portfolio_${t.portfolioSkip}`] ?? 0) + 1), m) : m), {}))) },
      byTicker: groupStats(trades, (t) => t.symbol),
      byHourEt: groupStats(trades, (t) => `${t.entryHourEt}:00`),
      byScore: [],
      byDirection: groupStats(trades, (t) => t.direction),
      byAlignment: [],
      byExitReason: groupStats(trades, (t) => t.exitReason),
      spy: spyBaseline(daily, cfg.from, cfg.to),
      assumptions: {
        strategy: "SBv2 4H empty-space breakout & retest (2026-07-21 spec) — NOT the retired flip logic",
        pricing: "REAL 15-minute historical option bars; NBBO history unavailable -> spread MODELED (visible config)",
        entry: "first REGULAR-HOURS 15m bar whose range touches the stored boundary; entry price = boundary (bar open when gapped through); seen at bar completion (minute-cron granularity approximated at 15m)",
        exits: "conservative within-bar order: -25% stop before +100% TP; 4h close-back-inside at the candle's completion; catastrophe/salvage/intrinsic",
        portfolio: "3/day + maxOpen + 2 same-direction + 2 per-sector + 3-losses-today stop, applied in entry order",
        spread,
      },
    },
  };

  if (cfg.dryRun) {
    return { runId: null as number | null, configHash, days: days.length, signalCount: signals.length, trades, skips, metrics };
  }

  const prior = await db
    .select({ id: backtestRuns.id })
    .from(backtestRuns)
    .where(and(eq(backtestRuns.profileId, "sbv2"), eq(backtestRuns.fromDate, cfg.from), eq(backtestRuns.toDate, cfg.to)));
  const [run] = await db
    .insert(backtestRuns)
    .values({
      profileId: "sbv2",
      stage: 2,
      fromDate: cfg.from,
      toDate: cfg.to,
      granularity: "intraday",
      pricingPath: "real_chain_bars_15m",
      spreadAssumptions: spread as unknown as Record<string, number>,
      config: { ...canonical, label: cfg.label ?? null },
      configHash,
      windowVariantCount: prior.length + 1,
      universeSource: cfg.universe && cfg.universe.length ? "cli_override" : "current_table",
      barsFeed: process.env.DATA_FEED ?? "iex",
      status: "running",
    })
    .returning();
  try {
    const sigRows = signalInsertRows(run.id, signals);
    const sigIds: number[] = [];
    for (let i = 0; i < sigRows.length; i += 250) {
      const ins = await db.insert(backtestSignals).values(sigRows.slice(i, i + 250)).returning({ id: backtestSignals.id });
      sigIds.push(...ins.map((r) => r.id));
    }
    const tradeRows = trades.map((t) => ({
      runId: run.id,
      signalId: sigIds[t.signalIndex],
      contractSymbol: t.occ,
      strike: String(t.strike),
      expiry: t.expiry,
      pricingSource: "real_chain_bars_15m",
      entryPremium: String(t.entryAsk),
      exitPremium: String(t.exitBid),
      spreadPctAssumed: String(t.entryAsk < spread.cheapBelow ? spread.halfSpreadPctCheap : spread.halfSpreadPct),
      qty: t.qty,
      entryAt: new Date(t.entryMs),
      exitAt: new Date(t.exitMs),
      exitReason: t.exitReason,
      plUsd: String(t.plUsd),
      returnPct: String(t.entryAsk > 0 ? Math.round((t.plUsd / (t.entryAsk * 100)) * 1000) / 10 : 0),
      fees: String(t.fees),
      notes: { entryHourEt: t.entryHourEt, inPortfolio: t.inPortfolio, portfolioSkip: t.portfolioSkip ?? null },
    }));
    for (let i = 0; i < tradeRows.length; i += 250) await db.insert(backtestTrades).values(tradeRows.slice(i, i + 250));
    await db.update(backtestRuns).set({ status: "complete", signalCount: signals.length, metrics, completedAt: new Date() }).where(eq(backtestRuns.id, run.id));
  } catch (e) {
    await db.update(backtestRuns).set({ status: "failed", error: e instanceof Error ? e.message : String(e) }).where(eq(backtestRuns.id, run.id));
    throw e;
  }
  return { runId: run.id as number | null, configHash, days: days.length, signalCount: signals.length, trades, skips, metrics };
}
