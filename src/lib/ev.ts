/**
 * Expected-value option selector. Given the underlying prediction (target + hit
 * probability from the reaction DB), score each candidate strike by EXPECTED VALUE
 * — P(reach target) × option gain − cost − decay — not raw % gain. Recommends a
 * Primary (best EV), Aggressive (biggest upside), and Conservative (most resilient)
 * contract. Uses live greeks (delta/gamma/theta); Black-Scholes-ish delta fallback.
 */
import { listOptionContracts, getOptionSnapshots, type OptionContract } from "./alpaca";
import type { Prediction } from "./predict";
import type { ContractConfig } from "./profiles";

export interface EvContract {
  occ: string;
  strike: number;
  expiry: string;
  ask: number;
  delta: number;
  gainPct: number; // option % gain if the target is reached
  evPct: number; // expected value as a % of cost
}
export interface EvSelection {
  primary: EvContract | null;
  aggressive: EvContract | null;
  conservative: EvContract | null;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysFromToday = (s: string) => Math.round((Date.parse(`${s}T00:00:00Z`) - Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())) / 86_400_000);
const isFriday = (s: string) => new Date(`${s}T12:00:00Z`).getUTCDay() === 5;

// Pick an expiry whose life covers the expected time-to-target. `minDays` is the
// horizon floor (from the prediction) — the option must survive at least that
// long. Returns null when nothing fits so the caller REJECTS (better than buying
// a contract that expires before the move can play out).
function pickExpiry(dates: string[], kind: ContractConfig["expiryKind"], minDays = 0): string | null {
  const u = [...new Set(dates)].sort();
  const atLeast = (d: number) => u.filter((e) => daysFromToday(e) >= d);
  if (kind === "zeroDte") return atLeast(Math.max(0, minDays))[0] ?? null;
  if (kind === "oneDay") return atLeast(Math.max(1, minDays))[0] ?? null;
  if (kind === "twoToFourWeeks") {
    const lo = Math.max(10, minDays);
    const w = u.filter((e) => daysFromToday(e) >= lo && daysFromToday(e) <= Math.max(35, minDays + 14));
    const pool = w.length ? w : atLeast(lo);
    const tgt = Math.max(21, minDays);
    return pool.length ? pool.reduce((b, e) => (Math.abs(daysFromToday(e) - tgt) < Math.abs(daysFromToday(b) - tgt) ? e : b)) : null;
  }
  // friday: nearest weekly Friday at least `floor` days out.
  const floor = Math.max(1, minDays);
  const f = u.filter((e) => daysFromToday(e) >= floor && isFriday(e));
  return f[0] ?? atLeast(floor)[0] ?? null;
}

/** Fallback delta from moneyness when greeks are absent. */
function fallbackDelta(direction: "call" | "put", spot: number, strike: number): number {
  const m = (spot - strike) / spot; // >0 ITM for calls
  const call = Math.max(0.02, Math.min(0.98, 0.5 + m * 6));
  return direction === "call" ? call : -(1 - call);
}

export async function selectByEV(
  symbol: string,
  direction: "call" | "put",
  spot: number,
  pred: Prediction,
  contract: ContractConfig,
  minDaysToExpiry = 0,
  // When true, only consider strikes the projected target actually REACHES (call:
  // strike ≤ target, put: strike ≥ target) so the contract is ITM/ATM at the target
  // and the "sell at the DB target" exit genuinely profits. Off by default (SBv1/QQQ
  // unchanged); SBv2 turns it on. Prevents picking an ultra-deep-OTM strike whose
  // linear-delta EV is overstated but which stays worthless at the target.
  requireTargetReachable = false,
  // When true, net the ROUND-TRIP SPREAD (buy at ask, sell at bid) into every gain/loss
  // and REJECT (return no contract) if the best expected value is still non-positive
  // after spread + theta. On for 0DTE (spread is a big fraction of a $0.40 contract);
  // off elsewhere (SBv1/SBv2 unchanged).
  netCosts = false,
): Promise<EvSelection> {
  const target = pred.targetMain ?? (direction === "call" ? spot * 1.02 : spot * 0.98);
  const P = Math.max(0.1, Math.min(0.95, pred.probability / 100));

  const floorDays = Math.max(contract.expiryKind === "zeroDte" ? 0 : 1, Math.round(minDaysToExpiry));
  const now = new Date();
  const gte = new Date(now);
  gte.setUTCDate(gte.getUTCDate() + floorDays);
  const lte = new Date(now);
  lte.setUTCDate(lte.getUTCDate() + Math.max(60, floorDays + 21));
  const contracts = await listOptionContracts({
    underlyingSymbol: symbol,
    type: direction,
    expirationDateGte: ymd(gte),
    expirationDateLte: ymd(lte),
    limit: 1000,
  });
  if (!contracts.length) return { primary: null, aggressive: null, conservative: null };

  const expiry = pickExpiry(contracts.map((c) => c.expiration_date), contract.expiryKind, minDaysToExpiry);
  if (!expiry) return { primary: null, aggressive: null, conservative: null }; // no expiry covers the horizon -> reject
  const holdDays = Math.min(Math.max(daysFromToday(expiry), 0.3), 30); // theta over the ACTUAL hold, not capped at 3
  // Strike window around spot from the profile.
  const lo = direction === "call" ? spot * (1 - contract.itmPct / 100) : spot * (1 - contract.otmPct / 100);
  const hi = direction === "call" ? spot * (1 + contract.otmPct / 100) : spot * (1 + contract.itmPct / 100);
  // Target reachability (SBv2): keep only strikes the target brings ITM/ATM.
  const reachable = (strike: number) => !requireTargetReachable || (direction === "call" ? strike <= target : strike >= target);
  const pool: OptionContract[] = contracts.filter(
    (c) =>
      c.expiration_date === expiry &&
      Number(c.strike_price) >= lo &&
      Number(c.strike_price) <= hi &&
      reachable(Number(c.strike_price)) &&
      c.tradable !== false,
  );
  if (!pool.length) return { primary: null, aggressive: null, conservative: null };

  const snaps = await getOptionSnapshots(pool.map((c) => c.symbol));
  const scored: EvContract[] = [];
  for (const c of pool) {
    const strike = Number(c.strike_price);
    const s = snaps[c.symbol];
    const ask = s?.ask && s.ask > 0 ? s.ask : null;
    if (!ask) continue;
    if (ask < contract.priceFloor || ask > contract.priceCap) continue; // affordable band only
    const delta = s?.delta != null ? s.delta : fallbackDelta(direction, spot, strike);
    const gamma = s?.gamma ?? 0;
    const theta = s?.theta ?? 0;
    const move = target - spot;
    // Second-order price estimate at the target, less theta decay over the hold.
    const est = ask + delta * move + 0.5 * gamma * move * move + theta * holdDays;
    const valueAtTarget = Math.max(0, est);
    // Round-trip spread cost (buy at ask, sell at bid). netCosts subtracts it from BOTH
    // the win (you exit at the bid, not fair value) and the loss (you still cross it).
    const bid = s?.bid && s.bid > 0 ? s.bid : null;
    const spread = netCosts ? (bid != null ? Math.max(0, ask - bid) : ask * 0.15) : 0;
    const gain = valueAtTarget - spread - ask;
    const gainPct = gain / ask;
    const lossIfMiss = -ask * 0.5 - spread; // downside if the move fails (+ exit spread)
    const evPct = (P * gain + (1 - P) * lossIfMiss) / ask;
    if (!Number.isFinite(evPct)) continue;
    scored.push({ occ: c.symbol, strike, expiry, ask: Math.round(ask * 100) / 100, delta: Math.round(delta * 100) / 100, gainPct: Math.round(gainPct * 100) / 100, evPct: Math.round(evPct * 100) / 100 });
  }
  if (!scored.length) return { primary: null, aggressive: null, conservative: null };

  const byEv = [...scored].sort((a, b) => b.evPct - a.evPct);
  const byGain = [...scored].sort((a, b) => b.gainPct - a.gainPct);
  const byDelta = [...scored].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  // Cost gate: if the best contract still has non-positive EV after spread + theta, the
  // expected move doesn't clear the round-trip cost → NO trade (reject).
  if (netCosts && (byEv[0]?.evPct ?? -1) <= 0) return { primary: null, aggressive: null, conservative: null };
  return { primary: byEv[0], aggressive: byGain[0], conservative: byDelta[0] };
}
