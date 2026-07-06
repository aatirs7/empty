/**
 * Operation Vega persistence — load the active watchlist, run The Brain, write
 * the run + proposals to Neon, then (if enabled) run PAPER-ONLY auto-execute.
 * Shared by the CLI script (M2/M3) and the GitHub Actions job (M4).
 *
 * Human-in-the-loop is the default. Auto-execute is off unless settings.autoExecute
 * is true; when on it places paper orders for high-confidence real-trade proposals,
 * bounded by its own caps + the shared execute guardrails.
 */
import { and, count, eq, gte } from "drizzle-orm";
import { db } from "../db";
import { watchlist as watchlistTable, researchRuns, proposals as proposalsTable, orders } from "../db/schema";
import { runResearch, ResearchParseError, type ResearchResult, type WatchlistItem } from "./anthropic";
import { getSettings } from "./settings";
import { executeProposal, ExecuteError } from "./execute";

export async function loadActiveWatchlist(): Promise<WatchlistItem[]> {
  const rows = await db
    .select()
    .from(watchlistTable)
    .where(eq(watchlistTable.active, true))
    .orderBy(watchlistTable.symbol);
  return rows.map((r) => ({ symbol: r.symbol, notes: r.notes }));
}

export interface AutoPlacement {
  proposalId: number;
  symbol: string;
  ok: boolean;
  orderId?: number;
  status?: string;
  error?: string;
}
export interface AutoExecSummary {
  enabled: boolean;
  minConfidence?: number;
  maxTradesPerDay?: number;
  alreadyPlacedToday?: number;
  placed: AutoPlacement[];
}

export interface PersistedRun {
  runId: number;
  result: ResearchResult;
  proposalsInserted: number;
  auto: AutoExecSummary;
}

interface InsertedProposal {
  id: number;
  symbol: string;
  strategy: string | null;
  confidence: string | null;
}

/** PAPER-ONLY auto-execute. Off unless settings.autoExecute. Bounded by min
 *  confidence, per-day cap (counted from the DB), and the execute guardrails. */
async function maybeAutoExecute(inserted: InsertedProposal[]): Promise<AutoExecSummary> {
  const settings = await getSettings();
  if (!settings.autoExecute) return { enabled: false, placed: [] };

  const minConfidence = Number(settings.autoMinConfidence);
  const maxTradesPerDay = settings.maxAutoTradesPerDay;

  // How many auto orders already placed today?
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const [{ n }] = await db
    .select({ n: count() })
    .from(orders)
    .where(and(eq(orders.executionMode, "auto"), gte(orders.submittedAt, startOfDay)));
  const alreadyPlacedToday = Number(n);
  let remaining = Math.max(0, maxTradesPerDay - alreadyPlacedToday);

  const candidates = inserted
    .filter((p) => p.strategy && p.strategy !== "no_trade")
    .filter((p) => Number(p.confidence) >= minConfidence)
    .sort((a, b) => Number(b.confidence) - Number(a.confidence));

  const placed: AutoPlacement[] = [];
  for (const c of candidates) {
    if (remaining <= 0) break;
    try {
      const res = await executeProposal(c.id, "auto");
      placed.push({ proposalId: c.id, symbol: c.symbol, ok: true, orderId: res.orderId, status: res.orderStatus });
      remaining -= 1;
    } catch (err) {
      const code = err instanceof ExecuteError ? err.code : "error";
      placed.push({ proposalId: c.id, symbol: c.symbol, ok: false, error: code });
      if (code === "open_cap" || code === "not_paper") break; // no point trying more
    }
  }

  return { enabled: true, minConfidence, maxTradesPerDay, alreadyPlacedToday, placed };
}

export async function runAndPersist(): Promise<PersistedRun> {
  const list = await loadActiveWatchlist();
  if (list.length === 0) {
    throw new Error("Watchlist is empty — seed it first with `npm run seed`.");
  }

  const runDate = new Date().toISOString().slice(0, 10);
  const model = process.env.RESEARCH_MODEL ?? "claude-sonnet-5";

  const [run] = await db
    .insert(researchRuns)
    .values({ runDate, status: "running", model })
    .returning({ id: researchRuns.id });

  try {
    const result = await runResearch(list);

    await db
      .update(researchRuns)
      .set({
        status: "complete",
        marketContext: result.output.market_context,
        rawResponse: result.output,
        searchCount: result.searchCount,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costEstimate: result.costEstimate.toFixed(6),
      })
      .where(eq(researchRuns.id, run.id));

    let inserted: InsertedProposal[] = [];
    if (result.output.proposals.length > 0) {
      inserted = await db
        .insert(proposalsTable)
        .values(
          result.output.proposals.map((p) => ({
            runId: run.id,
            symbol: p.symbol,
            direction: p.direction,
            strategy: p.strategy,
            strikeHint: p.strike_hint,
            expiryHint: p.expiry_hint,
            confidence: p.confidence.toString(),
            pricedInAssessment: p.priced_in_assessment,
            rationale: p.rationale,
            plainExplanation: p.plain_explanation,
            sources: p.sources,
            status: "pending" as const,
          })),
        )
        .returning({
          id: proposalsTable.id,
          symbol: proposalsTable.symbol,
          strategy: proposalsTable.strategy,
          confidence: proposalsTable.confidence,
        });
    }

    const auto = await maybeAutoExecute(inserted);

    return { runId: run.id, result, proposalsInserted: inserted.length, auto };
  } catch (err) {
    const rawOrMsg =
      err instanceof ResearchParseError ? err.rawText : err instanceof Error ? err.message : String(err);
    await db.update(researchRuns).set({ status: "failed", error: rawOrMsg }).where(eq(researchRuns.id, run.id));
    throw err;
  }
}
