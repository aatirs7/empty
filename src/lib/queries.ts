/**
 * Server-side read helpers for the dashboard pages (run in server components).
 */
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { researchRuns, proposals, orders, type ResearchRun, type ProposalRow, type OrderRow } from "../db/schema";

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
