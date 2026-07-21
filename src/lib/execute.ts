/**
 * Shared execute path, used by BOTH the manual API route and auto-execute.
 * All guardrails live HERE so every path is protected identically:
 *   - PAPER-ONLY (asserts TRADING_MODE === "paper")
 *   - per-order contract cap (MAX_CONTRACTS_PER_ORDER)
 *   - open-position cap (MAX_OPEN_POSITIONS)
 * Resolves hints -> real contract, places the paper order, computes + stores the
 * code-computed risk math, polls the fill, and updates proposal + order rows.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { proposals, orders, candidates } from "../db/schema";
import { getBroker } from "./broker";
import { resolveContract, type ResolvedContract } from "./resolve";
import { computeRisk, type RiskMath } from "./risk";
import { getProfile, contractForTimeframe } from "./profiles";
import { sendPush } from "./push";
import { predict } from "./predict";
import { holdToDays } from "./timeframes";
import { selectByEV } from "./ev";
import { getUnderlyingPrice, getOptionQuotes } from "./alpaca";

export class ExecuteError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "ExecuteError";
  }
}

export interface ExecuteResult {
  orderId: number;
  alpacaOrderId: string;
  orderStatus: string;
  filled: boolean;
  filledPrice: number | null;
  contractSymbol: string;
  executionMode: "manual" | "auto";
  risk: RiskMath;
}

function assertPaper(): void {
  if (process.env.TRADING_MODE !== "paper") {
    throw new ExecuteError(`GUARDRAIL: TRADING_MODE must be "paper", got "${process.env.TRADING_MODE}".`, "not_paper");
  }
}

export async function executeProposal(proposalId: number, mode: "manual" | "auto"): Promise<ExecuteResult> {
  assertPaper();

  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
  if (!proposal) throw new ExecuteError(`Proposal ${proposalId} not found.`, "not_found");
  if (proposal.strategy === "no_trade" || !proposal.direction || proposal.direction === "none") {
    throw new ExecuteError(`Proposal ${proposalId} is a no_trade, nothing to execute.`, "no_trade");
  }
  if (proposal.status !== "pending") {
    throw new ExecuteError(`Proposal ${proposalId} is already "${proposal.status}".`, "already_actioned");
  }

  // Caps + contract shape come from the proposal's PROFILE (never blended across
  // strategies). Env vars remain an outer hard ceiling. PAPER-ONLY assert is above.
  const profile = getProfile(proposal.profileId);
  const broker = getBroker(proposal.profileId); // the profile's own paper account
  const perOrderCap = Number(process.env.MAX_CONTRACTS_PER_ORDER ?? 100000);
  // TODO(S4/S5): count open positions PER profile; today it's the account-wide count.
  const openCap = Math.min(profile.caps.maxOpenPositions, Number(process.env.MAX_OPEN_POSITIONS ?? 100000));
  const perTradeBudget = profile.caps.perTradeBudget;
  const maxContracts = Math.max(1, Math.min(profile.caps.maxContracts, perOrderCap));

  // Open-position cap, count real Alpaca positions.
  const positions = await broker.listPositions();
  if (positions.length >= openCap) {
    throw new ExecuteError(`Open-position cap reached (${positions.length}/${openCap}).`, "open_cap");
  }

  // Daily trade cap (Farrukh 2026-07-17: max 3/day per profile — "be patient for the
  // top setups"). Counts today's PLACED buys (ET day) for this profile; canceled/
  // rejected orders don't count. Lives here so auto and manual are capped identically.
  const dailyCap = profile.caps.maxTradesPerDay ?? 3;
  const [dayCount] = await db
    .select({ n: sql<string>`count(*)` })
    .from(orders)
    .innerJoin(proposals, eq(orders.proposalId, proposals.id))
    .where(
      and(
        eq(proposals.profileId, profile.id),
        sql`(${orders.submittedAt} AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date`,
        sql`${orders.status} not in ('canceled', 'rejected')`,
      ),
    );
  if (Number(dayCount.n) >= dailyCap) {
    throw new ExecuteError(`Daily trade cap reached (${dayCount.n}/${dailyCap} today) — saving the rest for tomorrow.`, "daily_cap");
  }

  const direction = proposal.direction as "call" | "put";
  let resolved: ResolvedContract;
  // Reaction-DB target(s) captured at entry so the exit can sell when the UNDERLYING
  // reaches the projected target. Null for the non-confirmation path. expectedHoldMin
  // (minutes) feeds the intraday ladder's "bounce never came" time-out.
  let predictedTarget: number | null = null;
  let predictedTargetSafe: number | null = null;
  let expectedHoldMin: number | null = null;
  if (profile.confirmation.enabled) {
    // Confirmation profiles (SniperBot, QQQ): pick by EXPECTED VALUE off the
    // reaction-DB prediction (highest-EV contract), not a plain price band.
    const [cand] = proposal.candidateId
      ? await db.select().from(candidates).where(eq(candidates.id, proposal.candidateId)).limit(1)
      : [];
    const spot = await getUnderlyingPrice(proposal.symbol);
    const tf = cand?.timeframe ?? "daily";
    const pred = await predict(proposal.symbol, spot, tf, direction, cand?.approach ?? "", 0);
    predictedTarget = pred.targetMain;
    predictedTargetSafe = pred.targetSafe;
    // (QQQ Manual's next-level target override lived here; REMOVED 2026-07-21 with the
    // rest of its non-mechanical gates. It no longer reaches this branch at all —
    // confirmation.enabled is false, so it resolves off the plain price band below.)
    // HORIZON MATCH: the option must survive the expected time-to-target. Size the
    // minimum expiry to the predicted hold (+25% margin) so we never buy a 1-DTE
    // contract for a multi-day move. Sub-day holds (intraday 0DTE) keep a 0 floor —
    // a same-day option easily covers a few-hour move. If no expiry/contract fits,
    // executeProposal throws below and the setup is rejected.
    const holdDays = holdToDays(pred.expectedHoldBars, tf);
    expectedHoldMin = Math.max(15, Math.round(holdDays * 390)); // trading-day minutes; floor 15m
    // Per-timeframe expiry: QQQ 15m/1h → same-day 0DTE, 4h → next-day swing.
    const contractCfg = contractForTimeframe(profile, tf);
    if (profile.entryKind === "flip_retest") {
      // SBv2 (Farrukh 2026-07-16): "don't focus on strike — just enter a contract
      // priced $0.50-0.75 when the setup is there." A proper zone bounce = liquidity
      // = fast move = premium pump across ALL contracts, so the pick is PRICE-FIRST:
      // the liquid contract whose ask is closest to $0.60 in the band, on the weekly
      // (≥2 days out so a Thu tap buys NEXT Friday, not a 1-DTE). No EV ranking, no
      // hold-horizon gate.
      resolved = await resolveContract({
        symbol: proposal.symbol,
        direction,
        strikeHint: "ATM",
        expiryHint: "friday",
        contract: contractCfg,
        minDays: 2,
      });
    } else {
      // SBv1 + QQQ: EV-ranked selection, horizon-matched expiry; QQQ nets the
      // round-trip spread + theta and rejects if nothing clears the cost.
      const minDaysToExpiry = holdDays >= 1 ? Math.ceil(holdDays * 1.25) : 0;
      const sel = await selectByEV(
        proposal.symbol,
        direction,
        spot,
        pred,
        contractCfg,
        minDaysToExpiry,
        false,
        profile.netContractCosts === true,
      );
      if (!sel.primary) {
        throw new ExecuteError(
          `No contract fits ${proposal.symbol}'s horizon (~${holdDays.toFixed(1)}d to target; needs expiry ≥ ${minDaysToExpiry}d in the price band) — rejected.`,
          "no_quote",
        );
      }
      const q = await getOptionQuotes([sel.primary.occ]);
      const ask = q[sel.primary.occ]?.ap && q[sel.primary.occ].ap > 0 ? q[sel.primary.occ].ap : sel.primary.ask;
      const bid = q[sel.primary.occ]?.bp && q[sel.primary.occ].bp > 0 ? q[sel.primary.occ].bp : null;
      resolved = {
        symbol: sel.primary.occ,
        direction,
        strike: sel.primary.strike,
        expiry: sel.primary.expiry,
        underlyingPrice: spot,
        ask,
        bid,
        mid: bid != null ? Math.round(((ask + bid) / 2) * 100) / 100 : null,
        price: Math.round(ask * 100) / 100,
      };
    }
  } else {
    resolved = await resolveContract({
      symbol: proposal.symbol,
      direction,
      strikeHint: proposal.strikeHint ?? "ATM",
      expiryHint: proposal.expiryHint ?? "friday",
      contract: profile.contract,
    });
  }
  // Owner 2026-07-21 (SBv2): a flip setup is only tradable if the contract is no more
  // than `contract.otmPct`% out of the money. resolveContract's strike window already
  // enforces this; this is the belt-and-braces assert so no fallback pick can slip a
  // further-OTM strike through. Skip the setup rather than buy a deeper strike.
  if (profile.entryKind === "flip_retest" && profile.contract) {
    const maxOtm = profile.contract.otmPct;
    const otmPct =
      direction === "call"
        ? ((resolved.strike - resolved.underlyingPrice) / resolved.underlyingPrice) * 100
        : ((resolved.underlyingPrice - resolved.strike) / resolved.underlyingPrice) * 100;
    if (otmPct > maxOtm) {
      throw new ExecuteError(
        `No contract within ${maxOtm}% OTM for ${proposal.symbol} in the price band (closest is ${otmPct.toFixed(1)}% OTM) — skipped.`,
        "no_quote",
      );
    }
  }
  if (resolved.price == null || resolved.price <= 0) {
    throw new ExecuteError(
      `No affordable + liquid contract for ${proposal.symbol} within the price cap (or market closed).`,
      "no_quote",
    );
  }

  // Live-price sanity check for zone trades: the daily scan is stale, so before
  // buying, confirm the LIVE price hasn't crossed to the wrong side of the zone
  // (e.g. a "call" whose stock has since broken down through the zone). If the
  // premise is broken, skip rather than buy a stale wrong-way setup.
  // NOT applied to manual levels: there the entry is BY DEFINITION price reaching or
  // crossing the owner's level (a fast tick can print through it), and the direction
  // was just derived from the live 15-minute approach — a "wrong side of the zone"
  // reading would reject exactly the touch we intend to trade.
  const zs = profile.manualLevels ? null : (proposal.zoneSetup as { active_zone?: { bottom: number; top: number } } | null);
  if (zs?.active_zone) {
    const spot = resolved.underlyingPrice;
    const brokeDown = direction === "call" && spot < zs.active_zone.bottom;
    const brokeUp = direction === "put" && spot > zs.active_zone.top;
    if (brokeDown || brokeUp) {
      throw new ExecuteError(
        `Setup invalidated: ${proposal.symbol} at ${spot} has crossed the zone [${zs.active_zone.bottom}-${zs.active_zone.top}] against a ${direction}.`,
        "setup_invalidated",
      );
    }
  }

  const limitPrice = resolved.price;
  // Buy as many cheap contracts as the per-trade budget allows (>=1, capped)...
  let qty = Math.max(1, Math.min(maxContracts, Math.floor(perTradeBudget / (limitPrice * 100))));
  // ...unless the profile demands an EXACT lot (QQQ Manual: "buy exactly 5 contracts …
  // do not enter fewer than 5"). Then it's the full lot or no trade at all.
  const exact = profile.caps.exactContracts;
  if (exact != null) {
    if (exact > maxContracts || exact * limitPrice * 100 > perTradeBudget) {
      throw new ExecuteError(
        `Cannot buy the full ${exact}-contract lot for ${proposal.symbol} at $${limitPrice.toFixed(2)} (budget $${perTradeBudget}, cap ${maxContracts}) — skipped rather than entering a partial lot.`,
        "lot_size",
      );
    }
    qty = exact;
  }
  const placedRisk = computeRisk({
    direction,
    strike: resolved.strike,
    premiumPerShare: limitPrice,
    qty,
    underlyingPrice: resolved.underlyingPrice,
  });

  // Place the paper order (placeOptionOrder re-asserts paper + per-order cap).
  const alpacaOrder = await broker.placeOptionOrder({ symbol: resolved.symbol, qty, side: "buy", limitPrice });

  const [orderRow] = await db
    .insert(orders)
    .values({
      proposalId,
      alpacaOrderId: alpacaOrder.id,
      contractSymbol: resolved.symbol,
      side: "buy",
      qty,
      limitPrice: limitPrice.toString(),
      status: alpacaOrder.status,
      executionMode: mode,
      direction,
      strike: resolved.strike.toString(),
      expiry: resolved.expiry,
      underlyingPrice: resolved.underlyingPrice.toString(),
      maxLoss: placedRisk.maxLoss.toString(),
      breakeven: placedRisk.breakeven.toString(),
      scenarios: placedRisk.scenarios,
      submittedAt: new Date(),
    })
    .returning({ id: orders.id });

  // Order is placed -> proposal moves to "approved" (then "filled" on fill). Persist the
  // target into the zoneSetup jsonb (no migration) so the exit can sell when the
  // underlying reaches it, plus the expected hold (minutes) for the ladder's time-out.
  const zsBlob = (proposal.zoneSetup as Record<string, unknown> | null) ?? {};
  const zoneSetupUpdate =
    predictedTarget != null
      ? { zoneSetup: { ...zsBlob, predictedTarget, predictedTargetSafe, ...(expectedHoldMin != null ? { expectedHoldMin } : {}) } }
      : {};
  await db.update(proposals).set({ status: "approved", ...zoneSetupUpdate }).where(eq(proposals.id, proposalId));

  // Poll for the fill.
  const final = await broker.waitForFill(alpacaOrder.id);
  const filled = final.status === "filled";
  const filledPrice = final.filled_avg_price ? Number(final.filled_avg_price) : null;

  // Recompute risk from the actual fill price when filled.
  const finalRisk =
    filled && filledPrice != null
      ? computeRisk({ direction, strike: resolved.strike, premiumPerShare: filledPrice, qty, underlyingPrice: resolved.underlyingPrice })
      : placedRisk;

  await db
    .update(orders)
    .set({
      status: final.status,
      filledPrice: filledPrice != null ? filledPrice.toString() : null,
      filledAt: final.filled_at ? new Date(final.filled_at) : null,
      maxLoss: finalRisk.maxLoss.toString(),
      breakeven: finalRisk.breakeven.toString(),
      scenarios: finalRisk.scenarios,
    })
    .where(eq(orders.id, orderRow.id));

  if (filled) {
    await db.update(proposals).set({ status: "filled" }).where(eq(proposals.id, proposalId));
  }

  // Notify on every buy — auto (monitor) AND manual (approve) both land here.
  // The title names the PROFILE so the owner knows which strategy traded.
  const buyPx = filledPrice ?? limitPrice;
  // Body stays terse (owner: no dates in the notification — clutter).
  await sendPush(
    `${profile.label}: Bought ${proposal.symbol} ${direction === "call" ? "call" : "put"}`,
    `${qty} × $${resolved.strike} @ $${buyPx.toFixed(2)}${filled ? "" : " (working)"}.`,
    "/positions",
  ).catch(() => {});

  return {
    orderId: orderRow.id,
    alpacaOrderId: alpacaOrder.id,
    orderStatus: final.status,
    filled,
    filledPrice,
    contractSymbol: resolved.symbol,
    executionMode: mode,
    risk: finalRisk,
  };
}
