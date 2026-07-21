/**
 * Shadow outcomes: the measurement backbone. PER-PROFILE and never blended — each
 * strategy track (sniper_swing, qqq_0dte, zones_legacy) shadows its own valid
 * setups against its own baseline (SPY for swings, QQQ for 0DTE). For every valid
 * setup we record a mechanical shadow trade (enter at the resolved contract's ask,
 * mark to the bid, exit on the profile's TP/SL/expiry rule). These shadows, and
 * only these, feed the scorecard.
 *
 * GUARDRAIL: all prices come from the live Alpaca chain (code), never the model.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { candidates, shadowOutcomes } from "../db/schema";
import { resolveContract } from "./resolve";
import { getOptionQuotes, getUnderlyingPrice, midPrice, type OptionQuote } from "./alpaca";
import { activeProfiles, type Profile } from "./profiles";

/** Shadow exit rule per track (measurement; distinct from the live exit). */
function shadowExit(profileId: string): { tp: number; sl: number } {
  // SB 15M's live plan is +100% / -20% (2026-07-21 spec) — mirror it so the shadow
  // track measures the strategy that actually runs.
  if (profileId === "sb15m") return { tp: 1.0, sl: -0.2 };
  return profileId === "qqq_0dte" || profileId === "qqq_manual" ? { tp: 0.6, sl: -0.4 } : { tp: 0.5, sl: -0.4 };
}

const expiryHintFor = (p: Profile) => (p.contract.expiryKind === "zeroDte" ? "0dte" : "friday");

function sellable(q: OptionQuote | undefined): number | null {
  if (!q) return null;
  if (q.bp && q.bp > 0) return q.bp;
  return midPrice(q);
}

/** Open a shadow for each VALID setup (per profile) that doesn't have one yet. */
async function openSetupShadows(): Promise<number> {
  let opened = 0;
  for (const profile of activeProfiles()) {
    const [latest] = await db
      .select({ runDate: candidates.runDate })
      .from(candidates)
      .where(eq(candidates.profileId, profile.id))
      .orderBy(desc(candidates.runDate))
      .limit(1);
    if (!latest) continue;
    const setups = await db
      .select()
      .from(candidates)
      .where(and(eq(candidates.runDate, latest.runDate), eq(candidates.profileId, profile.id), eq(candidates.setupValid, true)));

    for (const c of setups) {
      if (c.direction !== "call" && c.direction !== "put") continue;
      const [existing] = await db.select().from(shadowOutcomes).where(eq(shadowOutcomes.candidateId, c.id)).limit(1);
      if (existing) continue;
      try {
        const r = await resolveContract({
          symbol: c.symbol,
          direction: c.direction,
          strikeHint: "ATM",
          expiryHint: expiryHintFor(profile),
          contract: profile.contract,
        });
        if (r.ask == null || r.ask <= 0) continue; // unpriced now; retry next run
        const now = new Date();
        await db.insert(shadowOutcomes).values({
          candidateId: c.id,
          kind: "setup",
          profileId: profile.id,
          symbol: c.symbol,
          variant: profile.id,
          direction: c.direction,
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
  }
  return opened;
}

/** One baseline per profile per day (SPY for swings, QQQ for 0DTE). */
async function openBaselines(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  let opened = 0;
  for (const profile of activeProfiles()) {
    const [existing] = await db
      .select()
      .from(shadowOutcomes)
      .where(and(eq(shadowOutcomes.kind, "baseline"), eq(shadowOutcomes.profileId, profile.id), sql`date(${shadowOutcomes.entryAt}) = ${today}`))
      .limit(1);
    if (existing) continue;
    try {
      const r = await resolveContract({
        symbol: profile.baselineSymbol,
        direction: "call",
        strikeHint: "ATM",
        expiryHint: expiryHintFor(profile),
        contract: profile.contract,
      });
      if (r.ask == null || r.ask <= 0) continue;
      const now = new Date();
      await db.insert(shadowOutcomes).values({
        kind: "baseline",
        profileId: profile.id,
        symbol: profile.baselineSymbol,
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
      opened++;
    } catch {
      // retry next run
    }
  }
  return opened;
}

/** Mark open shadows to the bid and close any that hit their profile's exit rule. */
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
    const { tp, sl } = shadowExit(o.profileId);

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
      if (bid == null) continue;
      const ret = (bid - entry) / entry;
      if (ret >= tp) {
        exitReason = "take_profit";
        exitPremium = bid;
      } else if (ret <= sl) {
        exitReason = "stop_loss";
        exitPremium = bid;
      } else {
        await db.update(shadowOutcomes).set({ markPremium: String(bid), markAt: new Date() }).where(eq(shadowOutcomes.id, o.id));
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
  openedSetups: number;
  openedBaselines: number;
  marked: number;
  closed: number;
}

export async function runShadow(): Promise<ShadowRun> {
  const openedSetups = await openSetupShadows();
  const openedBaselines = await openBaselines();
  const { marked, closed } = await markShadows();
  return { openedSetups, openedBaselines, marked, closed };
}
