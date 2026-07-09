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

function pickExpiry(dates: string[], kind: ContractConfig["expiryKind"]): string {
  const u = [...new Set(dates)].sort();
  if (kind === "zeroDte") return (u.filter((e) => daysFromToday(e) >= 0)[0] ?? u[0]);
  if (kind === "oneDay") return (u.filter((e) => daysFromToday(e) >= 1)[0] ?? u[0]);
  if (kind === "twoToFourWeeks") {
    const w = u.filter((e) => daysFromToday(e) >= 10 && daysFromToday(e) <= 35);
    return (w.length ? w : u).reduce((b, e) => (Math.abs(daysFromToday(e) - 21) < Math.abs(daysFromToday(b) - 21) ? e : b));
  }
  const f = u.filter((e) => daysFromToday(e) >= 1 && isFriday(e));
  return f[0] ?? u.filter((e) => daysFromToday(e) >= 1)[0] ?? u[0];
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
): Promise<EvSelection> {
  const target = pred.targetMain ?? (direction === "call" ? spot * 1.02 : spot * 0.98);
  const P = Math.max(0.1, Math.min(0.95, pred.probability / 100));

  const now = new Date();
  const gte = new Date(now);
  gte.setUTCDate(gte.getUTCDate() + (contract.expiryKind === "zeroDte" ? 0 : 1));
  const lte = new Date(now);
  lte.setUTCDate(lte.getUTCDate() + 60);
  const contracts = await listOptionContracts({
    underlyingSymbol: symbol,
    type: direction,
    expirationDateGte: ymd(gte),
    expirationDateLte: ymd(lte),
    limit: 1000,
  });
  if (!contracts.length) return { primary: null, aggressive: null, conservative: null };

  const expiry = pickExpiry(contracts.map((c) => c.expiration_date), contract.expiryKind);
  const holdDays = Math.min(Math.max(daysFromToday(expiry), 0.3), 3);
  // Strike window around spot from the profile.
  const lo = direction === "call" ? spot * (1 - contract.itmPct / 100) : spot * (1 - contract.otmPct / 100);
  const hi = direction === "call" ? spot * (1 + contract.otmPct / 100) : spot * (1 + contract.itmPct / 100);
  const pool: OptionContract[] = contracts.filter(
    (c) => c.expiration_date === expiry && Number(c.strike_price) >= lo && Number(c.strike_price) <= hi && c.tradable !== false,
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
    const gain = valueAtTarget - ask;
    const gainPct = gain / ask;
    const lossIfMiss = -ask * 0.5; // approximate downside if the move fails
    const evPct = (P * gain + (1 - P) * lossIfMiss) / ask;
    if (!Number.isFinite(evPct)) continue;
    scored.push({ occ: c.symbol, strike, expiry, ask: Math.round(ask * 100) / 100, delta: Math.round(delta * 100) / 100, gainPct: Math.round(gainPct * 100) / 100, evPct: Math.round(evPct * 100) / 100 });
  }
  if (!scored.length) return { primary: null, aggressive: null, conservative: null };

  const byEv = [...scored].sort((a, b) => b.evPct - a.evPct);
  const byGain = [...scored].sort((a, b) => b.gainPct - a.gainPct);
  const byDelta = [...scored].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { primary: byEv[0], aggressive: byGain[0], conservative: byDelta[0] };
}
