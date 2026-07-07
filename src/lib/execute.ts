/**
 * Shared execute path, used by BOTH the manual API route and auto-execute.
 * All guardrails live HERE so every path is protected identically:
 *   - PAPER-ONLY (asserts TRADING_MODE === "paper")
 *   - per-order contract cap (MAX_CONTRACTS_PER_ORDER)
 *   - open-position cap (MAX_OPEN_POSITIONS)
 * Resolves hints -> real contract, places the paper order, computes + stores the
 * code-computed risk math, polls the fill, and updates proposal + order rows.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { proposals, orders } from "../db/schema";
import { getBroker } from "./broker";
import { resolveContract } from "./resolve";
import { computeRisk, type RiskMath } from "./risk";
import { getSettings } from "./settings";

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
  const broker = getBroker();

  // Position/sizing caps deliberately relaxed for the PAPER real-test (owner's
  // call). The only backstop left is real buying power (Alpaca rejects when the
  // paper account runs out). The PAPER-ONLY guardrail (assertPaper) is untouched.
  const perOrderCap = Number(process.env.MAX_CONTRACTS_PER_ORDER ?? 100000);
  const openCap = Number(process.env.MAX_OPEN_POSITIONS ?? 100000);
  const settings = await getSettings();
  const perTradeBudget = Number(settings.perTradeBudget);
  const maxContracts = Math.max(1, Math.min(settings.maxContracts, perOrderCap));
  const maxContractPrice = Number(settings.maxContractPrice);

  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
  if (!proposal) throw new ExecuteError(`Proposal ${proposalId} not found.`, "not_found");
  if (proposal.strategy === "no_trade" || !proposal.direction || proposal.direction === "none") {
    throw new ExecuteError(`Proposal ${proposalId} is a no_trade, nothing to execute.`, "no_trade");
  }
  if (proposal.status !== "pending") {
    throw new ExecuteError(`Proposal ${proposalId} is already "${proposal.status}".`, "already_actioned");
  }

  // Open-position cap, count real Alpaca positions.
  const positions = await broker.listPositions();
  if (positions.length >= openCap) {
    throw new ExecuteError(`Open-position cap reached (${positions.length}/${openCap}).`, "open_cap");
  }

  const direction = proposal.direction as "call" | "put";
  const resolved = await resolveContract({
    symbol: proposal.symbol,
    direction,
    strikeHint: proposal.strikeHint ?? "ATM",
    expiryHint: proposal.expiryHint ?? "nearest weekly",
    maxPrice: maxContractPrice > 0 ? maxContractPrice : undefined,
  });
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
  const zs = proposal.zoneSetup as { active_zone?: { bottom: number; top: number } } | null;
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
  // Buy as many cheap contracts as the per-trade budget allows (>=1, capped).
  const qty = Math.max(1, Math.min(maxContracts, Math.floor(perTradeBudget / (limitPrice * 100))));
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

  // Order is placed -> proposal moves to "approved" (then "filled" on fill).
  await db.update(proposals).set({ status: "approved" }).where(eq(proposals.id, proposalId));

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
