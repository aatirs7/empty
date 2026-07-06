/**
 * Pure trade risk math, CODE-COMPUTED, never model-generated.
 * Long single-leg options only (long_call / long_put).
 */
export interface RiskInput {
  direction: "call" | "put";
  strike: number;
  premiumPerShare: number; // option price per share (limit or fill)
  qty: number; // contracts
  underlyingPrice: number; // spot
}

export interface Scenario {
  label: string;
  underlyingPrice: number;
  payoff: number; // whole-position payoff at expiration, net of premium
}

export interface RiskMath {
  maxLoss: number; // dollars at risk = premium * 100 * qty
  breakeven: number; // underlying price where the position breaks even
  scenarios: Scenario[];
}

const CONTRACT_MULTIPLIER = 100;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function intrinsic(direction: "call" | "put", strike: number, underlying: number): number {
  return direction === "call" ? Math.max(underlying - strike, 0) : Math.max(strike - underlying, 0);
}

/**
 * Max loss, breakeven, and a few expiration-payoff scenarios. Scenarios move the
 * underlying in the trade's favorable direction (up for calls, down for puts)
 * plus flat, adverse moves just floor at maxLoss, which is already shown.
 */
export function computeRisk(input: RiskInput): RiskMath {
  const { direction, strike, premiumPerShare, qty, underlyingPrice } = input;

  const maxLoss = premiumPerShare * CONTRACT_MULTIPLIER * qty;
  const breakeven = direction === "call" ? strike + premiumPerShare : strike - premiumPerShare;

  const moves = direction === "call" ? [0, 0.05, 0.1] : [0, -0.05, -0.1];
  const labels = direction === "call" ? ["flat", "+5%", "+10%"] : ["flat", "-5%", "-10%"];

  const scenarios: Scenario[] = moves.map((m, i) => {
    const u = underlyingPrice * (1 + m);
    const payoff = (intrinsic(direction, strike, u) - premiumPerShare) * CONTRACT_MULTIPLIER * qty;
    return { label: labels[i], underlyingPrice: round2(u), payoff: round2(payoff) };
  });

  return { maxLoss: round2(maxLoss), breakeven: round2(breakeven), scenarios };
}
