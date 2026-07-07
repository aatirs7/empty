/**
 * Paper-month scorecard. SHADOW-ONLY: reads ONLY `shadow_outcomes` (mechanical
 * zone-setup shadows vs the SPY baseline). It does NOT join or read `proposals`
 * or `orders`, so the Brain-researched / auto-bought subset can never leak into
 * the measurement. The experiment is the raw zone strategy on every valid setup.
 * All code-computed.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { shadowOutcomes } from "../db/schema";
import { getCostTotals } from "./queries";

export interface Bucket {
  label: string;
  n: number;
  winRate: number; // 0..1
  avgReturnPct: number; // percent
  netPnl: number; // dollars, 1 contract
}

export interface Scorecard {
  strategy: Bucket & { avgWinnerPct: number; avgLoserPct: number };
  variants: Bucket[];
  baseline: Bucket;
  counts: { setupsShadowed: number; openShadows: number; closedShadows: number };
  apiCost: number;
  netAfterCost: number;
  beatsBaseline: boolean | null;
}

interface Row {
  ret: number; // fraction
  pnl: number; // dollars, 1 contract
  win: boolean;
  kind: string;
  variant: string | null;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function bucket(label: string, rows: Row[]): Bucket {
  return {
    label,
    n: rows.length,
    winRate: rows.length ? rows.filter((r) => r.win).length / rows.length : 0,
    avgReturnPct: mean(rows.map((r) => r.ret)) * 100,
    netPnl: Math.round(rows.reduce((a, r) => a + r.pnl, 0) * 100) / 100,
  };
}

export async function computeScorecard(): Promise<Scorecard> {
  const all = await db.select().from(shadowOutcomes);
  const closed: Row[] = all
    .filter((s) => s.status === "closed")
    .map((s) => {
      const entry = Number(s.entryPremium);
      const exit = Number(s.exitPremium);
      return {
        ret: entry > 0 ? (exit - entry) / entry : 0,
        pnl: (exit - entry) * 100,
        win: !!s.win,
        kind: s.kind,
        variant: s.variant,
      };
    });

  const setupRows = closed.filter((r) => r.kind === "setup");
  const baseRows = closed.filter((r) => r.kind === "baseline");

  const strategyBase = bucket("zones", setupRows);
  const winners = setupRows.filter((r) => r.win).map((r) => r.ret);
  const losers = setupRows.filter((r) => !r.win).map((r) => r.ret);

  const variantGroups = new Map<string, Row[]>();
  for (const r of setupRows) {
    const k = r.variant ?? "zones";
    (variantGroups.get(k) ?? variantGroups.set(k, []).get(k)!).push(r);
  }
  const variants = [...variantGroups.keys()].sort().map((k) => bucket(k, variantGroups.get(k)!));

  const baseline = bucket("baseline", baseRows);

  const cost = await getCostTotals();
  const netAfterCost = Math.round((strategyBase.netPnl - cost.total) * 100) / 100;
  const beatsBaseline = setupRows.length && baseRows.length ? strategyBase.avgReturnPct > baseline.avgReturnPct : null;

  return {
    strategy: { ...strategyBase, avgWinnerPct: mean(winners) * 100, avgLoserPct: mean(losers) * 100 },
    variants,
    baseline,
    counts: {
      setupsShadowed: all.filter((s) => s.kind === "setup").length,
      openShadows: all.filter((s) => s.status === "open").length,
      closedShadows: setupRows.length,
    },
    apiCost: cost.total,
    netAfterCost,
    beatsBaseline,
  };
}
