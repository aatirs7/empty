/**
 * Server-side read helpers for the dashboard pages (run in server components).
 */
import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "../db";
import {
  researchRuns,
  proposals,
  orders,
  candidates,
  type ResearchRun,
  type ProposalRow,
  type OrderRow,
  type CandidateRow,
} from "../db/schema";

/** The latest scan for a profile: its date + that profile's candidates. */
export async function getLatestScan(
  profileId = "sniper_swing",
): Promise<{ runDate: string; candidates: CandidateRow[] } | null> {
  const [latest] = await db
    .select({ runDate: candidates.runDate })
    .from(candidates)
    .where(eq(candidates.profileId, profileId))
    .orderBy(desc(candidates.runDate))
    .limit(1);
  if (!latest) return null;
  const rows = await db
    .select()
    .from(candidates)
    .where(and(eq(candidates.runDate, latest.runDate), eq(candidates.profileId, profileId)))
    .orderBy(asc(candidates.distanceToEdgePct));
  return { runDate: latest.runDate, candidates: rows };
}

export async function getLatestRun(): Promise<{ run: ResearchRun; proposals: ProposalRow[] } | null> {
  const [run] = await db.select().from(researchRuns).orderBy(desc(researchRuns.id)).limit(1);
  if (!run) return null;
  const props = await db
    .select()
    .from(proposals)
    .where(eq(proposals.runId, run.id))
    .orderBy(desc(proposals.confidence));
  return { run, proposals: props };
}

export async function getRunWithProposals(
  id: number,
): Promise<{ run: ResearchRun; proposals: ProposalRow[] } | null> {
  const [run] = await db.select().from(researchRuns).where(eq(researchRuns.id, id)).limit(1);
  if (!run) return null;
  const props = await db.select().from(proposals).where(eq(proposals.runId, id)).orderBy(desc(proposals.confidence));
  return { run, proposals: props };
}

/** Today's actual trades from the live monitor (filled or working), newest first.
 *  Independent of which run is "latest" — a scan run must not hide today's trades. */
export async function getTodayMonitorTrades(): Promise<ProposalRow[]> {
  const today = new Date().toISOString().slice(0, 10);
  const runs = await db
    .select({ id: researchRuns.id })
    .from(researchRuns)
    .where(and(eq(researchRuns.model, "monitor"), eq(researchRuns.runDate, today)));
  if (runs.length === 0) return [];
  const ids = runs.map((r) => r.id);
  return db
    .select()
    .from(proposals)
    .where(and(inArray(proposals.runId, ids), ne(proposals.status, "expired")))
    .orderBy(desc(proposals.createdAt));
}

/** The originating proposal for an open contract (via its order) — carries the
 *  zone setup used for the timing estimate on the position page. */
export async function getProposalForContract(contractSymbol: string): Promise<ProposalRow | null> {
  const [o] = await db
    .select({ pid: orders.proposalId })
    .from(orders)
    .where(eq(orders.contractSymbol, contractSymbol))
    .orderBy(desc(orders.id))
    .limit(1);
  if (!o) return null;
  const [p] = await db.select().from(proposals).where(eq(proposals.id, o.pid)).limit(1);
  return p ?? null;
}

/** Closed (sold) trades, newest first — for the Positions "Closed" tab. */
export async function getClosedTrades(limit = 60): Promise<OrderRow[]> {
  return db.select().from(orders).where(isNotNull(orders.exitAt)).orderBy(desc(orders.exitAt)).limit(limit);
}

export async function getCandidateById(id: number): Promise<CandidateRow | null> {
  const [c] = await db.select().from(candidates).where(eq(candidates.id, id)).limit(1);
  return c ?? null;
}

/** The most recent scan run (model='scan') — its marketContext summarizes the scan. */
export async function getLatestScanRun(): Promise<ResearchRun | null> {
  const [run] = await db
    .select()
    .from(researchRuns)
    .where(eq(researchRuns.model, "scan"))
    .orderBy(desc(researchRuns.id))
    .limit(1);
  return run ?? null;
}

export async function getLatestRunId(): Promise<number | null> {
  const [run] = await db.select({ id: researchRuns.id }).from(researchRuns).orderBy(desc(researchRuns.id)).limit(1);
  return run?.id ?? null;
}

export async function getProposalById(
  id: number,
): Promise<{ proposal: ProposalRow; order: OrderRow | null; run: ResearchRun | null } | null> {
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
  if (!proposal) return null;
  const [order] = await db.select().from(orders).where(eq(orders.proposalId, id)).orderBy(desc(orders.id)).limit(1);
  const [run] = await db.select().from(researchRuns).where(eq(researchRuns.id, proposal.runId)).limit(1);
  return { proposal, order: order ?? null, run: run ?? null };
}

export interface RunLogEntry {
  run: ResearchRun;
  proposals: ProposalRow[];
  orders: OrderRow[];
}

export async function getRunsLog(limit = 30): Promise<RunLogEntry[]> {
  const runs = await db.select().from(researchRuns).orderBy(desc(researchRuns.id)).limit(limit);
  if (runs.length === 0) return [];
  const runIds = runs.map((r) => r.id);
  const props = await db.select().from(proposals).where(inArray(proposals.runId, runIds));
  const propIds = props.map((p) => p.id);
  const ords = propIds.length ? await db.select().from(orders).where(inArray(orders.proposalId, propIds)) : [];
  const ordByProp = new Map<number, OrderRow[]>();
  for (const o of ords) {
    const arr = ordByProp.get(o.proposalId) ?? [];
    arr.push(o);
    ordByProp.set(o.proposalId, arr);
  }
  return runs.map((run) => {
    const rp = props.filter((p) => p.runId === run.id);
    const ro = rp.flatMap((p) => ordByProp.get(p.id) ?? []);
    return { run, proposals: rp, orders: ro };
  });
}

export interface CostTotals {
  total: number;
  monthToDate: number;
  runCount: number;
}

export async function getCostTotals(): Promise<CostTotals> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${researchRuns.costEstimate}), 0)`,
      mtd: sql<string>`coalesce(sum(case when date_trunc('month', ${researchRuns.createdAt}) = date_trunc('month', now()) then ${researchRuns.costEstimate} else 0 end), 0)`,
      count: sql<string>`count(*)`,
    })
    .from(researchRuns);
  return {
    total: Math.round(Number(row.total) * 1e6) / 1e6,
    monthToDate: Math.round(Number(row.mtd) * 1e6) / 1e6,
    runCount: Number(row.count),
  };
}
