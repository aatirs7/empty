/**
 * Resolve a proposal's strike/expiry HINTS to a concrete option contract off the
 * live Alpaca chain, and quote it. Shared by the execute path and the M6 pending
 * "live risk" preview. The Brain never sees prices; this is where hints become a
 * real contract.
 */
import {
  getUnderlyingPrice,
  listOptionContracts,
  getOptionQuotes,
  midPrice,
  type OptionContract,
  type OptionQuote,
} from "./alpaca";
import type { ContractConfig } from "./profiles";

export interface ResolveInput {
  symbol: string;
  direction: "call" | "put";
  strikeHint: string;
  expiryHint: string;
  maxPrice?: number; // legacy: prefer contracts cheaper than this per share
  contract?: ContractConfig; // profile-driven window/band/expiry/liquidity (preferred)
}

export interface ResolvedContract {
  symbol: string; // OCC
  direction: "call" | "put";
  strike: number;
  expiry: string; // YYYY-MM-DD
  underlyingPrice: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  price: number | null; // premium per share for pricing (ask preferred, else mid)
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function daysFromToday(dateStr: string): number {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.parse(`${dateStr}T00:00:00Z`) - today) / 86_400_000);
}

function isFriday(dateStr: string): boolean {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay() === 5;
}

type ExpiryKind = "friday" | "twoToFourWeeks" | "zeroDte";

/** Map a profile expiryKind (or a hint string) to a concrete expiry from the chain. */
function pickExpiry(expiries: string[], kind: ExpiryKind): string {
  const uniqueSorted = [...new Set(expiries)].sort();
  if (kind === "zeroDte") {
    // Same-day if listed, else the nearest expiry available.
    const pool = uniqueSorted.filter((e) => daysFromToday(e) >= 0);
    return (pool.length ? pool : uniqueSorted)[0];
  }
  if (kind === "twoToFourWeeks") {
    const inWindow = uniqueSorted.filter((e) => daysFromToday(e) >= 10 && daysFromToday(e) <= 35);
    const pool = inWindow.length ? inWindow : uniqueSorted.filter((e) => daysFromToday(e) >= 5);
    const chooseFrom = pool.length ? pool : uniqueSorted;
    return chooseFrom.reduce((best, e) => (Math.abs(daysFromToday(e) - 21) < Math.abs(daysFromToday(best) - 21) ? e : best));
  }
  // friday: the nearest upcoming Friday (>=1 day out).
  const fridays = uniqueSorted.filter((e) => daysFromToday(e) >= 1 && isFriday(e));
  if (fridays.length) return fridays[0];
  const pool = uniqueSorted.filter((e) => daysFromToday(e) >= 1);
  return (pool.length ? pool : uniqueSorted)[0];
}

/** Resolve the expiryKind from a profile contract config or a legacy hint string. */
function expiryKindFrom(input: ResolveInput): ExpiryKind {
  if (input.contract) return input.contract.expiryKind;
  const h = input.expiryHint.toLowerCase();
  if (/2\s*-\s*4|2 to 4|two to four|3\s*week|month/.test(h)) return "twoToFourWeeks";
  if (/0\s*dte|same.?day|today/.test(h)) return "zeroDte";
  return "friday";
}

/** "ATM" -> spot; "~N% OTM" -> N% above spot (call) / below (put). */
function targetStrike(strikeHint: string, direction: "call" | "put", spot: number): number {
  const m = strikeHint.match(/(\d+(?:\.\d+)?)\s*%/);
  const pct = m ? parseFloat(m[1]) : 0;
  if (pct === 0) return spot;
  return direction === "call" ? spot * (1 + pct / 100) : spot * (1 - pct / 100);
}

export async function resolveContract(input: ResolveInput): Promise<ResolvedContract> {
  const spot = await getUnderlyingPrice(input.symbol);
  const kind = expiryKindFrom(input);

  const now = new Date();
  const gte = new Date(now);
  // 0DTE wants today's expiry; everything else skips today.
  gte.setUTCDate(gte.getUTCDate() + (kind === "zeroDte" ? 0 : 1));
  const lte = new Date(now);
  lte.setUTCDate(lte.getUTCDate() + 60);

  const contracts = await listOptionContracts({
    underlyingSymbol: input.symbol,
    type: input.direction,
    expirationDateGte: ymd(gte),
    expirationDateLte: ymd(lte),
    limit: 1000,
  });
  if (contracts.length === 0) {
    throw new Error(`No ${input.direction} contracts found for ${input.symbol} in the window.`);
  }

  const expiry = pickExpiry(
    contracts.map((c) => c.expiration_date),
    kind,
  );
  const atExpiry = contracts.filter((c) => c.expiration_date === expiry && c.tradable !== false);
  const poolAll = atExpiry.length ? atExpiry : contracts.filter((c) => c.expiration_date === expiry);

  let pick: OptionContract | null = null;
  let quote: OptionQuote | undefined;

  // Budget mode: profile.contract (preferred) or the legacy maxPrice band. Quote a
  // strike window around spot, require a LIQUID two-sided market, and pick the
  // contract whose ask is closest to the profile's ideal price. This avoids
  // no-bid lottery tickets that fill at the ask and instantly mark at a $0 bid.
  const band = input.contract
    ? { floor: input.contract.priceFloor, ideal: input.contract.priceIdeal, cap: input.contract.priceCap }
    : input.maxPrice && input.maxPrice > 0
      ? { floor: 0.35, ideal: 0.5, cap: input.maxPrice }
      : null;
  const otmPct = input.contract?.otmPct ?? 8;
  const itmPct = input.contract?.itmPct ?? 3;
  const spread = input.contract?.liquiditySpread ?? 0.7;

  if (band) {
    const lo = input.direction === "call" ? spot * (1 - itmPct / 100) : spot * (1 - otmPct / 100);
    const hi = input.direction === "call" ? spot * (1 + otmPct / 100) : spot * (1 + itmPct / 100);
    let candidates = poolAll.filter((c) => Number(c.strike_price) >= lo && Number(c.strike_price) <= hi);
    candidates.sort((a, b) =>
      input.direction === "call"
        ? Number(a.strike_price) - Number(b.strike_price)
        : Number(b.strike_price) - Number(a.strike_price),
    );
    candidates = candidates.slice(0, 80);
    if (candidates.length > 0) {
      const quotes = await getOptionQuotes(candidates.map((c) => c.symbol));
      const priced = candidates
        .map((c) => ({ c, q: quotes[c.symbol], ask: quotes[c.symbol]?.ap ?? 0, bid: quotes[c.symbol]?.bp ?? 0 }))
        .filter((x) => x.ask > 0.05 && x.bid > 0 && x.bid >= spread * x.ask);
      const inBand = priced.filter((x) => x.ask >= band.floor && x.ask <= band.cap);
      if (inBand.length > 0) {
        const chosen = inBand.reduce((best, x) =>
          Math.abs(x.ask - band.ideal) < Math.abs(best.ask - band.ideal) ? x : best,
        );
        pick = chosen.c;
        quote = chosen.q;
      }
    }
  }

  if (!pick) {
    const tStrike = targetStrike(input.strikeHint, input.direction, spot);
    pick = poolAll.reduce((best, c) =>
      Math.abs(Number(c.strike_price) - tStrike) < Math.abs(Number(best.strike_price) - tStrike) ? c : best,
    );
    // In budget mode, reaching here means no affordable+liquid contract exists.
    // Leave it UNPRICED so execute skips this trade (never buy a pricey/illiquid
    // fallback). Non-budget callers (the live preview) still get a real quote.
    if (!band) {
      const quotes = await getOptionQuotes([pick.symbol]);
      quote = quotes[pick.symbol];
    }
  }

  const mid = midPrice(quote);
  const ask = quote?.ap && quote.ap > 0 ? quote.ap : null;
  const bid = quote?.bp && quote.bp > 0 ? quote.bp : null;
  const price = ask ?? mid ?? null;

  return {
    symbol: pick.symbol,
    direction: input.direction,
    strike: Number(pick.strike_price),
    expiry,
    underlyingPrice: spot,
    bid,
    ask,
    mid,
    price: price != null ? Math.round(price * 100) / 100 : null,
  };
}
