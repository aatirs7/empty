/**
 * Operation Vega persistence — load the active watchlist, run The Brain, and
 * write the run + proposals to Neon. Shared by the CLI script (M2/M3) and the
 * GitHub Actions job (M4). It NEVER places orders (guardrail: human in the loop).
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { watchlist as watchlistTable, researchRuns, proposals as proposalsTable } from "../db/schema";
import { runResearch, ResearchParseError, type ResearchResult, type WatchlistItem } from "./anthropic";

export async function loadActiveWatchlist(): Promise<WatchlistItem[]> {
  const rows = await db
    .select()
    .from(watchlistTable)
    .where(eq(watchlistTable.active, true))
    .orderBy(watchlistTable.symbol);
  return rows.map((r) => ({ symbol: r.symbol, notes: r.notes }));
}

export interface PersistedRun {
  runId: number;
  result: ResearchResult;
  proposalsInserted: number;
}

/**
 * Runs research for the active watchlist and persists it. The run row is created
 * as `running`, then updated to `complete` (with cost + market context) or
 * `failed` (with the raw text) so every attempt is auditable.
 */
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

    let proposalsInserted = 0;
    if (result.output.proposals.length > 0) {
      await db.insert(proposalsTable).values(
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
          sources: p.sources,
          status: "pending" as const,
        })),
      );
      proposalsInserted = result.output.proposals.length;
    }

    return { runId: run.id, result, proposalsInserted };
  } catch (err) {
    const rawOrMsg =
      err instanceof ResearchParseError ? err.rawText : err instanceof Error ? err.message : String(err);
    await db.update(researchRuns).set({ status: "failed", error: rawOrMsg }).where(eq(researchRuns.id, run.id));
    throw err;
  }
}
