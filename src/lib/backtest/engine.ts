/**
 * Stage 1 replay engine (vega-backtest-spec.md): underlying-signal backtest.
 * Steps day by day through history, runs the SAME setup/gate code the live
 * system uses against point-in-time data, records every signal the strategy
 * would have fired, then walks forward to record what actually happened.
 *
 * GUARDRAILS:
 * - No broker, no order placement, no live trade tables — writes ONLY backtest_*.
 * - Zero model calls. The live Claude gates (SBv1 catalyst, SBv2 news veto) are
 *   stubbed FAIL-OPEN and labeled per signal, matching live's fail-open default.
 * - All probabilities/targets come from the reaction DB with asOf filtering.
 * - Deterministic: no Date.now/Math.random — the random baseline is seeded from
 *   the config hash.
 */
import { db } from "../../db";
import { backtestRuns, backtestSignals } from "../../db/schema";
import { and, eq } from "drizzle-orm";
import { getProfile, type Profile } from "../profiles";
import { buildZoneSetups, buildFlipSetupsDetailed, type ZoneSetup } from "../strategy";
import { classifyAndScore } from "../playbook";
import { evaluateSniper, type MarketContext } from "../sniper";
import { loadUniverse } from "../scanner";
import type { Bar } from "../alpaca";
import { PointInTimeData, type StrategyView } from "./data";
import { tradingDaysFromBars, sessionCloseUtc, barDate } from "./clock";
import { walkForward, DEFAULT_HORIZON, type SignalOutcome } from "./outcomes";
import { hashConfig, mulberry32, fnv1a } from "./random";

// Mirrored live constants (monitor.ts keeps them private). Recorded in the run
// config so a report is interpretable without reading code.
const FLIP_TAP_BAND = 0.004; // SBv2: within 0.4% of the flipped boundary
const AT_ZONE_LO = 0.99; // SBv1: at-zone band = [bottom*0.99, top*1.01]
const AT_ZONE_HI = 1.01;
// The 5-min confirmation candle cannot be evaluated at daily granularity. Its
// executionScore feeds a hard sniper-engine threshold (>=45), so a neutral
// assumed value is used and LABELED. This makes SBv1 signal counts an
// approximation — stated on every report.
const ASSUMED_EXEC_SCORE = 60;
const RANDOM_K = 200; // random-baseline entries per real signal
const MIN_BARS = 60; // scanner parity: skip symbols with too little history

export type BacktestableProfileId = "sniper_swing" | "sbv2";

export interface Stage1RunConfig {
  profileId: BacktestableProfileId;
  from: string; // YYYY-MM-DD inclusive
  to: string;
  granularity: "daily";
  universe?: string[]; // override; default = the profile's current universe table
  seed?: string; // extra entropy folded into the config hash
  label?: string;
  dryRun?: boolean; // no DB writes (determinism self-test)
}

export interface Stage1SignalRecord {
  symbol: string;
  firedAt: Date;
  day: string;
  direction: "call" | "put";
  setupKind: "tap" | "flip";
  playbookType: string | null;
  score: number | null;
  zoneBottom: number;
  zoneTop: number;
  tappedEdge: number | null;
  approach: string | null;
  entryUnderlying: number;
  entryApprox: boolean;
  gapThrough: boolean;
  statedTarget: number | null;
  statedProbability: number | null;
  statedConfidence: number | null;
  statedSampleSize: number | null;
  statedHoldBars: number | null;
  predictionBucket: string | null;
  gates: Record<string, string>;
  wouldTradeLive: boolean;
  outcome: SignalOutcome;
}

export interface Stage1Baselines {
  randomN: number;
  randomTargetTouchedRate: number | null;
  randomRet1d: number | null;
  randomRet3d: number | null;
  randomRet5d: number | null;
  randomRet10d: number | null;
  spyReturnPct: number | null; // buy-and-hold over the window
  spyAnnualizedVolPct: number | null;
  windowCharacter: string; // trending up / down / choppy (from SPY)
}

export interface Stage1Result {
  runId: number | null; // null on dryRun
  configHash: string;
  windowVariantCount: number;
  days: number;
  symbols: number;
  signalCount: number;
  signals: Stage1SignalRecord[];
  baselines: Stage1Baselines;
}

const NO_ZONE = { bottom: -1e18, top: 1e18 }; // never-invalidating zone (random baseline)
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Extract the widening-tier bucket from predict()'s reason string (display only). */
function bucketFromReason(reason: string): string | null {
  const m = /reactions \(([^)]+)\)/.exec(reason);
  return m ? m[1] : null;
}

interface DayEval {
  signal?: Omit<Stage1SignalRecord, "outcome" | "wouldTradeLive">;
}

/** Evaluate one SBv1 (sniper_swing) symbol for the current day — live gate order. */
async function evalSniperSwing(
  profile: Profile,
  sym: string,
  view: StrategyView,
  today: Bar,
  marketCtx: MarketContext,
  day: string,
  seenZones: Set<string>,
): Promise<DayEval> {
  const hist = view.bars(sym); // scanner-equivalent: full history to yesterday
  if (hist.length < MIN_BARS) return {};
  let setups: ZoneSetup[];
  try {
    setups = buildZoneSetups(hist, profile.strategy, profile.watchPerTimeframe ?? 1);
  } catch {
    return {};
  }
  for (const setup of setups) {
    const z = setup.active_zone;
    const direction = setup.direction;
    if (!z || !direction || setup.distance_to_edge_pct == null) continue;
    if (profile.requireClearRunway !== false && !setup.clear_runway) continue; // monitor candidate filter

    // Live trigger: price within [bottom*0.99, top*1.01]. Daily approximation:
    // today's range overlapped the band.
    const lo = z.bottom * AT_ZONE_LO;
    const hi = z.top * AT_ZONE_HI;
    if (!(today.l <= hi && today.h >= lo)) continue;

    const zoneKey = `${sym}|${z.bottom.toFixed(4)}|${z.top.toFixed(4)}|${direction}`;
    if (seenZones.has(zoneKey)) continue; // first-touch semantics: one signal per zone per run
    seenZones.add(zoneKey);

    const edge = setup.tapped_edge ?? (direction === "call" ? z.top : z.bottom);
    const entry = Math.min(Math.max(edge, today.l), today.h); // nearest traded price to the edge
    const gapThrough = direction === "call" ? today.o < lo : today.o > hi;

    const bars400 = view.bars(sym, 400); // live: getStockBars(sym, 400)
    let pb: ReturnType<typeof classifyAndScore>;
    try {
      pb = classifyAndScore(bars400, z, direction, entry);
    } catch {
      continue; // live: "could not score; skipped"
    }
    if (pb.score < profile.minScore) continue; // playbook score gate

    const marketAlign = ((marketCtx.spy + marketCtx.qqq) / 2) * (direction === "call" ? 1 : -1);
    const pred = await view.prediction(sym, entry, "daily", direction, setup.approach ?? "", marketAlign);
    if (profile.minProbability != null && pred.probability < profile.minProbability) continue;

    const ev = evaluateSniper(pb, bars400, direction, ASSUMED_EXEC_SCORE, setup.clear_runway, marketCtx, pred, false);
    if (!ev.passed) continue;
    // catalyst gate: stubbed fail-open (labeled)

    return {
      signal: {
        symbol: sym,
        firedAt: sessionCloseUtc(day),
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
        entryApprox: true,
        gapThrough,
        statedTarget: pred.targetMain ?? pb.safeTarget,
        statedProbability: pred.probability,
        statedConfidence: ev.overall,
        statedSampleSize: pred.sampleSize,
        statedHoldBars: pred.expectedHoldBars,
        predictionBucket: bucketFromReason(pred.reason),
        gates: {
          scan: "replayed_daily_rebuild",
          trigger: "at_zone_band_daily",
          confirmation: `approximated_daily(exec=${ASSUMED_EXEC_SCORE})`,
          score_gate: "replayed",
          prediction: "replayed_asof",
          sniper_engine: "replayed",
          catalyst: "stubbed_open",
        },
      },
    };
  }
  return {};
}

/** Evaluate one SBv2 (flip retest) symbol for the current day — live gate order. */
async function evalSbv2(
  profile: Profile,
  sym: string,
  view: StrategyView,
  today: Bar,
  marketCtx: MarketContext,
  day: string,
  seenZones: Set<string>,
): Promise<DayEval> {
  const hist = view.bars(sym);
  if (hist.length < MIN_BARS) return {};
  let setups: ZoneSetup[];
  try {
    setups = buildFlipSetupsDetailed(hist, profile.strategy, profile.watchPerTimeframe ?? 1).setups;
  } catch {
    return {};
  }
  for (const setup of setups) {
    const z = setup.active_zone;
    const direction = setup.direction;
    const boundary = setup.flipped_boundary;
    if (!z || !direction || !boundary || !setup.setup_valid) continue;

    // Live trigger: |cur - boundary| / boundary <= FLIP_TAP_BAND. Daily
    // approximation: today's range reached the band around the boundary.
    const lo = boundary * (1 - FLIP_TAP_BAND);
    const hi = boundary * (1 + FLIP_TAP_BAND);
    if (!(today.l <= hi && today.h >= lo)) continue;

    const zoneKey = `${sym}|${z.bottom.toFixed(4)}|${z.top.toFixed(4)}|${direction}`;
    if (seenZones.has(zoneKey)) continue; // first retest only (flips also self-drop next day)
    seenZones.add(zoneKey);

    const entry = Math.min(Math.max(boundary, today.l), today.h);
    const gapThrough = direction === "call" ? today.o < lo : today.o > hi;

    const bars400 = view.bars(sym, 400);
    let pb: ReturnType<typeof classifyAndScore> | null;
    try {
      pb = classifyAndScore(bars400, z, direction, entry);
    } catch {
      continue; // live: "could not read the chart" skip
    }
    // Mechanical entry: NO score gate, NO sniper engine (live parity).
    // scan-age guard: replay rebuilds the scan fresh each day → always 0d old.
    const marketAlign = ((marketCtx.spy + marketCtx.qqq) / 2) * (direction === "call" ? 1 : -1);
    const pred = await view.prediction(sym, entry, "daily", direction, setup.approach ?? "", marketAlign);
    // news veto: stubbed fail-open (labeled). intel layer: OFF (labeled).
    if (pred.targetMain == null) continue; // live: "no DB target" skip

    return {
      signal: {
        symbol: sym,
        firedAt: sessionCloseUtc(day),
        day,
        direction,
        setupKind: "flip",
        playbookType: pb.playbook,
        score: pb.score,
        zoneBottom: z.bottom,
        zoneTop: z.top,
        tappedEdge: boundary,
        approach: setup.approach,
        entryUnderlying: round2(entry),
        entryApprox: true,
        gapThrough,
        statedTarget: pred.targetMain,
        statedProbability: pred.probability,
        statedConfidence: pred.probability,
        statedSampleSize: pred.sampleSize,
        statedHoldBars: pred.expectedHoldBars,
        predictionBucket: bucketFromReason(pred.reason),
        gates: {
          scan: "replayed_daily_rebuild",
          trigger: "flip_tap_band_daily",
          scan_age: "replayed(always_fresh)",
          news_veto: "stubbed_open",
          db_target: "replayed_asof",
          intel: "off",
        },
      },
    };
  }
  return {};
}

/** Deterministic random-entry baseline: K entries per real signal on the same
 *  symbol/direction with the target at the same % distance, on random window days. */
function randomBaseline(
  signals: Stage1SignalRecord[],
  data: PointInTimeData,
  days: string[],
  seedHex: string,
): Omit<Stage1Baselines, "spyReturnPct" | "spyAnnualizedVolPct" | "windowCharacter"> {
  const rng = mulberry32(fnv1a(`baseline:${seedHex}`));
  let n = 0;
  let touched = 0;
  const rets: Record<"r1" | "r3" | "r5" | "r10", number[]> = { r1: [], r3: [], r5: [], r10: [] };
  for (const sig of signals) {
    if (sig.statedTarget == null) continue;
    const distPct = (sig.statedTarget - sig.entryUnderlying) / sig.entryUnderlying;
    const bars = data.allBars(sig.symbol);
    if (bars.length === 0) continue;
    const byDay = new Map(bars.map((b, i) => [barDate(b.t), i]));
    for (let k = 0; k < RANDOM_K; k++) {
      // draw a random trading day in the window that has a bar + >=1 forward bar
      let idx: number | null = null;
      for (let attempt = 0; attempt < 20 && idx == null; attempt++) {
        const d = days[Math.floor(rng() * days.length)];
        const i = byDay.get(d);
        if (i != null && i + 1 < bars.length) idx = i;
      }
      if (idx == null) continue;
      const entry = bars[idx].c;
      const target = entry * (1 + distPct);
      const out = walkForward(entry, sig.direction, target, NO_ZONE, bars.slice(idx + 1, idx + 1 + DEFAULT_HORIZON));
      n += 1;
      if (out.targetTouched) touched += 1;
      if (out.ret1d != null) rets.r1.push(out.ret1d);
      if (out.ret3d != null) rets.r3.push(out.ret3d);
      if (out.ret5d != null) rets.r5.push(out.ret5d);
      if (out.ret10d != null) rets.r10.push(out.ret10d);
    }
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    randomN: n,
    randomTargetTouchedRate: n ? touched / n : null,
    randomRet1d: mean(rets.r1),
    randomRet3d: mean(rets.r3),
    randomRet5d: mean(rets.r5),
    randomRet10d: mean(rets.r10),
  };
}

function spyBaseline(data: PointInTimeData, from: string, to: string): Pick<Stage1Baselines, "spyReturnPct" | "spyAnnualizedVolPct" | "windowCharacter"> {
  const spy = data.allBars("SPY").filter((b) => barDate(b.t) >= from && barDate(b.t) <= to);
  if (spy.length < 2) return { spyReturnPct: null, spyAnnualizedVolPct: null, windowCharacter: "unknown" };
  const ret = (spy[spy.length - 1].c - spy[0].c) / spy[0].c;
  const daily = spy.slice(1).map((b, i) => (b.c - spy[i].c) / spy[i].c);
  const mu = daily.reduce((a, b) => a + b, 0) / daily.length;
  const vol = Math.sqrt(daily.reduce((a, b) => a + (b - mu) ** 2, 0) / daily.length) * Math.sqrt(252);
  const character = Math.abs(ret) < 0.02 ? "choppy/flat" : ret > 0 ? (ret > 0.06 ? "strong uptrend" : "uptrend") : ret < -0.06 ? "strong downtrend" : "downtrend";
  return {
    spyReturnPct: Math.round(ret * 1e4) / 100,
    spyAnnualizedVolPct: Math.round(vol * 1e4) / 100,
    windowCharacter: `${character} (vol ${Math.round(vol * 100)}% ann.)`,
  };
}

export async function runStage1(cfg: Stage1RunConfig): Promise<Stage1Result> {
  if (cfg.granularity !== "daily") throw new Error("only granularity=daily is implemented (Stage 2+)");
  const profile = getProfile(cfg.profileId);
  if (profile.id !== "sniper_swing" && profile.id !== "sbv2") {
    throw new Error(`profile ${cfg.profileId} is not Stage-1 backtestable`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cfg.from) || !/^\d{4}-\d{2}-\d{2}$/.test(cfg.to) || cfg.from > cfg.to) {
    throw new Error(`bad window ${cfg.from}..${cfg.to}`);
  }

  const universe = (cfg.universe && cfg.universe.length ? cfg.universe : await loadUniverse(profile.id)).slice().sort();
  if (universe.length === 0) throw new Error(`empty universe for ${profile.id}`);

  // Full canonical config — hashed for determinism + stored for reproducibility.
  const canonical = {
    profileId: profile.id,
    from: cfg.from,
    to: cfg.to,
    granularity: cfg.granularity,
    universe,
    seed: cfg.seed ?? "",
    constants: {
      FLIP_TAP_BAND,
      AT_ZONE_LO,
      AT_ZONE_HI,
      ASSUMED_EXEC_SCORE,
      RANDOM_K,
      HORIZON: DEFAULT_HORIZON,
      MIN_BARS,
      maxTradesPerDay: profile.caps.maxTradesPerDay ?? 3,
    },
    profileSnapshot: {
      strategy: profile.strategy,
      minScore: profile.minScore,
      minProbability: profile.minProbability ?? null,
      watchPerTimeframe: profile.watchPerTimeframe ?? 1,
      requireClearRunway: profile.requireClearRunway !== false,
      setupKind: profile.setupKind ?? "tap",
      entryKind: profile.entryKind ?? "tap",
    },
    barsFeed: "iex",
  };
  const configHash = hashConfig(canonical);

  const data = await PointInTimeData.load({
    symbols: [...universe, "SPY", "QQQ"],
    from: cfg.from,
    to: cfg.to,
  });
  const days = tradingDaysFromBars(data.allBars("SPY"), cfg.from, cfg.to);
  if (days.length === 0) throw new Error(`no trading days in ${cfg.from}..${cfg.to}`);

  const maxPerDay = profile.caps.maxTradesPerDay ?? 3;
  const seenZones = new Set<string>();
  const signals: Stage1SignalRecord[] = [];

  for (const day of days) {
    data.advanceTo(day);
    const view = data.view();
    const marketCtx = view.marketContext();
    let firedToday = 0;
    for (const sym of universe) {
      const today = data.todayBar(sym);
      if (!today) continue;
      const evald =
        profile.id === "sbv2"
          ? await evalSbv2(profile, sym, view, today, marketCtx, day, seenZones)
          : await evalSniperSwing(profile, sym, view, today, marketCtx, day, seenZones);
      if (!evald.signal) continue;
      const s = evald.signal;
      const outcome = walkForward(
        s.entryUnderlying,
        s.direction,
        s.statedTarget,
        { bottom: s.zoneBottom, top: s.zoneTop },
        data.futureBars(sym, DEFAULT_HORIZON),
      );
      // Daily trade cap only — the open-position cap needs exit simulation (Stage 2).
      const wouldTradeLive = firedToday < maxPerDay;
      firedToday += 1;
      signals.push({ ...s, wouldTradeLive, outcome });
    }
  }

  const baselines: Stage1Baselines = {
    ...randomBaseline(signals, data, days, `${configHash}:${cfg.seed ?? ""}`),
    ...spyBaseline(data, cfg.from, cfg.to),
  };

  if (cfg.dryRun) {
    return { runId: null, configHash, windowVariantCount: 0, days: days.length, symbols: universe.length, signalCount: signals.length, signals, baselines };
  }

  // Overfitting tracker: how many runs (variants) have targeted this profile+window.
  const prior = await db
    .select({ id: backtestRuns.id })
    .from(backtestRuns)
    .where(and(eq(backtestRuns.profileId, profile.id), eq(backtestRuns.fromDate, cfg.from), eq(backtestRuns.toDate, cfg.to)));
  const windowVariantCount = prior.length + 1;

  const [run] = await db
    .insert(backtestRuns)
    .values({
      profileId: profile.id,
      stage: 1,
      fromDate: cfg.from,
      toDate: cfg.to,
      granularity: "daily",
      pricingPath: "none",
      config: { ...canonical, label: cfg.label ?? null },
      configHash,
      windowVariantCount,
      universeSource: cfg.universe && cfg.universe.length ? "cli_override" : "current_table",
      barsFeed: "iex",
      status: "running",
    })
    .returning();

  try {
    const rows = signals.map((s) => ({
      runId: run.id,
      symbol: s.symbol,
      firedAt: s.firedAt,
      direction: s.direction,
      setupKind: s.setupKind,
      playbookType: s.playbookType,
      score: s.score,
      zoneBottom: String(s.zoneBottom),
      zoneTop: String(s.zoneTop),
      tappedEdge: s.tappedEdge != null ? String(s.tappedEdge) : null,
      approach: s.approach,
      entryUnderlying: String(s.entryUnderlying),
      entryApprox: s.entryApprox,
      gapThrough: s.gapThrough,
      statedTarget: s.statedTarget != null ? String(s.statedTarget) : null,
      statedProbability: s.statedProbability,
      statedConfidence: s.statedConfidence,
      statedSampleSize: s.statedSampleSize,
      statedHoldBars: s.statedHoldBars,
      predictionBucket: s.predictionBucket,
      gates: s.gates,
      wouldTradeLive: s.wouldTradeLive,
      targetHit: s.outcome.targetHit,
      barsToTarget: s.outcome.barsToTarget,
      invalidated: s.outcome.invalidated,
      invalidatedAtBar: s.outcome.invalidatedAtBar,
      invalidatedFirst: s.outcome.invalidatedFirst,
      tie: s.outcome.tie,
      mfePct: String(s.outcome.mfePct),
      maePct: String(s.outcome.maePct),
      ret1d: s.outcome.ret1d != null ? String(s.outcome.ret1d) : null,
      ret2d: s.outcome.ret2d != null ? String(s.outcome.ret2d) : null,
      ret3d: s.outcome.ret3d != null ? String(s.outcome.ret3d) : null,
      ret5d: s.outcome.ret5d != null ? String(s.outcome.ret5d) : null,
      ret10d: s.outcome.ret10d != null ? String(s.outcome.ret10d) : null,
      forwardBars: s.outcome.forwardBars,
      outcomeStatus: s.outcome.outcomeStatus,
    }));
    for (let i = 0; i < rows.length; i += 500) await db.insert(backtestSignals).values(rows.slice(i, i + 500));

    await db
      .update(backtestRuns)
      .set({
        status: "complete",
        signalCount: signals.length,
        metrics: { baselines },
        completedAt: new Date(),
      })
      .where(eq(backtestRuns.id, run.id));
  } catch (e) {
    await db
      .update(backtestRuns)
      .set({ status: "failed", error: e instanceof Error ? e.message : String(e) })
      .where(eq(backtestRuns.id, run.id));
    throw e;
  }

  return { runId: run.id, configHash, windowVariantCount, days: days.length, symbols: universe.length, signalCount: signals.length, signals, baselines };
}
