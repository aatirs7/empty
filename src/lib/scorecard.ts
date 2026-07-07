/**
 * Paper-month scorecard. Reads shadow_outcomes + proposals + API cost and
 * computes the go/no-go metrics: hit rate, priced-in buckets, confidence
 * calibration, net P&L after costs, and the beat-the-baseline test.
 * All code-computed from stored data.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { proposals, shadowOutcomes } from "../db/schema";
import { getCostTotals } from "./queries";

export interface Bucket {
  label: string;
  n: number;
  winRate: number; // 0..1
  avgReturnPct: number; // percent
  netPnl: number; // dollars, 1 contract
}

export interface Scorecard {
  overall: Bucket & { avgWinnerPct: number; avgLoserPct: number };
  pricedIn: Bucket[];
  confidence: Bucket[];
  variants: Bucket[];
  baseline: Bucket;
  counts: { totalProposals: number; realTrades: number; noTrades: number; openShadows: number };
  apiCost: number;
  netAfterCost: number;
  beatsBaseline: boolean | null; // proposal avg return vs baseline avg return
}

interface Row {
  ret: number; // fraction
  pnl: number; // dollars, 1 contract
  win: boolean;
  variant: string | null;
  pricedIn: string | null;
  confidence: number | null;
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
  // Closed proposal shadows joined to their proposal (for confidence/priced-in).
  const joined = await db
    .select({ s: shadowOutcomes, p: proposals })
    .from(shadowOutcomes)
    .leftJoin(proposals, eq(shadowOutcomes.proposalId, proposals.id))
    .where(and(eq(shadowOutcomes.kind, "proposal"), eq(shadowOutcomes.status, "closed")));

  const rows: Row[] = joined.map(({ s, p }) => {
    const entry = Number(s.entryPremium);
    const exit = Number(s.exitPremium);
    return {
      ret: entry > 0 ? (exit - entry) / entry : 0,
      pnl: (exit - entry) * 100,
      win: !!s.win,
      variant: s.variant,
      pricedIn: p?.pricedInAssessment ?? null,
      confidence: p?.confidence != null ? Number(p.confidence) : null,
    };
  });

  const overallBase = bucket("overall", rows);
  const winners = rows.filter((r) => r.win).map((r) => r.ret);
  const losers = rows.filter((r) => !r.win).map((r) => r.ret);

  const byKey = (key: (r: Row) => string | null, labels?: string[]): Bucket[] => {
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const k = key(r) ?? "unknown";
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
    }
    const keys = labels ?? [...groups.keys()].sort();
    return keys.filter((k) => groups.has(k)).map((k) => bucket(k, groups.get(k)!));
  };

  const confidenceBuckets = (): Bucket[] => {
    const band = (r: Row): string => {
      const c = r.confidence ?? 0;
      if (c < 0.4) return "0.2-0.4";
      if (c < 0.6) return "0.4-0.6";
      return "0.6+";
    };
    return byKey(band, ["0.2-0.4", "0.4-0.6", "0.6+"]);
  };

  // Baseline (SPY ATM call).
  const baseClosed = await db
    .select()
    .from(shadowOutcomes)
    .where(and(eq(shadowOutcomes.kind, "baseline"), eq(shadowOutcomes.status, "closed")));
  const baseRows: Row[] = baseClosed.map((s) => {
    const entry = Number(s.entryPremium);
    const exit = Number(s.exitPremium);
    return {
      ret: entry > 0 ? (exit - entry) / entry : 0,
      pnl: (exit - entry) * 100,
      win: !!s.win,
      variant: "baseline",
      pricedIn: null,
      confidence: null,
    };
  });
  const baseline = bucket("baseline", baseRows);

  // Counts from proposals + open shadows.
  const allProps = await db.select({ strategy: proposals.strategy }).from(proposals);
  const realTrades = allProps.filter((p) => p.strategy && p.strategy !== "no_trade").length;
  const noTrades = allProps.filter((p) => p.strategy === "no_trade").length;
  const openShadows = (await db.select().from(shadowOutcomes).where(eq(shadowOutcomes.status, "open"))).length;

  const cost = await getCostTotals();
  const netAfterCost = Math.round((overallBase.netPnl - cost.total) * 100) / 100;
  const beatsBaseline = rows.length && baseRows.length ? overallBase.avgReturnPct > baseline.avgReturnPct : null;

  return {
    overall: {
      ...overallBase,
      avgWinnerPct: mean(winners) * 100,
      avgLoserPct: mean(losers) * 100,
    },
    pricedIn: byKey((r) => r.pricedIn, ["underdone", "priced_in", "overdone", "unclear"]),
    confidence: confidenceBuckets(),
    variants: byKey((r) => r.variant),
    baseline,
    counts: { totalProposals: allProps.length, realTrades, noTrades, openShadows },
    apiCost: cost.total,
    netAfterCost,
    beatsBaseline,
  };
}
