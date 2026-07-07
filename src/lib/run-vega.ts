/**
 * Operation Vega persistence, load the active watchlist, run The Brain, write
 * the run + proposals to Neon, then (if enabled) run PAPER-ONLY auto-execute.
 * Shared by the CLI script (M2/M3) and the GitHub Actions job (M4).
 *
 * Human-in-the-loop is the default. Auto-execute is off unless settings.autoExecute
 * is true; when on it places paper orders for high-confidence real-trade proposals,
 * bounded by its own caps + the shared execute guardrails.
 */
import { and, count, desc, eq, gte } from "drizzle-orm";
import { db } from "../db";
import {
  watchlist as watchlistTable,
  researchRuns,
  proposals as proposalsTable,
  orders,
  candidates as candidatesTable,
} from "../db/schema";
import { runResearch, ResearchParseError, type ResearchResult, type WatchlistItem } from "./anthropic";
import { getSettings } from "./settings";
import { executeProposal, ExecuteError } from "./execute";
import { getWeeklyPL } from "./alpaca";
import { autoManagePositions, type ManageSummary } from "./manage";
import type { ZoneSetup } from "./strategy";

export async function loadActiveWatchlist(): Promise<WatchlistItem[]> {
  const rows = await db
    .select()
    .from(watchlistTable)
    .where(eq(watchlistTable.active, true))
    .orderBy(watchlistTable.symbol);
  return rows.map((r) => ({ symbol: r.symbol, notes: r.notes }));
}

/**
 * Build a watchlist from the latest scan's VALID zone setups (the daily-scan
 * taps). Returns [] when the most recent scan produced no valid setups.
 */
export async function loadZoneWatchlist(): Promise<WatchlistItem[]> {
  const [latest] = await db
    .select({ runDate: candidatesTable.runDate })
    .from(candidatesTable)
    .orderBy(desc(candidatesTable.runDate))
    .limit(1);
  if (!latest) return [];
  const rows = await db
    .select()
    .from(candidatesTable)
    .where(and(eq(candidatesTable.runDate, latest.runDate), eq(candidatesTable.setupValid, true)));
  return rows.map((r) => {
    const z = r.zone as { bottom: number; top: number } | null;
    return {
      symbol: r.symbol,
      notes: z ? `valid ${r.direction} setup at a zone edge [${z.bottom}-${z.top}]` : `${r.direction} zone setup`,
      zoneSetup: r.setup as ZoneSetup,
    };
  });
}

/** Research the latest valid zone setups (variant='news_plus_zones'). Null if none. */
export async function runZoneResearch(): Promise<PersistedRun | null> {
  const watchlist = await loadZoneWatchlist();
  if (watchlist.length === 0) return null;
  return runAndPersist({ watchlist, variant: "news_plus_zones" });
}

export interface AutoPlacement {
  proposalId: number;
  symbol: string;
  ok: boolean;
  orderId?: number;
  status?: string;
  error?: string;
  dryRun?: boolean;
}
export interface AutoExecSummary {
  enabled: boolean;
  minConfidence?: number;
  maxTradesPerDay?: number;
  alreadyPlacedToday?: number;
  placed: AutoPlacement[];
  goalMet?: boolean;
}

export interface PersistedRun {
  runId: number;
  result: ResearchResult;
  proposalsInserted: number;
  auto: AutoExecSummary;
  manage: ManageSummary;
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

  // Goal-aware: once the weekly goal is met, stop opening new trades (protect the gains).
  const goal = Number(settings.weeklyGoal);
  if (goal > 0) {
    try {
      const { weeklyPL } = await getWeeklyPL();
      if (weeklyPL >= goal) {
        return { enabled: true, minConfidence, maxTradesPerDay, alreadyPlacedToday: 0, placed: [], goalMet: true };
      }
    } catch {
      // if P&L can't be fetched, proceed normally
    }
  }

  // How many auto orders already placed today?
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const [{ n }] = await db
    .select({ n: count() })
    .from(orders)
    .where(and(eq(orders.executionMode, "auto"), gte(orders.submittedAt, startOfDay)));
  const alreadyPlacedToday = Number(n);
  let remaining = Math.max(0, maxTradesPerDay - alreadyPlacedToday);

  // Dry-run: log which proposals WOULD auto-execute at the real threshold,
  // without placing anything. Set AUTO_EXECUTE_DRY_RUN=1 to validate the mechanism.
  const dryRun = process.env.AUTO_EXECUTE_DRY_RUN === "1";

  const candidates = inserted
    .filter((p) => p.strategy && p.strategy !== "no_trade")
    .filter((p) => Number(p.confidence) >= minConfidence)
    .sort((a, b) => Number(b.confidence) - Number(a.confidence));

  const placed: AutoPlacement[] = [];
  for (const c of candidates) {
    if (remaining <= 0) break;
    if (dryRun) {
      console.log(`[auto] DRY-RUN: would auto-execute proposal ${c.id} (${c.symbol}, confidence ${c.confidence}).`);
      placed.push({ proposalId: c.id, symbol: c.symbol, ok: false, dryRun: true });
      remaining -= 1;
      continue;
    }
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

export interface RunOptions {
  watchlist?: WatchlistItem[];
  variant?: string;
}

export async function runAndPersist(opts: RunOptions = {}): Promise<PersistedRun> {
  const list = opts.watchlist ?? (await loadActiveWatchlist());
  if (list.length === 0) {
    throw new Error("Watchlist is empty, seed it first with `npm run seed`.");
  }
  const variant = opts.variant ?? "news_only";
  const zoneBySymbol = new Map(list.filter((w) => w.zoneSetup).map((w) => [w.symbol, w.zoneSetup!]));

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
            variant,
            zoneSetup: zoneBySymbol.get(p.symbol) ?? null,
            zoneRead: p.zone_read ?? null,
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
    let manage: ManageSummary = { enabled: false, actions: [] };
    try {
      manage = await autoManagePositions();
    } catch {
      // don't fail the research run if management can't run
    }

    return { runId: run.id, result, proposalsInserted: inserted.length, auto, manage };
  } catch (err) {
    const rawOrMsg =
      err instanceof ResearchParseError ? err.rawText : err instanceof Error ? err.message : String(err);
    await db.update(researchRuns).set({ status: "failed", error: rawOrMsg }).where(eq(researchRuns.id, run.id));
    throw err;
  }
}
