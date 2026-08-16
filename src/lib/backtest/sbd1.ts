/**
 * SB-D1 Precision — STOCK-LEVEL backtest (spec §22: "first test the stock-level
 * strategy"). Fresh runner: it replays the standalone `evaluateSbd1` engine over
 * point-in-time daily bars (zero lookahead via PointInTimeData) and records, per
 * qualified setup, what the UNDERLYING did — safe target vs invalidation, MFE/MAE,
 * time-to-target — broken out by the four setup types, trend, and zone freshness
 * (§23). No options are priced here (that is the next stage); no DB writes.
 *
 * Reuses ONLY the shared foundation: the anti-lookahead data layer + walkForward +
 * the zone engine (through sbd1.ts). It shares NO logic with SBv1/SBv2.
 */
import { loadUniverse } from "../scanner";
import { PointInTimeData } from "./data";
import { tradingDaysFromBars } from "./clock";
import { walkForward, DEFAULT_HORIZON } from "./outcomes";
import { evaluateSbd1, type Sbd1SetupType, type Sbd1Trend } from "../sbd1";

export interface Sbd1BacktestConfig {
  from: string;
  to: string;
  universe?: string[];
}

interface Rec {
  symbol: string;
  day: string;
  type: Sbd1SetupType;
  direction: "call" | "put";
  trend: Sbd1Trend;
  fresh: boolean;
  score: number;
  rrSafe: number;
  distPct: number;
  hit: boolean; // safe target reached before invalidation
  invalidated: boolean;
  mfe: number;
  mae: number;
  barsToTarget: number | null;
}

const TYPE_LABEL: Record<Sbd1SetupType, string> = {
  demand_rejection_call: "A Demand rejection call",
  supply_rejection_put: "B Supply rejection put",
  breakout_retest_call: "C Breakout retest call",
  breakdown_retest_put: "D Breakdown retest put",
};

export async function runSbd1Backtest(cfg: Sbd1BacktestConfig): Promise<string> {
  const universe = (cfg.universe?.length ? cfg.universe : await loadUniverse("sniper_swing")).slice().sort();
  if (universe.length === 0) throw new Error("SB-D1 backtest: empty universe (seed the sniper_swing universe or pass --universe).");

  const data = await PointInTimeData.load({ symbols: [...universe, "SPY", "QQQ"], from: cfg.from, to: cfg.to });
  const days = tradingDaysFromBars(data.allBars("SPY"), cfg.from, cfg.to);
  if (days.length === 0) throw new Error(`no trading days in ${cfg.from}..${cfg.to}`);

  const recs: Rec[] = [];
  const rejections: Record<string, number> = {};
  const seen = new Set<string>(); // dedup: one entry per symbol/zone/type for the whole run
  let approximations: string[] = [];

  for (const day of days) {
    data.advanceTo(day);
    const view = data.view();
    for (const sym of universe) {
      const today = data.todayBar(sym);
      if (!today) continue;
      // Post-close daily series (history + today's closed bar) — the point-in-time
      // input SB-D1's §3 "classify after the daily close" wants, no future leak.
      const series = [...view.bars(sym), today];
      let evald;
      try {
        evald = evaluateSbd1(series);
      } catch {
        continue;
      }
      for (const [k, n] of Object.entries(evald.rejections)) rejections[k] = (rejections[k] ?? 0) + n;
      for (const s of evald.setups) {
        const key = `${sym}|${s.zone.bottom}|${s.zone.top}|${s.type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (approximations.length === 0) approximations = s.approximations;
        const zoneForInval = { bottom: s.invalidation, top: s.invalidation };
        const o = walkForward(s.entry, s.direction, s.safeTarget, zoneForInval, data.futureBars(sym, DEFAULT_HORIZON));
        recs.push({
          symbol: sym,
          day,
          type: s.type,
          direction: s.direction,
          trend: s.trend,
          fresh: s.fresh,
          score: s.score,
          rrSafe: s.rrSafe,
          distPct: s.distanceTraveledPct,
          hit: o.targetHit,
          invalidated: o.invalidatedFirst,
          mfe: o.mfePct,
          mae: o.maePct,
          barsToTarget: o.barsToTarget,
        });
      }
    }
  }

  return renderReport(cfg, universe, days.length, recs, rejections, approximations);
}

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${Math.round((n / d) * 1000) / 10}%`;
}
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function group(recs: Rec[], keyOf: (r: Rec) => string): string[] {
  const keys = [...new Set(recs.map(keyOf))].sort();
  return keys.map((k) => {
    const g = recs.filter((r) => keyOf(r) === k);
    const hits = g.filter((r) => r.hit).length;
    return `  ${k.padEnd(26)} n=${String(g.length).padStart(4)}  hit ${pct(hits, g.length).padStart(6)}  medScore ${median(g.map((r) => r.score)) ?? "—"}`;
  });
}

function renderReport(
  cfg: Sbd1BacktestConfig,
  universe: string[],
  days: number,
  recs: Rec[],
  rejections: Record<string, number>,
  approximations: string[],
): string {
  const L: string[] = [];
  const hits = recs.filter((r) => r.hit).length;
  const inval = recs.filter((r) => r.invalidated).length;
  L.push("=".repeat(72));
  L.push("SB-D1 PRECISION — STOCK-LEVEL BACKTEST (spec §22, underlying only)");
  L.push(`  window: ${cfg.from} .. ${cfg.to}  ·  ${days} trading days  ·  ${universe.length} symbols`);
  L.push("=".repeat(72));
  L.push("");
  L.push(`Qualified setups: ${recs.length}`);
  L.push(`Safe-target hit before invalidation: ${pct(hits, recs.length)}  ·  invalidated first: ${pct(inval, recs.length)}`);
  const winners = recs.filter((r) => r.hit);
  const losers = recs.filter((r) => r.invalidated);
  L.push(`MFE median ${median(recs.map((r) => r.mfe)) != null ? (median(recs.map((r) => r.mfe))! * 100).toFixed(1) + "%" : "—"}` +
    `  ·  winners avg MAE ${avgPct(winners.map((r) => r.mae))}  vs  losers avg MAE ${avgPct(losers.map((r) => r.mae))}`);
  const btt = recs.filter((r) => r.barsToTarget != null).map((r) => r.barsToTarget!);
  L.push(`Median days to safe target (winners): ${median(btt) ?? "—"}`);
  L.push("");
  L.push("BY SETUP TYPE (§23 — each must stand on its own):");
  L.push(...group(recs, (r) => TYPE_LABEL[r.type]));
  L.push("");
  L.push("BY TREND STATE:");
  L.push(...group(recs, (r) => r.trend));
  L.push("");
  L.push("BY ZONE FRESHNESS:");
  L.push(...group(recs, (r) => (r.fresh ? "fresh" : "retested")));
  L.push("");
  L.push("REJECTION FUNNEL (why candidates were dropped):");
  for (const [k, n] of Object.entries(rejections).sort((a, b) => b[1] - a[1])) L.push(`  ${k.padEnd(30)} ${n}`);
  L.push("");
  L.push("APPROXIMATIONS (this is the STOCK-LEVEL cut; these are NOT yet real):");
  for (const a of approximations) L.push(`  - ${a}`);
  L.push("  - 15-min reclaim/rejection confirmation (§6) is NOT evaluated — entries are the");
  L.push("    daily post-close approximation. The intraday confirmation + option sim are the next stage.");
  L.push("  - No option pricing/liquidity/sizing (§10-12), no live stop/trailing/circuit-breaker (§14-16,§21).");
  L.push("  - One regime, one window; survivorship (today's universe). Backtest ≠ forward result.");
  L.push("");
  L.push("DECISION GATE (§22): a setup type activates only if its OUT-OF-SAMPLE stock-level");
  L.push("edge is real (profit factor ≥1.30, ≥75 trades, etc.). This run is in-sample and");
  L.push("underlying-only — it tells us whether the SETUP LOGIC finds real reactions, nothing more.");
  return L.join("\n");
}

function avgPct(xs: number[]): string {
  if (xs.length === 0) return "—";
  const a = xs.reduce((s, x) => s + x, 0) / xs.length;
  return `${(a * 100).toFixed(1)}%`;
}
