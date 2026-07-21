/**
 * INTRADAY backtest engine (SB 15M, spec §25). Steps through history one
 * COMPLETED 15-minute candle at a time and replays the profile's live gate stack
 * with the SAME code the monitor uses: 4H zones (completed bars only) →
 * empty-space candidate filter → at-boundary check → completed-15m confirmation
 * (`evaluateConfirmation`) → 15m structure filter (`classifyStructure`) →
 * playbook score → reaction-DB prediction (asOf) → sniper engine (intraday).
 * Trades are then simulated with the two-contract ladder against REAL 15-minute
 * historical option bars (probed available on this plan, 9+ months deep), with
 * the spread MODELED as visible config (NBBO history unavailable).
 *
 * Anti-lookahead: every accessor takes the current step time T and serves only
 * bars whose interval COMPLETED at or before T (15m: t+15min <= T; 4h: t+4h <= T;
 * daily: date < the session day). Reaction queries carry asOf=T. Zero model calls
 * (the catalyst gate is stubbed fail-open + labeled). No broker imports; writes
 * ONLY backtest_* tables. Deterministic (no wall-clock, no unseeded randomness).
 */
import { db } from "../../db";
import { backtestRuns, backtestSignals, backtestTrades } from "../../db/schema";
import { and, eq } from "drizzle-orm";
import { getMultiStockBars, getIntradayBars, getOptionBars, type Bar, type OptionBar } from "../alpaca";
import { getProfile } from "../profiles";
import { buildZoneSetups, type ZoneSetup } from "../strategy";
import { classifyAndScore } from "../playbook";
import { indexTrend, type MarketContext } from "../sniper";
import { predict } from "../predict";
import { loadUniverse } from "../scanner";
import { tradingDaysFromBars, barDate } from "./clock";
import { walkForward } from "./outcomes";
import { hashConfig } from "./random";
import { signalInsertRows, type Stage1SignalRecord } from "./engine";
import { DEFAULT_SPREAD, type SpreadConfig, askOf, bidOf, strikeGrid, occSymbol, pickFridayExpiry } from "./pricing";

const MIN_15M = 15 * 60_000;
const MIN_4H = 4 * 60 * 60_000;
const DAY_MS = 86_400_000;
const EOD_FLATTEN_ET_MIN = 15 * 60 + 35; // ~25 min before the close, like live nearClose

export interface IntradayRunConfig {
  profileId: "sb15m";
  from: string;
  to: string;
  universe?: string[];
  seed?: string;
  label?: string;
  dryRun?: boolean; // no DB writes (determinism test)
}

/** ET minutes-since-midnight for a UTC ms timestamp (DST-aware). */
export function etMinutesAt(ms: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

// ---------------------------------------------------------------------------
// Point-in-time intraday data: preloaded arrays, completed-interval slicing.
// ---------------------------------------------------------------------------
class IntradayData {
  constructor(
    readonly bars15: Map<string, Bar[]>,
    readonly bars4h: Map<string, Bar[]>,
    readonly daily: Map<string, Bar[]>,
  ) {}

  /** 15m bars COMPLETED at or before T (t + 15min <= T), most recent last. */
  completed15(sym: string, tMs: number): Bar[] {
    const all = this.bars15.get(sym) ?? [];
    let lo = 0;
    let hi = all.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (Date.parse(all[mid].t) + MIN_15M <= tMs) lo = mid + 1;
      else hi = mid;
    }
    return all.slice(0, lo);
  }

  /** 4h bars COMPLETED at or before T. (The live nightly scan sees settled bars;
   *  a FORMING displacement candle never creates a zone here.) */
  completed4h(sym: string, tMs: number): Bar[] {
    const all = this.bars4h.get(sym) ?? [];
    let lo = 0;
    let hi = all.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (Date.parse(all[mid].t) + MIN_4H <= tMs) lo = mid + 1;
      else hi = mid;
    }
    return all.slice(0, lo);
  }

  /** Daily bars strictly before `day`, optionally windowed (live: getStockBars(sym, 400)). */
  dailyBefore(sym: string, day: string, windowDays?: number): Bar[] {
    const all = this.daily.get(sym) ?? [];
    const upto = all.filter((b) => barDate(b.t) < day);
    if (windowDays == null) return upto;
    const cutoff = barDate(new Date(Date.parse(`${day}T00:00:00Z`) - windowDays * DAY_MS).toISOString());
    return upto.filter((b) => barDate(b.t) >= cutoff);
  }

  /** The day's 15m bars for a symbol (engine tape: steps + forward walks). */
  dayBars15(sym: string, day: string): Bar[] {
    return (this.bars15.get(sym) ?? []).filter((b) => barDate(b.t) === day);
  }
}

async function loadIntraday(symbols: string[], from: string, to: string): Promise<IntradayData> {
  const endDaily = new Date(`${to}T23:59:59Z`);
  const daily = new Map<string, Bar[]>();
  const all = [...new Set([...symbols, "SPY", "QQQ"])];
  for (let i = 0; i < all.length; i += 40) {
    const batch = await getMultiStockBars(all.slice(i, i + 40), 480, endDaily);
    for (const [s, b] of Object.entries(batch)) daily.set(s, b);
  }
  const bars15 = new Map<string, Bar[]>();
  const bars4h = new Map<string, Bar[]>();
  const windowDays = Math.ceil((Date.parse(to) - Date.parse(from)) / DAY_MS) + 10;
  for (const sym of symbols) {
    // 15m: the replay window + a week of left context (confirmation/structure).
    bars15.set(sym, await getIntradayBars(sym, "15Min", (windowDays + 7) * 24 * 60, endDaily));
    // 4h: ~1 year (scanner parity, SCAN_LOOKBACK_MIN["4h"]).
    bars4h.set(sym, await getIntradayBars(sym, "4Hour", 365 * 24 * 60, endDaily));
  }
  return new IntradayData(bars15, bars4h, daily);
}

// ---------------------------------------------------------------------------
// The profile's ladder simulated against REAL 15m option bars. Pure — exported
// for the self-test. Conservative within-bar ordering: the stop is checked
// before the profit targets (order inside a bar is unknowable); close-based
// events (optional 15m invalidation) resolve at the bar END, after both.
// SB 15M (2026-07-21 spec) runs ONE contract: rung 1 is a stop RATCHET at +40%
// with no sell (trim1Qty 0), and the whole contract exits at +100%.
// ---------------------------------------------------------------------------
export interface LadderSimInput {
  entryAsk: number;
  qty: number; // contracts filled
  direction: "call" | "put";
  zone: { bottom: number; top: number };
  entryMs: number; // fill moment — only bars AFTER this simulate
  optionBars: OptionBar[]; // the contract's real 15m bars (entry day)
  underlying15: Bar[]; // the day's underlying 15m bars
  spread: SpreadConfig;
  stopLoss: number; // -0.2 (original stop, off the fill)
  trim1Pct: number; // rung 1 level (SB 15M: +0.4 — ratchet only)
  trim1Qty?: number; // contracts sold at rung 1 (SB 15M: 0 => hold, just ratchet)
  stopAfterTrim1?: number; // stop once rung 1 prints (default 0 = breakeven)
  runnerTakeProfit: number; // final target (SB 15M: +1.0, sells everything)
  invalidate15m?: boolean; // close through the zone exits (NOT in the SB 15M spec)
}
export interface LadderSimResult {
  sells: { qty: number; price: number; reason: string; atMs: number }[];
  t1Hit: boolean;
  t2Hit: boolean;
  breakevenExit: boolean;
  stopOut: boolean;
  exitReason: string; // final close reason
  exitMs: number;
  plUsd: number; // net of fees
  fees: number;
}

export function simulateLadder(inp: LadderSimInput): LadderSimResult {
  const { spread } = inp;
  const sells: LadderSimResult["sells"] = [];
  let qty = inp.qty;
  let stop = inp.stopLoss; // ratchets to 0 (breakeven) after trim1
  let t1Hit = false;
  let t2Hit = false;
  let breakevenExit = false;
  let stopOut = false;
  let exitReason = "";
  let exitMs = inp.entryMs;
  let lastBid = bidOf(inp.entryAsk, spread); // fallback mark until a real bar prints
  const under = new Map(inp.underlying15.map((b) => [b.t, b]));

  const sell = (n: number, price: number, reason: string, atMs: number) => {
    sells.push({ qty: n, price: Math.max(0.01, Math.round(price * 100) / 100), reason, atMs });
    qty -= n;
    exitReason = reason;
    exitMs = atMs;
  };

  for (const ob of inp.optionBars) {
    if (qty <= 0) break;
    const barStart = Date.parse(ob.t);
    if (barStart < inp.entryMs) continue; // pre-entry bars are not tradeable
    const barEnd = barStart + MIN_15M;
    lastBid = bidOf(ob.c, spread);

    // 1. Stop first (conservative): the option's real intraday low breaching the
    //    ratcheted stop sells EVERYTHING remaining.
    const stopPremium = inp.entryAsk * (1 + stop);
    if (bidOf(ob.l, spread) <= stopPremium) {
      const fill = stopPremium * (1 - spread.stopSlippagePct);
      if (stop === 0) breakevenExit = true;
      else stopOut = true;
      sell(qty, fill, stop === 0 ? "breakeven_stop" : `stop_${Math.round(stop * 100)}%`, barEnd);
      break;
    }
    // 2. Rung 1: the stop ratchets (never loosens) the moment +trim1Pct prints;
    //    a contract is sold only if the rung actually has a sell size. SB 15M's
    //    +40% rung is a ratchet ONLY — the spec is explicit that it is not a
    //    profit-take.
    const trim1Qty = inp.trim1Qty ?? 1;
    if (!t1Hit && bidOf(ob.h, spread) >= inp.entryAsk * (1 + inp.trim1Pct)) {
      t1Hit = true;
      stop = inp.stopAfterTrim1 ?? 0;
      if (trim1Qty > 0 && qty > trim1Qty) {
        sell(trim1Qty, inp.entryAsk * (1 + inp.trim1Pct), `trim1_+${Math.round(inp.trim1Pct * 100)}%`, barEnd);
      }
    }
    // 3. Final target: everything still open at +runnerTakeProfit (same bar allowed —
    //    a bar spanning both levels realistically fills both).
    if (qty > 0 && bidOf(ob.h, spread) >= inp.entryAsk * (1 + inp.runnerTakeProfit)) {
      t2Hit = true;
      sell(qty, inp.entryAsk * (1 + inp.runnerTakeProfit), `target_+${Math.round(inp.runnerTakeProfit * 100)}%`, barEnd);
      break;
    }
    // 4. Optional structural invalidation at the bar END: the COMPLETED underlying
    //    15m candle closed through the zone against the trade. OFF for SB 15M —
    //    its spec's only exits are the stop, breakeven, +100% and the close.
    const ub = inp.invalidate15m ? under.get(ob.t) : undefined;
    if (qty > 0 && ub && ((inp.direction === "call" && ub.c < inp.zone.bottom) || (inp.direction === "put" && ub.c > inp.zone.top))) {
      sell(qty, bidOf(ob.c, spread), "15m_invalidation", barEnd);
      break;
    }
    // 5. End-of-day flatten (~25 min before the close, every day — day trades only).
    if (qty > 0 && etMinutesAt(barEnd) >= EOD_FLATTEN_ET_MIN) {
      sell(qty, bidOf(ob.c, spread), "eod_flatten", barEnd);
      break;
    }
  }
  if (qty > 0) {
    // Option bars ran out (thin contract late in the day) — flatten at the last real bid.
    sell(qty, lastBid, "data_end", exitMs || inp.entryMs);
  }

  const fees = inp.spread.feePerContractRoundTrip * inp.qty;
  const proceeds = sells.reduce((s, x) => s + x.price * x.qty, 0);
  const plUsd = Math.round((proceeds - inp.entryAsk * inp.qty) * 100 * 100) / 100 - fees;
  return { sells, t1Hit, t2Hit, breakevenExit, stopOut, exitReason, exitMs, plUsd: Math.round(plUsd * 100) / 100, fees };
}

// ---------------------------------------------------------------------------
// The replay.
// ---------------------------------------------------------------------------
export interface IntradayTradeRecord {
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
  exitReason: string;
  plUsd: number;
  fees: number;
  t1Hit: boolean;
  t2Hit: boolean;
  breakevenExit: boolean;
  stopOut: boolean;
  score: number;
  marketAligned: "aligned" | "neutral" | "opposed";
  inPortfolio: boolean;
}

export interface IntradayResult {
  runId: number | null;
  configHash: string;
  windowVariantCount: number;
  days: number;
  signalCount: number;
  signals: Stage1SignalRecord[];
  trades: IntradayTradeRecord[];
  skips: Record<string, number>;
  metrics: Record<string, unknown>;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Time-aware portfolio sim: live caps (3/day + maxOpen) applied in entry order. */
export function intradayPortfolio(trades: IntradayTradeRecord[], maxPerDay: number, maxOpen: number, startEquity = 1000) {
  const byDay = new Map<string, number>();
  const open: { exitMs: number }[] = [];
  const taken: IntradayTradeRecord[] = [];
  for (const t of [...trades].sort((a, b) => a.entryMs - b.entryMs)) {
    for (let i = open.length - 1; i >= 0; i--) if (open[i].exitMs <= t.entryMs) open.splice(i, 1);
    const n = byDay.get(t.day) ?? 0;
    if (n >= maxPerDay || open.length >= maxOpen) continue;
    byDay.set(t.day, n + 1);
    open.push({ exitMs: t.exitMs });
    t.inPortfolio = true;
    taken.push(t);
  }
  let equity = startEquity;
  let peak = startEquity;
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
  return { taken: taken.length, pl: round2(taken.reduce((a, t) => a + t.plUsd, 0)), endEquity: equity, maxDrawdown, worstStreak };
}

function tradeStats(trades: IntradayTradeRecord[]) {
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
    t1RatePct: n ? Math.round((trades.filter((t) => t.t1Hit).length / n) * 1000) / 10 : null,
    t2RatePct: n ? Math.round((trades.filter((t) => t.t2Hit).length / n) * 1000) / 10 : null,
    breakevenAfterT1Pct: (() => {
      const t1 = trades.filter((t) => t.t1Hit);
      return t1.length ? Math.round((t1.filter((t) => t.breakevenExit).length / t1.length) * 1000) / 10 : null;
    })(),
    stopRatePct: n ? Math.round((trades.filter((t) => t.stopOut).length / n) * 1000) / 10 : null,
  };
}

function groupStats(trades: IntradayTradeRecord[], key: (t: IntradayTradeRecord) => string) {
  const groups = new Map<string, IntradayTradeRecord[]>();
  for (const t of trades) {
    const k = key(t);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  return [...groups.entries()]
    .map(([k, xs]) => ({ key: k, n: xs.length, netPl: round2(xs.reduce((a, t) => a + t.plUsd, 0)), winRate: Math.round((xs.filter((t) => t.plUsd > 0).length / xs.length) * 1000) / 10 }))
    .sort((a, b) => b.n - a.n);
}

export async function runIntraday(cfg: IntradayRunConfig): Promise<IntradayResult> {
  const profile = getProfile(cfg.profileId);
  if (profile.id !== "sb15m") throw new Error("intraday replay currently supports sb15m only");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cfg.from) || !/^\d{4}-\d{2}-\d{2}$/.test(cfg.to) || cfg.from > cfg.to) {
    throw new Error(`bad window ${cfg.from}..${cfg.to}`);
  }
  const universe = (cfg.universe && cfg.universe.length ? cfg.universe : await loadUniverse(profile.id)).slice().sort();
  if (universe.length === 0) throw new Error("empty sb15m universe");

  const spread = DEFAULT_SPREAD;
  const L = profile.exit.ladder!;
  const canonical = {
    profileId: profile.id,
    from: cfg.from,
    to: cfg.to,
    granularity: "intraday",
    universe,
    seed: cfg.seed ?? "",
    constants: {
      entryWindowEt: profile.entryWindowEt,
      eodFlattenEtMin: EOD_FLATTEN_ET_MIN,
      entry: "empty_space_boundary_tap",
      ladder: { stopLoss: profile.exit.stopLoss, rungs: L.rungs, runnerTakeProfit: L.runnerTakeProfit ?? 1.0 },
      caps: { maxPerDay: profile.caps.maxTradesPerDay ?? 3, maxOpen: profile.caps.maxOpenPositions, budget: profile.caps.perTradeBudget, maxContracts: profile.caps.maxContracts },
      contract: profile.contract,
      spread,
    },
  };
  const configHash = hashConfig(canonical);

  const data = await loadIntraday(universe, cfg.from, cfg.to);
  const spyDaily = data.daily.get("SPY") ?? [];
  const days = tradingDaysFromBars(spyDaily, cfg.from, cfg.to);
  if (days.length === 0) throw new Error("no trading days in window");

  const signals: Stage1SignalRecord[] = [];
  const trades: IntradayTradeRecord[] = [];
  const skips: Record<string, number> = {};
  const skip = (why: string) => (skips[why] = (skips[why] ?? 0) + 1);
  const win = profile.entryWindowEt ?? { startMin: 0, endMin: 24 * 60 };

  for (const day of days) {
    // Market context: same daily 90d window the live monitor uses.
    let marketCtx: MarketContext = { spy: 0, qqq: 0 };
    try {
      marketCtx = { spy: indexTrend(data.dailyBefore("SPY", day, 90)), qqq: indexTrend(data.dailyBefore("QQQ", day, 90)) };
    } catch {
      /* neutral */
    }
    const seenToday = new Set<string>();

    for (const sym of universe) {
      const dayBars = data.dayBars15(sym, day);
      if (dayBars.length < 2) continue;
      const daily400 = data.dailyBefore(sym, day, 400);
      let zoneCacheCount = -1;
      let setups: ZoneSetup[] = [];

      for (let bi = 0; bi < dayBars.length; bi++) {
        const b = dayBars[bi];
        const T = Date.parse(b.t) + MIN_15M; // this candle's COMPLETION moment
        const etMin = etMinutesAt(T);
        if (etMin < win.startMin || etMin > win.endMin) continue;

        // Zones rebuild only when a new 4h bar has completed (they can't change otherwise).
        const b4 = data.completed4h(sym, T);
        if (b4.length < 60) break;
        if (b4.length !== zoneCacheCount) {
          zoneCacheCount = b4.length;
          try {
            setups = buildZoneSetups(b4, profile.strategy, profile.watchPerTimeframe ?? 1);
          } catch {
            setups = [];
          }
        }

        for (const setup of setups) {
          const z = setup.active_zone;
          const direction = setup.direction;
          if (!z || !direction || setup.distance_to_edge_pct == null) continue;
          if (profile.requireClearRunway !== false && !setup.clear_runway) continue; // empty space HARD gate
          const zoneKey = `${sym}|${z.bottom.toFixed(4)}|${z.top.toFixed(4)}|${direction}`;
          if (seenToday.has(zoneKey)) continue;

          // ---- THE ENTRY (2026-07-21 spec): the TAP of the boundary facing price.
          // No confirmation candle, no structure read, no score, no model — the
          // live monitor's `emptySpaceTap` rules, evaluated per completed candle:
          //   * the candle must have COME FROM empty space (opened outside the zone
          //     on the facing side), and
          //   * its excursion must have REACHED the boundary but not run deep inside
          //     it (gap-through / already-accepted cases are skipped), and
          //   * the previous completed candle must not have closed through the zone.
          const cur = b.c;
          const boundary = direction === "call" ? z.top : z.bottom;
          const fromEmptySpace = direction === "call" ? b.o > boundary : b.o < boundary;
          if (!fromEmptySpace) continue;
          const excursion = direction === "call" ? boundary - b.l : b.h - boundary;
          if (excursion < 0) continue; // never reached the level in this candle
          const height = Math.max(0, z.top - z.bottom);
          const maxPen = Math.min(Math.max(height * 0.25, boundary * 0.0006), boundary * 0.004);
          if (excursion > maxPen) {
            skip("gapped_through_or_deep_inside");
            continue;
          }
          const prevBar = bi > 0 ? dayBars[bi - 1] : undefined;
          if (prevBar && ((direction === "call" && prevBar.c < z.bottom) || (direction === "put" && prevBar.c > z.top))) {
            skip("price_accepted_through_zone");
            continue;
          }
          // Playbook score + reaction-DB prediction are still computed, but PURELY as
          // MEASUREMENT (report groupings / target for the underlying outcome) — they
          // gate nothing, exactly like the live path.
          let pb: ReturnType<typeof classifyAndScore>;
          try {
            pb = classifyAndScore(daily400, z, direction, cur);
          } catch {
            continue;
          }
          const marketAlign = ((marketCtx.spy + marketCtx.qqq) / 2) * (direction === "call" ? 1 : -1);
          const pred = await predict(sym, cur, "4h", direction, setup.approach ?? "", marketAlign, new Date(T));

          seenToday.add(zoneKey);
          const next = dayBars[bi + 1];
          const entry = next ? next.o : b.c; // fill at the next bar's open (live buys right after the candle completes)
          const entryMs = next ? Date.parse(next.t) : T;

          const outcome = walkForward(entry, direction, pred.targetMain ?? pb.safeTarget, z, dayBars.slice(bi + 1), dayBars.length);
          const sig: Stage1SignalRecord = {
            symbol: sym,
            firedAt: new Date(entryMs),
            day,
            direction,
            setupKind: "tap",
            playbookType: pb.playbook,
            score: pb.score,
            zoneBottom: z.bottom,
            zoneTop: z.top,
            tappedEdge: setup.tapped_edge,
            approach: setup.approach,
            entryUnderlying: round2(entry),
            entryApprox: false, // real next-15m-bar open, not a boundary guess
            gapThrough: false,
            statedTarget: pred.targetMain ?? pb.safeTarget,
            statedProbability: pred.probability,
            statedConfidence: pb.score, // no confidence engine in this profile — the score is descriptive only
            statedSampleSize: pred.sampleSize,
            statedHoldBars: pred.expectedHoldBars,
            predictionBucket: null,
            gates: {
              scan: "replayed_4h_completed_bars",
              entry_window: "replayed",
              empty_space: "replayed_clear_runway",
              boundary_tap: "replayed_per_completed_15m_candle",
              gap_through_guard: "replayed",
              acceptance_guard: "replayed",
              confirmation: "none_in_strategy",
              score_gate: "none_in_strategy",
              sniper_engine: "none_in_strategy",
              catalyst: "none_in_strategy",
              prediction: "measurement_only_asof",
            },
            wouldTradeLive: true, // provisional — the portfolio sim decides
            outcome,
          };
          const sigIndex = signals.length;
          signals.push(sig);

          // ---- Options: real 15m chain at the entry moment -------------------
          const expiry = pickFridayExpiry(day, 1);
          const strikes = strikeGrid(entry, direction, profile.contract.otmPct, profile.contract.itmPct);
          const occs = strikes.map((k) => occSymbol(sym, expiry, direction, k));
          let chain: Record<string, OptionBar[]> = {};
          try {
            chain = await getOptionBars(occs, day, day, "15Min");
          } catch {
            skip("chain_fetch_failed");
            continue;
          }
          const priced = occs
            .map((occ, i) => {
              const bars = chain[occ] ?? [];
              // the contract's latest 15m bar completed at or before entry
              const at = bars.filter((ob) => Date.parse(ob.t) + MIN_15M <= entryMs).at(-1);
              return at ? { occ, strike: strikes[i], at, bars } : null;
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
          const qty = Math.max(1, Math.min(profile.caps.maxContracts, Math.floor(profile.caps.perTradeBudget / (chosen.ask * 100))));

          const rung1 = L.rungs?.[0];
          const sim = simulateLadder({
            entryAsk: chosen.ask,
            qty,
            direction,
            zone: z,
            entryMs,
            optionBars: chosen.bars,
            underlying15: dayBars,
            spread,
            stopLoss: profile.exit.stopLoss,
            trim1Pct: rung1?.atPct ?? L.trim1Pct,
            trim1Qty: rung1 ? rung1.sellQty : L.trim1Qty,
            stopAfterTrim1: rung1?.stopTo ?? L.stopAfterTrim1,
            runnerTakeProfit: L.runnerTakeProfit ?? 1.0,
            invalidate15m: profile.exit.invalidateOn15mClose === true,
          });
          const align = marketAlign > 0.1 ? "aligned" : marketAlign < -0.1 ? "opposed" : "neutral";
          trades.push({
            signalIndex: sigIndex,
            symbol: sym,
            direction,
            day,
            entryMs,
            entryHourEt: Math.floor(etMinutesAt(entryMs) / 60),
            occ: chosen.occ,
            strike: chosen.strike,
            expiry,
            qty,
            entryAsk: chosen.ask,
            exitMs: sim.exitMs,
            exitReason: sim.exitReason,
            plUsd: sim.plUsd,
            fees: sim.fees,
            t1Hit: sim.t1Hit,
            t2Hit: sim.t2Hit,
            breakevenExit: sim.breakevenExit,
            stopOut: sim.stopOut,
            score: pb.score,
            marketAligned: align,
            inPortfolio: false,
          });
        }
      }
    }
  }

  const portfolio = intradayPortfolio(trades, profile.caps.maxTradesPerDay ?? 3, profile.caps.maxOpenPositions);
  for (const s of signals) s.wouldTradeLive = false;
  for (const t of trades) if (t.inPortfolio) signals[t.signalIndex].wouldTradeLive = true;

  const metrics = {
    intraday: {
      allTrades: tradeStats(trades),
      portfolio: { ...portfolio, stats: tradeStats(trades.filter((t) => t.inPortfolio)) },
      skips,
      byTicker: groupStats(trades, (t) => t.symbol),
      byHourEt: groupStats(trades, (t) => `${t.entryHourEt}:00`),
      // Descriptive only — the strategy has no score gate, so the full range appears.
      byScore: groupStats(trades, (t) => (t.score >= 90 ? "90+" : t.score >= 75 ? "75-89" : t.score >= 60 ? "60-74" : "<60")),
      byDirection: groupStats(trades, (t) => t.direction),
      byAlignment: groupStats(trades, (t) => t.marketAligned),
      byExitReason: groupStats(trades, (t) => t.exitReason),
      assumptions: {
        pricing: "REAL 15-minute historical option bars (Alpaca, incl. expired contracts); NBBO history unavailable -> spread MODELED (visible config)",
        entryFill: "next 15m bar open (underlying) / contract's last completed 15m vwap + half-spread at that moment",
        withinBarOrder: "stop checked before profit targets (conservative); 15m invalidation resolves at bar end",
        eodFlatten: "15:35 ET, matching live nearClose (~25 min before close)",
        spread,
      },
    },
  };

  if (cfg.dryRun) {
    return { runId: null, configHash, windowVariantCount: 0, days: days.length, signalCount: signals.length, signals, trades, skips, metrics };
  }

  const prior = await db
    .select({ id: backtestRuns.id })
    .from(backtestRuns)
    .where(and(eq(backtestRuns.profileId, profile.id), eq(backtestRuns.fromDate, cfg.from), eq(backtestRuns.toDate, cfg.to)));
  const windowVariantCount = prior.length + 1;
  const [run] = await db
    .insert(backtestRuns)
    .values({
      profileId: profile.id,
      stage: 2,
      fromDate: cfg.from,
      toDate: cfg.to,
      granularity: "intraday",
      pricingPath: "real_chain_bars_15m",
      spreadAssumptions: spread as unknown as Record<string, number>,
      config: { ...canonical, label: cfg.label ?? null },
      configHash,
      windowVariantCount,
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
      exitPremium: null, // multi-leg exits — see notes.sells
      spreadPctAssumed: String(t.entryAsk < spread.cheapBelow ? spread.halfSpreadPctCheap : spread.halfSpreadPct),
      qty: t.qty,
      entryAt: new Date(t.entryMs),
      exitAt: new Date(t.exitMs),
      exitReason: t.exitReason,
      plUsd: String(t.plUsd),
      returnPct: String(t.entryAsk > 0 ? Math.round((t.plUsd / (t.entryAsk * 100 * t.qty)) * 1000) / 10 : 0),
      fees: String(t.fees),
      notes: { t1Hit: t.t1Hit, t2Hit: t.t2Hit, breakevenExit: t.breakevenExit, stopOut: t.stopOut, entryHourEt: t.entryHourEt, marketAligned: t.marketAligned, score: t.score, inPortfolio: t.inPortfolio },
    }));
    for (let i = 0; i < tradeRows.length; i += 250) await db.insert(backtestTrades).values(tradeRows.slice(i, i + 250));
    await db.update(backtestRuns).set({ status: "complete", signalCount: signals.length, metrics, completedAt: new Date() }).where(eq(backtestRuns.id, run.id));
  } catch (e) {
    await db.update(backtestRuns).set({ status: "failed", error: e instanceof Error ? e.message : String(e) }).where(eq(backtestRuns.id, run.id));
    throw e;
  }
  return { runId: run.id, configHash, windowVariantCount, days: days.length, signalCount: signals.length, signals, trades, skips, metrics };
}
