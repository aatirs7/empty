/**
 * Anthropic API spend ledger — per-call, attributed to a profile (account).
 *
 * The only ongoing Claude cost in the live trading path is SniperBot's catalyst
 * check (QQQ 0DTE uses zero Claude). Every Claude call logs one row here tagged
 * with the profile it served, so P&L can subtract each account's OWN API spend.
 * Tracking begins when the table is created — legacy research_runs cost is not
 * counted here, so displayed spend effectively resets to zero and accrues from now.
 *
 * All money is code-computed from token counts + the active Sonnet 5 rates.
 */
import { eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { apiCosts } from "../db/schema";

// Active Sonnet 5 pricing ($/1M tokens) + per-search fee. Mirrors anthropic.ts.
const INPUT_RATE = 3;
const OUTPUT_RATE = 15;
const SEARCH_RATE = 0.01;

export function estimateCost(inputTokens: number, outputTokens: number, searchCount: number): number {
  return (inputTokens / 1e6) * INPUT_RATE + (outputTokens / 1e6) * OUTPUT_RATE + searchCount * SEARCH_RATE;
}

export interface CostEntry {
  profileId?: string | null;
  source: string; // 'catalyst' | 'research' | ...
  symbol?: string | null;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  searchCount?: number;
}

/** Record one Claude call's cost. Never throws (cost logging must not break trading). */
export async function logApiCost(entry: CostEntry): Promise<number> {
  const input = entry.inputTokens ?? 0;
  const output = entry.outputTokens ?? 0;
  const searches = entry.searchCount ?? 0;
  const cost = estimateCost(input, output, searches);
  try {
    await db.insert(apiCosts).values({
      profileId: entry.profileId ?? null,
      source: entry.source,
      symbol: entry.symbol ?? null,
      model: entry.model ?? null,
      inputTokens: input,
      outputTokens: output,
      searchCount: searches,
      costUsd: cost.toFixed(6),
    });
  } catch {
    /* never let cost logging break the caller */
  }
  return cost;
}

export interface CostTotals {
  total: number;
  monthToDate: number;
  callCount: number;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Total + month-to-date spend for one profile (its own account's API cost). */
export async function getProfileCost(profileId: string): Promise<CostTotals> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${apiCosts.costUsd}), 0)`,
      mtd: sql<string>`coalesce(sum(case when date_trunc('month', ${apiCosts.createdAt}) = date_trunc('month', now()) then ${apiCosts.costUsd} else 0 end), 0)`,
      count: sql<string>`count(*)`,
    })
    .from(apiCosts)
    .where(eq(apiCosts.profileId, profileId));
  return { total: round6(Number(row.total)), monthToDate: round6(Number(row.mtd)), callCount: Number(row.count) };
}

/** All-profile spend (for the Log's month-to-date subtitle). */
export async function getAllApiCost(): Promise<CostTotals> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${apiCosts.costUsd}), 0)`,
      mtd: sql<string>`coalesce(sum(case when date_trunc('month', ${apiCosts.createdAt}) = date_trunc('month', now()) then ${apiCosts.costUsd} else 0 end), 0)`,
      count: sql<string>`count(*)`,
    })
    .from(apiCosts);
  return { total: round6(Number(row.total)), monthToDate: round6(Number(row.mtd)), callCount: Number(row.count) };
}

/** Spend not attributed to any profile (shared research), for reference. */
export async function getSharedApiCost(): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${apiCosts.costUsd}), 0)` })
    .from(apiCosts)
    .where(isNull(apiCosts.profileId));
  return round6(Number(row.total));
}
