/**
 * Shadow outcomes: the measurement backbone for the paper month.
 *
 * For EVERY real-trade proposal (approved or skipped) we record a mechanical
 * shadow trade: enter at the next open at the resolved contract's ask, mark to
 * the bid, and exit on a single fixed rule (TP +50% / SL -40% / expiry). We also
 * open a daily SPY ATM-call baseline. This measures what Vega proposed, not which
 * ideas the owner happened to like. PAPER/analysis only — no orders placed.
 *
 * GUARDRAIL: all prices come from the live Alpaca chain (code), never the model.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db";
import { proposals, shadowOutcomes } from "../db/schema";
import { resolveContract } from "./resolve";
import { getOptionQuotes, getUnderlyingPrice, midPrice, type OptionQuote } from "./alpaca";
import { getSettings } from "./settings";

export const TAKE_PROFIT = 0.5; // +50%
export const STOP_LOSS = -0.4; // -40%
const MAX_AGE_HOURS = Number(process.env.SHADOW_MAX_AGE_HOURS ?? 36); // only shadow recent proposals

/** Sellable price: bid preferred, else mid. */
function sellable(q: OptionQuote | undefined): number | null {
  if (!q) return null;
  if (q.bp && q.bp > 0) return q.bp;
  return midPrice(q);
}

/** Open a shadow for each recent real-trade proposal that doesn't have one yet. */
async function openProposalShadows(): Promise<number> {
  const cutoff = new Date(Date.now() - MAX_AGE_HOURS * 3600_000);
  const rows = await db
    .select()
    .from(proposals)
    .where(and(sql`${proposals.strategy} <> 'no_trade'`, gte(proposals.createdAt, cutoff)));
  const settings = await getSettings();
  const maxPrice = Number(settings.maxContractPrice);
  let opened = 0;
  for (const p of rows) {
    if (p.direction !== "call" && p.direction !== "put") continue;
    const [existing] = await db.select().from(shadowOutcomes).where(eq(shadowOutcomes.proposalId, p.id)).limit(1);
    if (existing) continue;
    try {
      const r = await resolveContract({
        symbol: p.symbol,
        direction: p.direction,
        strikeHint: p.strikeHint ?? "ATM",
        expiryHint: p.expiryHint ?? "nearest weekly",
        maxPrice: maxPrice > 0 ? maxPrice : undefined,
      });
      if (r.ask == null || r.ask <= 0) continue; // unpriced now; retry next run
      const now = new Date();
      await db.insert(shadowOutcomes).values({
        proposalId: p.id,
        kind: "proposal",
        symbol: p.symbol,
        variant: p.variant,
        direction: p.direction,
        contractSymbol: r.symbol,
        strike: String(r.strike),
        expiry: r.expiry,
        entryAt: now,
        entryUnderlying: String(r.underlyingPrice),
        entryPremium: String(r.ask),
        markPremium: String(r.ask),
        markAt: now,
        status: "open",
      });
      opened++;
    } catch {
      // couldn't resolve/quote; try again next run
    }
  }
  return opened;
}

/** Open one SPY ATM-call baseline per trading day. */
async function openBaseline(): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  const [existing] = await db
    .select()
    .from(shadowOutcomes)
    .where(and(eq(shadowOutcomes.kind, "baseline"), sql`date(${shadowOutcomes.entryAt}) = ${today}`))
    .limit(1);
  if (existing) return false;
  try {
    const r = await resolveContract({ symbol: "SPY", direction: "call", strikeHint: "ATM", expiryHint: "2-4 weeks" });
    if (r.ask == null || r.ask <= 0) return false;
    const now = new Date();
    await db.insert(shadowOutcomes).values({
      kind: "baseline",
      symbol: "SPY",
      variant: "baseline",
      direction: "call",
      contractSymbol: r.symbol,
      strike: String(r.strike),
      expiry: r.expiry,
      entryAt: now,
      entryUnderlying: String(r.underlyingPrice),
      entryPremium: String(r.ask),
      markPremium: String(r.ask),
      markAt: now,
      status: "open",
    });
    return true;
  } catch {
    return false;
  }
}

/** Mark open shadows to the bid and close any that hit the exit rule. */
async function markShadows(): Promise<{ marked: number; closed: number }> {
  const open = await db.select().from(shadowOutcomes).where(eq(shadowOutcomes.status, "open"));
  if (open.length === 0) return { marked: 0, closed: 0 };

  const occSymbols = [...new Set(open.map((o) => o.contractSymbol).filter((s): s is string => !!s))];
  const quotes = occSymbols.length ? await getOptionQuotes(occSymbols) : {};
  const today = new Date().toISOString().slice(0, 10);
  let marked = 0;
  let closed = 0;

  for (const o of open) {
    const entry = Number(o.entryPremium);
    if (!o.contractSymbol || !entry || entry <= 0) continue;

    const expired = o.expiry ? today >= (o.expiry as string) : false;
    let exitReason: string | null = null;
    let exitPremium: number | null = null;
    let exitUnderlying: number | null = null;

    if (expired) {
      let underlying = Number(o.entryUnderlying);
      try {
        underlying = await getUnderlyingPrice(o.symbol);
      } catch {
        // fall back to entry underlying
      }
      const strike = Number(o.strike);
      const intrinsic = o.direction === "call" ? Math.max(0, underlying - strike) : Math.max(0, strike - underlying);
      exitPremium = Math.round(intrinsic * 100) / 100;
      exitUnderlying = underlying;
      exitReason = "expiry";
    } else {
      const bid = sellable(quotes[o.contractSymbol]);
      if (bid == null) continue; // no quote this run; try again later
      const ret = (bid - entry) / entry;
      if (ret >= TAKE_PROFIT) {
        exitReason = "take_profit";
        exitPremium = bid;
      } else if (ret <= STOP_LOSS) {
        exitReason = "stop_loss";
        exitPremium = bid;
      } else {
        await db
          .update(shadowOutcomes)
          .set({ markPremium: String(bid), markAt: new Date() })
          .where(eq(shadowOutcomes.id, o.id));
        marked++;
        continue;
      }
    }

    const retPct = (exitPremium! - entry) / entry;
    await db
      .update(shadowOutcomes)
      .set({
        status: "closed",
        exitAt: new Date(),
        exitPremium: String(exitPremium),
        exitUnderlying: exitUnderlying != null ? String(exitUnderlying) : null,
        returnPct: String(Math.round(retPct * 10000) / 10000),
        win: retPct > 0,
        exitReason,
        markPremium: String(exitPremium),
        markAt: new Date(),
      })
      .where(eq(shadowOutcomes.id, o.id));
    closed++;
  }
  return { marked, closed };
}

export interface ShadowRun {
  openedProposals: number;
  openedBaseline: boolean;
  marked: number;
  closed: number;
}

export async function runShadow(): Promise<ShadowRun> {
  const openedProposals = await openProposalShadows();
  const openedBaseline = await openBaseline();
  const { marked, closed } = await markShadows();
  return { openedProposals, openedBaseline, marked, closed };
}
