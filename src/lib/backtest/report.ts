/**
 * Stage 1 backtest report (vega-backtest-spec.md §Stage 1 output metrics).
 * Reads a completed run from backtest_runs/backtest_signals, computes the
 * metrics, and renders console text. Every report carries the mandatory
 * header (window, pricing path, assumptions, N) and the honest-limitations
 * footer — a backtest number without those is not interpretable.
 */
import { db } from "../../db";
import { backtestRuns, backtestSignals } from "../../db/schema";
import { eq } from "drizzle-orm";
import type { Stage1Baselines } from "./engine";

interface SigRow {
  symbol: string;
  direction: string;
  playbookType: string | null;
  statedProbability: number | null;
  statedHoldBars: number | null;
  wouldTradeLive: boolean;
  targetHit: boolean | null;
  barsToTarget: number | null;
  invalidated: boolean | null;
  tie: boolean | null;
  gapThrough: boolean;
  mfePct: number;
  maePct: number;
  ret1d: number | null;
  ret3d: number | null;
  ret5d: number | null;
  ret10d: number | null;
  outcomeStatus: string;
}

export interface Stage1Report {
  runId: number;
  header: Record<string, string | number>;
  n: number;
  hitRateAll: number | null;
  hitRateCapConstrained: number | null;
  calibration: { bucket: string; n: number; statedMid: number; realizedPct: number | null }[];
  timing: { statedMedianBars: number | null; realizedMedianBars: number | null };
  mae: { p25: number; p50: number; p75: number; p90: number; winners: number | null; losers: number | null } | null;
  meanRets: { r1: number | null; r3: number | null; r5: number | null; r10: number | null };
  baselines: Stage1Baselines | null;
  perPlaybook: { playbook: string; n: number; hitRatePct: number | null }[];
  tieRatePct: number | null;
  gapThroughRatePct: number | null;
  truncated: number;
  limitations: string[];
}

const pct = (x: number | null) => (x == null ? "—" : `${Math.round(x * 1000) / 10}%`);
const pctile = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]): number | null => (xs.length ? pctile(xs, 0.5) : null);

/** The spec's six honest limitations, verbatim in spirit, plus run-specific labels. */
function limitationLines(variantCount: number, granLabels: string[]): string[] {
  return [
    `Hindsight/overfitting risk: variants tested against this exact window so far: ${variantCount}. The more variants, the more likely the winner is noise.`,
    "One regime: this window is ONE market environment — a strategy that works here may fail in the opposite regime (see window character above).",
    "Modeled pricing error: n/a in Stage 1 (no options priced) — Stage 2 Path B estimates can be materially off for cheap OTM contracts.",
    "Fill optimism: entries are boundary-touch approximations at daily granularity — live fills are worse, especially on fast taps.",
    "Sample size: treat small-N results as directional at best; N is stated above.",
    "Backtest ≠ forward result: passing earns a strategy the right to be paper traded, not to be funded.",
    ...granLabels,
  ];
}

export async function buildStage1Report(runId: number): Promise<Stage1Report> {
  const [run] = await db.select().from(backtestRuns).where(eq(backtestRuns.id, runId));
  if (!run) throw new Error(`backtest run ${runId} not found`);
  const raw = await db.select().from(backtestSignals).where(eq(backtestSignals.runId, runId));
  const sigs: SigRow[] = raw.map((r) => ({
    symbol: r.symbol,
    direction: r.direction,
    playbookType: r.playbookType,
    statedProbability: r.statedProbability,
    statedHoldBars: r.statedHoldBars,
    wouldTradeLive: r.wouldTradeLive,
    targetHit: r.targetHit,
    barsToTarget: r.barsToTarget,
    invalidated: r.invalidated,
    tie: r.tie,
    gapThrough: r.gapThrough,
    mfePct: Number(r.mfePct ?? 0),
    maePct: Number(r.maePct ?? 0),
    ret1d: r.ret1d != null ? Number(r.ret1d) : null,
    ret3d: r.ret3d != null ? Number(r.ret3d) : null,
    ret5d: r.ret5d != null ? Number(r.ret5d) : null,
    ret10d: r.ret10d != null ? Number(r.ret10d) : null,
    outcomeStatus: r.outcomeStatus,
  }));

  const n = sigs.length;
  const hits = sigs.filter((s) => s.targetHit === true);
  const capSigs = sigs.filter((s) => s.wouldTradeLive);
  const hitRateAll = n ? hits.length / n : null;
  const hitRateCap = capSigs.length ? capSigs.filter((s) => s.targetHit === true).length / capSigs.length : null;

  // Calibration: stated probability buckets vs realized hit rate.
  const buckets = [
    { bucket: "<50", lo: 0, hi: 50, mid: 45 },
    { bucket: "50-60", lo: 50, hi: 60, mid: 55 },
    { bucket: "60-70", lo: 60, hi: 70, mid: 65 },
    { bucket: "70-80", lo: 70, hi: 80, mid: 75 },
    { bucket: "80+", lo: 80, hi: 101, mid: 85 },
  ];
  const calibration = buckets.map((b) => {
    const inB = sigs.filter((s) => s.statedProbability != null && s.statedProbability >= b.lo && s.statedProbability < b.hi);
    const hit = inB.filter((s) => s.targetHit === true).length;
    return { bucket: b.bucket, n: inB.length, statedMid: b.mid, realizedPct: inB.length ? Math.round((hit / inB.length) * 1000) / 10 : null };
  });

  const timing = {
    statedMedianBars: median(sigs.map((s) => s.statedHoldBars).filter((x): x is number => x != null)),
    realizedMedianBars: median(hits.map((s) => s.barsToTarget).filter((x): x is number => x != null)),
  };

  const maes = sigs.map((s) => s.maePct);
  const mae = n
    ? {
        p25: pctile(maes, 0.25),
        p50: pctile(maes, 0.5),
        p75: pctile(maes, 0.75),
        p90: pctile(maes, 0.9),
        winners: mean(hits.map((s) => s.maePct)),
        losers: mean(sigs.filter((s) => s.targetHit !== true).map((s) => s.maePct)),
      }
    : null;

  const meanRets = {
    r1: mean(sigs.map((s) => s.ret1d).filter((x): x is number => x != null)),
    r3: mean(sigs.map((s) => s.ret3d).filter((x): x is number => x != null)),
    r5: mean(sigs.map((s) => s.ret5d).filter((x): x is number => x != null)),
    r10: mean(sigs.map((s) => s.ret10d).filter((x): x is number => x != null)),
  };

  const byPb = new Map<string, SigRow[]>();
  for (const s of sigs) {
    const k = s.playbookType ?? "unknown";
    byPb.set(k, [...(byPb.get(k) ?? []), s]);
  }
  const perPlaybook = [...byPb.entries()]
    .map(([playbook, xs]) => ({
      playbook,
      n: xs.length,
      hitRatePct: xs.length ? Math.round((xs.filter((s) => s.targetHit === true).length / xs.length) * 1000) / 10 : null,
    }))
    .sort((a, b) => b.n - a.n);

  const metrics = (run.metrics ?? {}) as { baselines?: Stage1Baselines };
  const cfg = (run.config ?? {}) as { constants?: Record<string, number>; label?: string | null };
  const granLabels = [
    "Granularity approximations (labeled per signal): entries at boundary-touch prices; 5-min confirmation gate approximated (SBv1); Claude gates (catalyst/news) stubbed FAIL-OPEN so signal counts are an upper bound; SBv2 intel layer OFF; universe is TODAY'S list (survivorship); bars are the free IEX feed.",
  ];

  const report: Stage1Report = {
    runId,
    header: {
      profile: run.profileId,
      window: `${run.fromDate} .. ${run.toDate}`,
      granularity: run.granularity,
      pricingPath: `${run.pricingPath} (Stage 1 — underlying only)`,
      barsFeed: run.barsFeed,
      universeSource: run.universeSource,
      signals: run.signalCount ?? n,
      configHash: run.configHash,
      variantOfWindow: `#${run.windowVariantCount}`,
      label: cfg.label ?? "",
    },
    n,
    hitRateAll,
    hitRateCapConstrained: hitRateCap,
    calibration,
    timing,
    mae,
    meanRets,
    baselines: metrics.baselines ?? null,
    perPlaybook,
    tieRatePct: n ? Math.round((sigs.filter((s) => s.tie === true).length / n) * 1000) / 10 : null,
    gapThroughRatePct: n ? Math.round((sigs.filter((s) => s.gapThrough).length / n) * 1000) / 10 : null,
    truncated: sigs.filter((s) => s.outcomeStatus === "truncated").length,
    limitations: limitationLines(run.windowVariantCount, granLabels),
  };

  // Persist the computed summary on the run row (idempotent re-render safe).
  await db
    .update(backtestRuns)
    .set({
      metrics: {
        ...(metrics as Record<string, unknown>),
        summary: {
          hitRateAll,
          hitRateCapConstrained: hitRateCap,
          calibration,
          timing,
          mae,
          meanRets,
          perPlaybook,
          tieRatePct: report.tieRatePct,
          gapThroughRatePct: report.gapThroughRatePct,
        },
      },
      limitations: report.limitations,
    })
    .where(eq(backtestRuns.id, runId));

  return report;
}

// ---------------------------------------------------------------------------
// Stage 2 report — reads the metrics the Stage 2 run persisted (options P&L).
// ---------------------------------------------------------------------------

export interface Stage2TradeStats {
  n: number;
  netPl: number;
  winRate: number | null;
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  returnDistribution: Record<string, number>;
  byExitReason: Record<string, { n: number; pl: number }>;
}

export interface Stage2Report {
  runId: number;
  header: Record<string, string | number>;
  allSignals: Stage2TradeStats;
  portfolio: { taken: number; pl: number; endEquity: number; maxDrawdown: number; worstStreak: number; stats: Stage2TradeStats };
  skips: Record<string, number>;
  sensitivity: Record<string, Stage2TradeStats>;
  spy: { spyReturnPct: number | null; windowCharacter: string };
  assumptions: Record<string, unknown>;
  limitations: string[];
}

export async function buildStage2Report(runId: number): Promise<Stage2Report> {
  const [run] = await db.select().from(backtestRuns).where(eq(backtestRuns.id, runId));
  if (!run) throw new Error(`backtest run ${runId} not found`);
  if (run.stage !== 2) throw new Error(`run ${runId} is stage ${run.stage}, not 2`);
  const m = (run.metrics ?? {}) as { stage2?: Omit<Stage2Report, "runId" | "header" | "limitations"> };
  if (!m.stage2) throw new Error(`run ${runId} has no stage2 metrics (status: ${run.status})`);
  const cfg = (run.config ?? {}) as { label?: string | null };
  const limitations = [
    `Hindsight/overfitting risk: variants tested against this exact window so far: ${run.windowVariantCount}.`,
    "One regime: one market environment — see window character.",
    "PRICING: real historical option bars (Alpaca), but NBBO history is unavailable, so the bid/ask spread is MODELED (visible config) — never presented as real fills.",
    "Fill optimism: entries assume a fill near the tap day's VWAP + half-spread; live fills are worse, especially on fast taps. Sensitivity reruns (1.5x/2x spread) bound this.",
    "Exit timing is approximated at daily granularity (labeled per rule in assumptions).",
    "Claude gates (news veto) were fail-open in the replay — live would have filtered some of these trades.",
    "Sample size: state N; treat small-N results as directional at best.",
    "Backtest ≠ forward result: this earns paper trading, not funding.",
  ];
  const report: Stage2Report = {
    runId,
    header: {
      profile: run.profileId,
      stage: 2,
      window: `${run.fromDate} .. ${run.toDate}`,
      granularity: run.granularity,
      pricingPath: run.pricingPath,
      barsFeed: run.barsFeed,
      universeSource: run.universeSource,
      signals: run.signalCount ?? 0,
      configHash: run.configHash,
      variantOfWindow: `#${run.windowVariantCount}`,
      label: cfg.label ?? "",
    },
    allSignals: m.stage2.allSignals as Stage2TradeStats,
    portfolio: m.stage2.portfolio as Stage2Report["portfolio"],
    skips: (m.stage2.skips ?? {}) as Record<string, number>,
    sensitivity: (m.stage2.sensitivity ?? {}) as Record<string, Stage2TradeStats>,
    spy: m.stage2.spy as Stage2Report["spy"],
    assumptions: (m.stage2.assumptions ?? {}) as Record<string, unknown>,
    limitations,
  };
  await db.update(backtestRuns).set({ limitations }).where(eq(backtestRuns.id, runId));
  return report;
}

const usd0 = (x: number | null | undefined) => (x == null ? "—" : `${x < 0 ? "-" : "+"}$${Math.abs(Math.round(x * 100) / 100)}`);

function statsLines(label: string, s: Stage2TradeStats): string[] {
  return [
    `${label}: n=${s.n} · net P&L ${usd0(s.netPl)} · win rate ${s.winRate ?? "—"}%`,
    `  avg win ${usd0(s.avgWinUsd)} (${s.avgWinPct != null ? Math.round(s.avgWinPct) : "—"}%) vs avg loss ${usd0(s.avgLossUsd)} (${s.avgLossPct != null ? Math.round(s.avgLossPct) : "—"}%)`,
  ];
}

export function renderStage2Report(r: Stage2Report): string {
  const L: string[] = [];
  L.push("=".repeat(72));
  L.push(`BACKTEST STAGE 2 — OPTIONS P&L — run #${r.runId}`);
  for (const [k, v] of Object.entries(r.header)) if (v !== "") L.push(`  ${k}: ${v}`);
  L.push("=".repeat(72));
  L.push("");
  L.push(...statsLines("ALL SIGNALS (every signal that found a fillable contract)", r.allSignals));
  L.push("");
  L.push(`PORTFOLIO SIM (live caps: 3/day, max open) — trades taken: ${r.portfolio.taken}`);
  L.push(`  net P&L ${usd0(r.portfolio.pl)} on a $1000 account → end equity $${r.portfolio.endEquity}`);
  L.push(`  max drawdown ${usd0(r.portfolio.maxDrawdown)} · longest losing streak ${r.portfolio.worstStreak}`);
  L.push(...statsLines("  portfolio trades", r.portfolio.stats));
  L.push("");
  L.push("RETURN DISTRIBUTION (all signals, % on premium):");
  for (const [b, n] of Object.entries(r.allSignals.returnDistribution)) L.push(`  ${b.padEnd(10)} ${n}`);
  L.push("");
  L.push("EXIT REASONS (all signals):");
  for (const [reason, x] of Object.entries(r.allSignals.byExitReason)) L.push(`  ${reason.padEnd(20)} n=${x.n}  P&L ${usd0(x.pl)}`);
  L.push("");
  L.push(`SKIPS (unfillable — no contract in band with a real market): ${JSON.stringify(r.skips)}`);
  L.push("");
  L.push("SENSITIVITY — same trades, worse fills (does the edge survive?):");
  for (const [k, s] of Object.entries(r.sensitivity)) L.push(`  ${k}: net ${usd0(s.netPl)} · win ${s.winRate ?? "—"}%`);
  L.push("");
  L.push(`SPY buy-and-hold over the window: ${r.spy.spyReturnPct != null ? r.spy.spyReturnPct + "%" : "—"} · ${r.spy.windowCharacter}`);
  L.push("");
  L.push("ASSUMPTIONS (visible config — every fill is modeled per these):");
  for (const [k, v] of Object.entries(r.assumptions)) L.push(`  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  L.push("");
  L.push("HONEST LIMITATIONS:");
  for (const l of r.limitations) L.push(`  - ${l}`);
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Intraday (SB 15M) report — spec §25's required metrics, read from run.metrics.
// ---------------------------------------------------------------------------

interface IntradayTradeStats {
  n: number;
  netPl: number;
  winRate: number | null;
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  profitFactor: number | null;
  t1RatePct: number | null;
  t2RatePct: number | null;
  breakevenAfterT1Pct: number | null;
  stopRatePct: number | null;
}
interface GroupStat {
  key: string;
  n: number;
  netPl: number;
  winRate: number;
}

export interface IntradayReport {
  runId: number;
  header: Record<string, string | number>;
  allTrades: IntradayTradeStats;
  portfolio: { taken: number; pl: number; endEquity: number; maxDrawdown: number; worstStreak: number; stats: IntradayTradeStats };
  skips: Record<string, number>;
  byTicker: GroupStat[];
  byHourEt: GroupStat[];
  byScore: GroupStat[];
  byDirection: GroupStat[];
  byAlignment: GroupStat[];
  byExitReason: GroupStat[];
  assumptions: Record<string, unknown>;
  limitations: string[];
}

export async function buildIntradayReport(runId: number): Promise<IntradayReport> {
  const [run] = await db.select().from(backtestRuns).where(eq(backtestRuns.id, runId));
  if (!run) throw new Error(`backtest run ${runId} not found`);
  const m = (run.metrics ?? {}) as { intraday?: Omit<IntradayReport, "runId" | "header" | "limitations"> };
  if (!m.intraday) throw new Error(`run ${runId} has no intraday metrics (status: ${run.status})`);
  const cfg = (run.config ?? {}) as { label?: string | null };
  const limitations = [
    `Hindsight/overfitting risk: variants tested against this exact window so far: ${run.windowVariantCount}.`,
    "One regime: one market environment.",
    "PRICING: real 15-minute historical option bars, but NBBO history is unavailable — the spread is MODELED (visible config).",
    "Within-bar ordering is unknowable at 15m granularity: the stop is checked before the targets (conservative tie rule).",
    "The tap is approximated per COMPLETED 15-minute candle: live fires the instant price touches the boundary, the replay at the end of the candle that touched it.",
    "Fill optimism: entries at next-bar open + vwap-based asks; live fills are worse on fast moves. Live also enters AT the boundary, which can be better or worse than the next bar's open.",
    "Playbook score and reaction-DB prediction are recorded for grouping only — this strategy gates on neither, exactly like the live path.",
    "Sample size: state N; small-N cells (per-ticker, per-hour) are directional at best.",
    "Backtest ≠ forward result: this earns paper trading, not funding.",
  ];
  const report: IntradayReport = {
    runId,
    header: {
      profile: run.profileId,
      stage: "2 (intraday)",
      window: `${run.fromDate} .. ${run.toDate}`,
      granularity: run.granularity,
      pricingPath: run.pricingPath,
      barsFeed: run.barsFeed,
      universeSource: run.universeSource,
      signals: run.signalCount ?? 0,
      configHash: run.configHash,
      variantOfWindow: `#${run.windowVariantCount}`,
      label: cfg.label ?? "",
    },
    allTrades: m.intraday.allTrades as IntradayTradeStats,
    portfolio: m.intraday.portfolio as IntradayReport["portfolio"],
    skips: (m.intraday.skips ?? {}) as Record<string, number>,
    byTicker: (m.intraday.byTicker ?? []) as GroupStat[],
    byHourEt: (m.intraday.byHourEt ?? []) as GroupStat[],
    byScore: (m.intraday.byScore ?? []) as GroupStat[], // descriptive only — no score gate in this strategy
    byDirection: (m.intraday.byDirection ?? []) as GroupStat[],
    byAlignment: (m.intraday.byAlignment ?? []) as GroupStat[],
    byExitReason: (m.intraday.byExitReason ?? []) as GroupStat[],
    assumptions: (m.intraday.assumptions ?? {}) as Record<string, unknown>,
    limitations,
  };
  await db.update(backtestRuns).set({ limitations }).where(eq(backtestRuns.id, runId));
  return report;
}

const money = (x: number | null | undefined) => (x == null ? "—" : `${x < 0 ? "-" : "+"}$${Math.abs(Math.round(x * 100) / 100)}`);

function intradayStatsLines(label: string, s: IntradayTradeStats): string[] {
  return [
    `${label}: n=${s.n} · net ${money(s.netPl)} · win ${s.winRate ?? "—"}% · profit factor ${s.profitFactor ?? "—"}`,
    `  avg win ${money(s.avgWinUsd)} vs avg loss ${money(s.avgLossUsd)} · reached rung 1 ${s.t1RatePct ?? "—"}% · reached the final target ${s.t2RatePct ?? "—"}% · breakeven exit after rung 1 ${s.breakevenAfterT1Pct ?? "—"}% · stopped ${s.stopRatePct ?? "—"}%`,
  ];
}

function groupLines(title: string, rows: GroupStat[]): string[] {
  return [title, ...rows.map((g) => `  ${g.key.padEnd(14)} n=${String(g.n).padStart(4)}  net ${money(g.netPl)}  win ${g.winRate}%`)];
}

export function renderIntradayReport(r: IntradayReport): string {
  const L: string[] = [];
  L.push("=".repeat(72));
  L.push(`BACKTEST — INTRADAY OPTIONS SIM (${String(r.header.profile).toUpperCase()}) — run #${r.runId}`);
  for (const [k, v] of Object.entries(r.header)) if (v !== "") L.push(`  ${k}: ${v}`);
  L.push("=".repeat(72));
  L.push("");
  L.push(...intradayStatsLines("ALL TRADES", r.allTrades));
  L.push("");
  L.push(`PORTFOLIO (live caps): ${r.portfolio.taken} taken · net ${money(r.portfolio.pl)} on $1000 → $${r.portfolio.endEquity} · max DD ${money(r.portfolio.maxDrawdown)} · worst streak ${r.portfolio.worstStreak}`);
  L.push(...intradayStatsLines("  portfolio trades", r.portfolio.stats));
  L.push("");
  L.push(`SKIPS: ${JSON.stringify(r.skips)}`);
  L.push("");
  L.push(...groupLines("BY EXIT REASON:", r.byExitReason));
  L.push("");
  L.push(...groupLines("BY TICKER:", r.byTicker));
  L.push("");
  L.push(...groupLines("BY TIME OF DAY (ET entry hour):", r.byHourEt));
  L.push("");
  L.push(...groupLines("BY SETUP SCORE (descriptive — not a gate):", r.byScore));
  L.push("");
  L.push(...groupLines("CALLS vs PUTS:", r.byDirection));
  L.push("");
  L.push(...groupLines("BY MARKET ALIGNMENT:", r.byAlignment));
  L.push("");
  L.push("ASSUMPTIONS:");
  for (const [k, v] of Object.entries(r.assumptions)) L.push(`  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  L.push("");
  L.push("HONEST LIMITATIONS:");
  for (const l of r.limitations) L.push(`  - ${l}`);
  return L.join("\n");
}

export function renderStage1Report(r: Stage1Report): string {
  const L: string[] = [];
  L.push("=".repeat(72));
  L.push(`BACKTEST STAGE 1 — run #${r.runId}`);
  for (const [k, v] of Object.entries(r.header)) if (v !== "") L.push(`  ${k}: ${v}`);
  L.push("=".repeat(72));
  L.push("");
  L.push(`Signals: ${r.n}   (truncated outcomes: ${r.truncated})`);
  L.push(`Hit rate (target before invalidation): ALL ${pct(r.hitRateAll)} · cap-constrained (${3}/day) ${pct(r.hitRateCapConstrained)}`);
  L.push("");
  L.push("CALIBRATION — stated probability vs realized hit rate (the reaction-DB honesty test):");
  for (const c of r.calibration) {
    if (c.n === 0) continue;
    L.push(`  ${c.bucket.padEnd(6)} n=${String(c.n).padStart(4)}  stated ~${c.statedMid}%  realized ${c.realizedPct != null ? c.realizedPct + "%" : "—"}`);
  }
  L.push("  (If the 80+ bucket doesn't beat 50-60, the probability number is decoration.)");
  L.push("");
  L.push(`TIMING — stated median hold ${r.timing.statedMedianBars ?? "—"} bars vs realized median ${r.timing.realizedMedianBars ?? "—"} bars to target.`);
  if (r.mae) {
    const f = (x: number | null) => (x == null ? "—" : `${Math.round(x * 1000) / 10}%`);
    L.push(`MAE (worst move against, before resolution): p25 ${f(r.mae.p25)} · p50 ${f(r.mae.p50)} · p75 ${f(r.mae.p75)} · p90 ${f(r.mae.p90)}`);
    L.push(`  winners avg ${f(r.mae.winners)} vs losers avg ${f(r.mae.losers)} — this sets stop placement empirically.`);
  }
  L.push("");
  L.push("EDGE vs BASELINES:");
  L.push(`  signal mean returns: +1d ${pct(r.meanRets.r1)} · +3d ${pct(r.meanRets.r3)} · +5d ${pct(r.meanRets.r5)} · +10d ${pct(r.meanRets.r10)}`);
  if (r.baselines) {
    const b = r.baselines;
    L.push(`  random-entry baseline (same symbols/directions/target distances, n=${b.randomN}):`);
    L.push(`    target touched ${pct(b.randomTargetTouchedRate)} · +1d ${pct(b.randomRet1d)} · +3d ${pct(b.randomRet3d)} · +5d ${pct(b.randomRet5d)} · +10d ${pct(b.randomRet10d)}`);
    L.push(`  SPY buy-and-hold over the window: ${b.spyReturnPct != null ? b.spyReturnPct + "%" : "—"}`);
    L.push(`  window character: ${b.windowCharacter}`);
  }
  L.push("");
  L.push("PER-SETUP-TYPE (which playbooks actually work):");
  for (const p of r.perPlaybook) L.push(`  ${p.playbook.padEnd(22)} n=${String(p.n).padStart(4)}  hit ${p.hitRatePct != null ? p.hitRatePct + "%" : "—"}`);
  L.push("");
  L.push(`Tie rate (target+invalidation same bar, ruled AGAINST the signal): ${r.tieRatePct ?? "—"}%`);
  L.push(`Gap-through entries (open already beyond the boundary): ${r.gapThroughRatePct ?? "—"}%`);
  L.push("");
  L.push("HONEST LIMITATIONS (read before believing any number above):");
  for (const l of r.limitations) L.push(`  - ${l}`);
  L.push("");
  L.push("DECISION GATE: if there is no edge on the underlying here, STOP — no options");
  L.push("structure or exit tuning rescues a signal that can't predict the stock.");
  return L.join("\n");
}
