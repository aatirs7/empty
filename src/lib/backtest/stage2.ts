/**
 * Stage 2 — options P&L simulation (vega-backtest-spec.md), SBv2 (flip_retest /
 * price-first) profiles. Re-runs the EXACT Stage 1 replay for signals, then for
 * each signal selects a contract off the REAL historical chain (Path A: Alpaca
 * /v1beta1/options/bars serves expired contracts; probed 2026-07-20) and
 * simulates SBv2's live exit rules against real traded option prices, with a
 * MODELED spread (historical NBBO is unavailable) as visible config.
 *
 * Fill realism (spec): buy at ask (vwap + half-spread), sell at bid; stop exits
 * take extra slippage; a day with no printed bar / too few trades = unfillable.
 * Exit-timing approximations at daily granularity are labeled per trade and in
 * the report. Sensitivity: the whole exit sim is re-run at 1.5x and 2x spread.
 *
 * GUARDRAILS: no broker imports, writes ONLY backtest_* tables, zero model calls.
 */
import { db } from "../../db";
import { backtestRuns, backtestSignals, backtestTrades } from "../../db/schema";
import { and, eq } from "drizzle-orm";
import type { OptionBar } from "../alpaca";
import { replaySignals, signalInsertRows, spyBaseline, type Stage1SignalRecord, type BacktestableProfileId } from "./engine";
import { barDate, sessionCloseUtc } from "./clock";
import { hashConfig } from "./random";
import { selectContractPriceFirst, askOf, bidOf, DEFAULT_SPREAD, type SpreadConfig, type SelectedContract } from "./pricing";
import type { Bar } from "../alpaca";
import { getProfile } from "../profiles";

export interface Stage2Config {
  profileId: BacktestableProfileId; // sbv2 only for now (price-first path)
  from: string;
  to: string;
  universe?: string[];
  seed?: string;
  label?: string;
}

export interface SimTrade {
  signalIndex: number; // index into the replay's signal array
  symbol: string;
  direction: "call" | "put";
  day: string;
  occ: string;
  strike: number;
  expiry: string;
  qty: number;
  entryAsk: number;
  exitDay: string;
  exitBid: number;
  exitReason: string;
  plUsd: number; // net of fees, per the modeled fills
  returnPct: number;
  fees: number;
  inPortfolio: boolean; // survived daily-cap + open-position caps in the account sim
  notes: Record<string, unknown>;
}

export interface Stage2Result {
  runId: number;
  configHash: string;
  windowVariantCount: number;
  signalCount: number;
  trades: SimTrade[];
  skips: Record<string, number>;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Simulate SBv2's live exit rules for one filled contract against real bars.
 *  Priority mirrors manageExits' swing branch: stop → invalidation → target →
 *  catastrophe → salvage. Conservative same-day ordering: the stop is checked
 *  (on the option's intraday low) BEFORE the target (underlying touch). */
export function simulateSwingExit(opts: {
  entryAsk: number;
  direction: "call" | "put";
  target: number | null;
  zone: { bottom: number; top: number };
  strike: number;
  expiry: string;
  entryDay: string;
  optionBars: OptionBar[]; // entry day .. expiry (real)
  underlyingBars: Bar[]; // covering entry day .. expiry
  spread: SpreadConfig;
  swingStopLoss: number | null; // -0.5 (SBv2); null = no mid-swing stop (SBv1, deliberate)
  catastropheFloor: number; // 0.10
  catastropheDays: number; // 2
}): { exitDay: string; exitBid: number; exitReason: string } {
  const obByDay = new Map(opts.optionBars.map((b) => [barDate(b.t), b]));
  const under = opts.underlyingBars.filter((b) => barDate(b.t) >= opts.entryDay && barDate(b.t) <= opts.expiry);
  const stopPremium = opts.swingStopLoss != null ? opts.entryAsk * (1 + opts.swingStopLoss) : null;
  let lastKnownBid = bidOf(opts.entryAsk, opts.spread);
  let lastDay = opts.entryDay;
  let prevClose: number | null = null;

  for (const ub of under) {
    const day = barDate(ub.t);
    const ob = obByDay.get(day);
    const dte = Math.round((Date.parse(`${opts.expiry}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
    if (ob) {
      lastKnownBid = bidOf(ob.c, opts.spread);
      lastDay = day;
    }
    const isEntryDay = day === opts.entryDay;

    // 1. Premium stop (live checks each minute on the bid). Intraday proxy: the
    //    option's real day LOW. Entry day is skipped (the low may predate entry).
    //    SBv1 has NO mid-swing stop (deliberate) — stopPremium is null there.
    if (stopPremium != null && !isEntryDay && ob && bidOf(ob.l, opts.spread) <= stopPremium) {
      // fill near the threshold, minus fast-move slippage
      return { exitDay: day, exitBid: round2(Math.max(0.01, stopPremium * (1 - opts.spread.stopSlippagePct))), exitReason: `stop_${Math.round((opts.swingStopLoss ?? 0) * 100)}%` };
    }
    // 2. Swing invalidation: live observes YESTERDAY's close through the zone and
    //    sells during today. (prevClose is null on the entry day.)
    if (prevClose != null && (opts.direction === "call" ? prevClose < opts.zone.bottom : prevClose > opts.zone.top)) {
      const px = ob ? bidOf(ob.vw, opts.spread) : lastKnownBid;
      return { exitDay: day, exitBid: round2(px), exitReason: "swing_invalidation" };
    }
    // 3. Target: the underlying touches the persisted DB target intraday → sell
    //    around that day's real traded average (vwap, bid side). Entry day too —
    //    live would sell the same session if the move completes immediately.
    if (opts.target != null && (opts.direction === "call" ? ub.h >= opts.target : ub.l <= opts.target)) {
      const px = ob ? bidOf(ob.vw, opts.spread) : lastKnownBid;
      return { exitDay: day, exitBid: round2(px), exitReason: "target" };
    }
    // 4. Catastrophe floor near expiry.
    if (ob && dte <= opts.catastropheDays && bidOf(ob.c, opts.spread) <= opts.catastropheFloor) {
      return { exitDay: day, exitBid: round2(bidOf(ob.c, opts.spread)), exitReason: "catastrophe" };
    }
    // 5. Expiry salvage.
    if (dte <= 1) {
      const px = ob ? bidOf(ob.c, opts.spread) : lastKnownBid;
      return { exitDay: day, exitBid: round2(px), exitReason: "expiry_salvage" };
    }
    prevClose = ub.c; // today's close participates in tomorrow's invalidation check
  }

  // Ran out of bars (halt/missing data): mark at the last known real bid.
  return { exitDay: lastDay, exitBid: round2(lastKnownBid), exitReason: "data_end" };
}

interface TradeSimOutput {
  trades: SimTrade[];
  skips: Record<string, number>;
}

/** Run the per-signal contract selection + exit sim under one spread config. */
async function simulateTrades(
  signals: Stage1SignalRecord[],
  underlyingBySymbol: (sym: string) => Bar[],
  profileId: BacktestableProfileId,
  spread: SpreadConfig,
  selections: Map<number, SelectedContract | null>, // signalIndex -> selection cache
): Promise<TradeSimOutput> {
  const profile = getProfile(profileId);
  const exitCfg = {
    // null = no mid-swing stop (SBv1's deliberate behavior); SBv2 sets -0.5 explicitly.
    swingStopLoss: profile.exit.swingStopLoss ?? null,
    catastropheFloor: profile.exit.catastropheFloor ?? 0.1,
    catastropheDays: profile.exit.catastropheDays ?? 2,
  };
  const trades: SimTrade[] = [];
  const skips: Record<string, number> = {};
  const skip = (why: string) => (skips[why] = (skips[why] ?? 0) + 1);

  for (let i = 0; i < signals.length; i++) {
    const s = signals[i];
    let sel = selections.get(i);
    if (sel === undefined) {
      try {
        sel = await selectContractPriceFirst({
          symbol: s.symbol,
          direction: s.direction,
          entryDay: s.day,
          spot: s.entryUnderlying,
          otmPct: profile.contract.otmPct,
          itmPct: profile.contract.itmPct,
          priceFloor: profile.contract.priceFloor,
          priceIdeal: profile.contract.priceIdeal,
          priceCap: profile.contract.priceCap,
          // Live: SBv2 resolve uses minDays 2 (a Thu tap buys NEXT Friday); SBv1's
          // weekly picker takes the nearest Friday >= 1 day out.
          minDays: profile.entryKind === "flip_retest" ? 2 : 1,
          spread,
        });
      } catch {
        sel = null;
      }
      selections.set(i, sel);
    }
    if (!sel) {
      skip("no_contract_in_band");
      continue;
    }
    // Re-price entry under THIS spread config (sensitivity reruns keep the same
    // contract, worse fills — the question is whether the edge survives).
    const ask = round2(askOf(sel.entryBar.vw, spread));
    const qty = 1; // SBv2: maxContracts 1 ("just get one")
    const exit = simulateSwingExit({
      entryAsk: ask,
      direction: s.direction,
      target: s.statedTarget,
      zone: { bottom: s.zoneBottom, top: s.zoneTop },
      strike: sel.strike,
      expiry: sel.expiry,
      entryDay: s.day,
      optionBars: sel.bars,
      underlyingBars: underlyingBySymbol(s.symbol),
      spread,
      ...exitCfg,
    });
    const fees = spread.feePerContractRoundTrip * qty;
    const plUsd = round2((exit.exitBid - ask) * 100 * qty - fees);
    trades.push({
      signalIndex: i,
      symbol: s.symbol,
      direction: s.direction,
      day: s.day,
      occ: sel.occ,
      strike: sel.strike,
      expiry: sel.expiry,
      qty,
      entryAsk: ask,
      exitDay: exit.exitDay,
      exitBid: exit.exitBid,
      exitReason: exit.exitReason,
      plUsd,
      returnPct: ask > 0 ? Math.round(((exit.exitBid - ask) / ask) * 1000) / 10 : 0,
      fees,
      inPortfolio: false, // set by the portfolio sim
      notes: { entryFill: "vwap+halfSpread", candidatesTried: sel.candidatesTried },
    });
  }
  return { trades, skips };
}

/** Account sim: apply live caps in chronological order; equity curve + drawdown. */
export function portfolioSim(trades: SimTrade[], maxPerDay: number, maxOpen: number, startEquity = 1000) {
  const byDay = new Map<string, number>();
  const open: { exitDay: string }[] = [];
  const taken: SimTrade[] = [];
  for (const t of trades) {
    // release positions that exited before this entry day
    for (let i = open.length - 1; i >= 0; i--) if (open[i].exitDay < t.day) open.splice(i, 1);
    const todayCount = byDay.get(t.day) ?? 0;
    if (todayCount >= maxPerDay || open.length >= maxOpen) continue;
    byDay.set(t.day, todayCount + 1);
    open.push({ exitDay: t.exitDay });
    t.inPortfolio = true;
    taken.push(t);
  }
  const pl = taken.reduce((a, t) => a + t.plUsd, 0);
  // Equity curve on exit days (realized-only, daily granularity).
  const events = [...taken].sort((a, b) => (a.exitDay < b.exitDay ? -1 : 1));
  let equity = startEquity;
  let peak = startEquity;
  let maxDrawdown = 0;
  let streak = 0;
  let worstStreak = 0;
  const curve: { day: string; equity: number }[] = [];
  for (const t of events) {
    equity = round2(equity + t.plUsd);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, round2(equity - peak));
    streak = t.plUsd < 0 ? streak + 1 : 0;
    worstStreak = Math.max(worstStreak, streak);
    curve.push({ day: t.exitDay, equity });
  }
  return { taken: taken.length, pl: round2(pl), endEquity: equity, maxDrawdown, worstStreak, curve };
}

function tradeStats(trades: SimTrade[]) {
  const n = trades.length;
  const wins = trades.filter((t) => t.plUsd > 0);
  const losses = trades.filter((t) => t.plUsd <= 0);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const dist: Record<string, number> = {};
  for (const t of trades) {
    const b = t.returnPct <= -75 ? "-100..-75" : t.returnPct <= -50 ? "-75..-50" : t.returnPct <= -25 ? "-50..-25" : t.returnPct <= 0 ? "-25..0" : t.returnPct <= 50 ? "0..+50" : t.returnPct <= 100 ? "+50..+100" : "+100+";
    dist[b] = (dist[b] ?? 0) + 1;
  }
  const byReason: Record<string, { n: number; pl: number }> = {};
  for (const t of trades) {
    byReason[t.exitReason] = { n: (byReason[t.exitReason]?.n ?? 0) + 1, pl: round2((byReason[t.exitReason]?.pl ?? 0) + t.plUsd) };
  }
  return {
    n,
    netPl: round2(trades.reduce((a, t) => a + t.plUsd, 0)),
    winRate: n ? Math.round((wins.length / n) * 1000) / 10 : null,
    avgWinUsd: mean(wins.map((t) => t.plUsd)),
    avgLossUsd: mean(losses.map((t) => t.plUsd)),
    avgWinPct: mean(wins.map((t) => t.returnPct)),
    avgLossPct: mean(losses.map((t) => t.returnPct)),
    returnDistribution: dist,
    byExitReason: byReason,
  };
}

export async function runStage2(cfg: Stage2Config): Promise<Stage2Result> {
  if (cfg.profileId !== "sbv2" && cfg.profileId !== "sniper_swing") {
    throw new Error("Stage 2 supports sbv2 and sniper_swing (SBv1). sb15m uses the intraday engine.");
  }
  const replay = await replaySignals({ profileId: cfg.profileId, from: cfg.from, to: cfg.to, granularity: "daily", universe: cfg.universe, seed: cfg.seed });
  const { signals, data, profile } = replay;

  const spreadBase = DEFAULT_SPREAD;
  const canonical = { ...replay.canonical, stage: 2, pricing: { path: "real_chain_bars", spread: spreadBase } };
  const configHash = hashConfig(canonical);
  const underlying = (sym: string) => data.allBars(sym);

  // Per-signal sim under the base spread, then sensitivity reruns (same
  // contracts, wider spreads) — spec: "see if the edge survives".
  const selections = new Map<number, SelectedContract | null>();
  const base = await simulateTrades(signals, underlying, cfg.profileId, spreadBase, selections);
  const widen = (m: number): SpreadConfig => ({
    ...spreadBase,
    halfSpreadPct: spreadBase.halfSpreadPct * m,
    halfSpreadPctCheap: spreadBase.halfSpreadPctCheap * m,
    minHalfSpread: spreadBase.minHalfSpread * m,
    stopSlippagePct: spreadBase.stopSlippagePct * m,
  });
  const sens15 = await simulateTrades(signals, underlying, cfg.profileId, widen(1.5), selections);
  const sens20 = await simulateTrades(signals, underlying, cfg.profileId, widen(2), selections);

  const maxPerDay = profile.caps.maxTradesPerDay ?? 3;
  const portfolio = portfolioSim(base.trades, maxPerDay, profile.caps.maxOpenPositions);
  const portfolioTrades = base.trades.filter((t) => t.inPortfolio);
  const spy = spyBaseline(data, cfg.from, cfg.to);

  const prior = await db
    .select({ id: backtestRuns.id })
    .from(backtestRuns)
    .where(and(eq(backtestRuns.profileId, cfg.profileId), eq(backtestRuns.fromDate, cfg.from), eq(backtestRuns.toDate, cfg.to)));
  const windowVariantCount = prior.length + 1;

  const [run] = await db
    .insert(backtestRuns)
    .values({
      profileId: cfg.profileId,
      stage: 2,
      fromDate: cfg.from,
      toDate: cfg.to,
      granularity: "daily",
      pricingPath: "real_chain_bars",
      spreadAssumptions: spreadBase as unknown as Record<string, number>,
      config: { ...canonical, label: cfg.label ?? null },
      configHash,
      windowVariantCount,
      universeSource: cfg.universe && cfg.universe.length ? "cli_override" : "current_table",
      barsFeed: "iex",
      status: "running",
    })
    .returning();

  try {
    // Persist the signals (same rows a Stage 1 run writes) so trades can FK them.
    const sigRows = signalInsertRows(run.id, signals);
    const sigIds: number[] = [];
    for (let i = 0; i < sigRows.length; i += 250) {
      const inserted = await db.insert(backtestSignals).values(sigRows.slice(i, i + 250)).returning({ id: backtestSignals.id });
      sigIds.push(...inserted.map((r) => r.id));
    }
    const tradeRows = base.trades.map((t) => ({
      runId: run.id,
      signalId: sigIds[t.signalIndex],
      contractSymbol: t.occ,
      strike: String(t.strike),
      expiry: t.expiry,
      pricingSource: "real_chain_bars",
      ivUsed: null,
      entryPremium: String(t.entryAsk),
      exitPremium: String(t.exitBid),
      spreadPctAssumed: String(t.entryAsk < spreadBase.cheapBelow ? spreadBase.halfSpreadPctCheap : spreadBase.halfSpreadPct),
      qty: t.qty,
      entryAt: sessionCloseUtc(t.day),
      exitAt: sessionCloseUtc(t.exitDay),
      exitReason: t.exitReason,
      plUsd: String(t.plUsd),
      returnPct: String(t.returnPct),
      fees: String(t.fees),
      notes: { ...t.notes, inPortfolio: t.inPortfolio },
    }));
    for (let i = 0; i < tradeRows.length; i += 250) await db.insert(backtestTrades).values(tradeRows.slice(i, i + 250));

    const metrics = {
      stage2: {
        allSignals: tradeStats(base.trades),
        portfolio: { ...portfolio, stats: tradeStats(portfolioTrades) },
        skips: base.skips,
        sensitivity: {
          "spread_x1.5": tradeStats(sens15.trades),
          "spread_x2.0": tradeStats(sens20.trades),
        },
        spy,
        assumptions: {
          pricing: "real historical option daily bars (Alpaca, incl. expired contracts); NBBO history unavailable -> spread MODELED",
          entryFill: "buy at day VWAP + half-spread on the tap day (intraday tap moment unpriceable at daily bars)",
          exitFills: "target/invalidation at day VWAP bid; stop at threshold minus slippage; catastrophe/salvage at close bid",
          sameDayOrder: "stop checked before target (conservative); entry-day stop not checked (pre-entry low ambiguity)",
          contractSelection:
            cfg.profileId === "sniper_swing"
              ? "APPROXIMATED: live SBv1 ranks by EV using live greeks (unavailable historically) — replay picks by the profile's price band ($0.40-1.00, ideal $0.75) over the real chain"
              : "live-mirrored price-first band selection over the real chain",
          exitRules: cfg.profileId === "sniper_swing" ? "SBv1: NO mid-swing stop (deliberate); invalidation/target/catastrophe/salvage only" : "SBv2: -50% stop + invalidation/target/catastrophe/salvage",
          spread: spreadBase,
        },
      },
    };
    await db
      .update(backtestRuns)
      .set({ status: "complete", signalCount: signals.length, metrics, completedAt: new Date() })
      .where(eq(backtestRuns.id, run.id));
  } catch (e) {
    await db
      .update(backtestRuns)
      .set({ status: "failed", error: e instanceof Error ? e.message : String(e) })
      .where(eq(backtestRuns.id, run.id));
    throw e;
  }

  return { runId: run.id, configHash, windowVariantCount, signalCount: signals.length, trades: base.trades, skips: base.skips };
}
