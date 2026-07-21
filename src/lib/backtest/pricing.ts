/**
 * Stage 2 option pricing — PATH A (real historical chains), probed available on
 * this Alpaca plan 2026-07-20: /v1beta1/options/bars serves daily OHLCV+VWAP for
 * EXPIRED contracts. Historical NBBO quotes are NOT available (404), so the
 * bid/ask spread is MODELED as explicit, visible config on top of real traded
 * prices — never hidden, never mid-to-mid (spec §Fill realism).
 *
 * Fill model (all labeled on the report):
 * - A contract "exists & is fillable" on a day iff it printed a real bar with
 *   enough trades/volume. No bar / too thin => unfillable => the setup is
 *   SKIPPED, exactly like live's two-sided-market gate (the JPM no-bid rule).
 * - Buy at ASK ≈ day VWAP * (1 + halfSpread). Sell at BID ≈ price * (1 - halfSpread).
 * - halfSpread is a % of premium, wider for cheap contracts (config below).
 * - Stop exits get extra slippage (fast moves fill badly).
 */
import { getOptionBars, type OptionBar } from "../alpaca";

export interface SpreadConfig {
  halfSpreadPct: number; // premium >= cheapBelow
  halfSpreadPctCheap: number; // premium < cheapBelow (cheap OTM trades wider)
  cheapBelow: number; // $ premium threshold
  minHalfSpread: number; // absolute floor ($/share)
  stopSlippagePct: number; // extra haircut selling into a fast adverse move
  feePerContractRoundTrip: number; // $ regulatory fees (Alpaca options are commission-free)
  minTrades: number; // day trade-count floor for "a real two-sided market existed"
  minVolume: number; // day contract-volume floor
}

export const DEFAULT_SPREAD: SpreadConfig = {
  halfSpreadPct: 0.06,
  halfSpreadPctCheap: 0.1,
  cheapBelow: 1.0,
  minHalfSpread: 0.03,
  stopSlippagePct: 0.05,
  feePerContractRoundTrip: 0.04,
  minTrades: 5,
  minVolume: 10,
};

export function halfSpread(premium: number, cfg: SpreadConfig): number {
  const pct = premium < cfg.cheapBelow ? cfg.halfSpreadPctCheap : cfg.halfSpreadPct;
  return Math.max(cfg.minHalfSpread, premium * pct);
}
export const askOf = (premium: number, cfg: SpreadConfig): number => premium + halfSpread(premium, cfg);
export const bidOf = (premium: number, cfg: SpreadConfig): number => Math.max(0.01, premium - halfSpread(premium, cfg));

/** OCC symbol, e.g. AMD + 2026-04-24 + call + 92.5 -> AMD260424C00092500 */
export function occSymbol(underlying: string, expiry: string, type: "call" | "put", strike: number): string {
  const s = String(Math.round(strike * 1000)).padStart(8, "0");
  return `${underlying}${expiry.slice(2).replaceAll("-", "")}${type === "call" ? "C" : "P"}${s}`;
}

/** Listed-strike increment guess by price level (real chains vary; wrong guesses
 *  self-correct — a strike that never existed has no bars and is dropped). */
export function strikeIncrement(spot: number): number {
  if (spot < 25) return 0.5;
  if (spot < 100) return 1;
  if (spot < 250) return 2.5;
  return 5;
}

/** Candidate strike grid across the profile's strike window (mirrors resolve.ts:
 *  call window = spot*(1-itmPct%) .. spot*(1+otmPct%); put mirrored). */
export function strikeGrid(spot: number, direction: "call" | "put", otmPct: number, itmPct: number): number[] {
  const lo = direction === "call" ? spot * (1 - itmPct / 100) : spot * (1 - otmPct / 100);
  const hi = direction === "call" ? spot * (1 + otmPct / 100) : spot * (1 + itmPct / 100);
  const inc = strikeIncrement(spot);
  const out: number[] = [];
  for (let k = Math.ceil(lo / inc) * inc; k <= hi + 1e-9; k += inc) out.push(Math.round(k * 1000) / 1000);
  return out;
}

/** Nearest weekly-Friday expiry >= minDays after the entry day (mirrors
 *  resolve.ts pickExpiry "friday" against a pure clock instead of the live chain;
 *  a Friday that wasn't listed simply yields no bars and the setup is skipped). */
export function pickFridayExpiry(entryDay: string, minDays: number): string {
  const d = new Date(`${entryDay}T12:00:00Z`);
  for (let add = Math.max(1, minDays); add <= 14; add++) {
    const cand = new Date(d.getTime() + add * 86_400_000);
    if (cand.getUTCDay() === 5) return cand.toISOString().slice(0, 10);
  }
  return new Date(d.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
}

export interface SelectedContract {
  occ: string;
  strike: number;
  expiry: string;
  entryAsk: number; // vwap + half spread on the entry day (real traded prices)
  entryBar: OptionBar;
  bars: OptionBar[]; // entry day .. expiry (real history)
  candidatesTried: number;
}

/**
 * SBv2 price-first selection over the REAL historical chain (mirrors live
 * resolveContract: strike window, liquidity floor, ask in [floor..cap] closest
 * to ideal). Returns null when nothing fillable fits — logged as a skip.
 */
export async function selectContractPriceFirst(opts: {
  symbol: string;
  direction: "call" | "put";
  entryDay: string;
  spot: number;
  otmPct: number;
  itmPct: number;
  priceFloor: number;
  priceIdeal: number;
  priceCap: number;
  minDays: number;
  spread: SpreadConfig;
}): Promise<SelectedContract | null> {
  const expiry = pickFridayExpiry(opts.entryDay, opts.minDays);
  const strikes = strikeGrid(opts.spot, opts.direction, opts.otmPct, opts.itmPct);
  if (strikes.length === 0) return null;
  const occs = strikes.map((k) => occSymbol(opts.symbol, expiry, opts.direction, k));
  // One batched request: the entry day's real bars for every candidate strike.
  const dayBars = await getOptionBars(occs, opts.entryDay, opts.entryDay);

  const priced = occs
    .map((occ, i) => ({ occ, strike: strikes[i], bar: dayBars[occ]?.[0] }))
    .filter((x): x is { occ: string; strike: number; bar: OptionBar } => x.bar != null)
    .filter((x) => x.bar.n >= opts.spread.minTrades && x.bar.v >= opts.spread.minVolume) // real market existed
    .map((x) => ({ ...x, ask: askOf(x.bar.vw, opts.spread) }))
    .filter((x) => x.ask >= opts.priceFloor && x.ask <= opts.priceCap);
  if (priced.length === 0) return null;

  const chosen = priced.reduce((best, x) => (Math.abs(x.ask - opts.priceIdeal) < Math.abs(best.ask - opts.priceIdeal) ? x : best));
  const bars = (await getOptionBars([chosen.occ], opts.entryDay, expiry))[chosen.occ] ?? [chosen.bar];
  return {
    occ: chosen.occ,
    strike: chosen.strike,
    expiry,
    entryAsk: Math.round(chosen.ask * 100) / 100,
    entryBar: chosen.bar,
    bars,
    candidatesTried: occs.length,
  };
}
