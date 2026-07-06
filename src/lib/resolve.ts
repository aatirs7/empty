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

export interface ResolveInput {
  symbol: string;
  direction: "call" | "put";
  strikeHint: string;
  expiryHint: string;
  maxPrice?: number; // prefer contracts cheaper than this per share
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

/** "2-4 weeks" / "monthly" -> ~21 days; otherwise nearest weekly (>= 2 days out). */
function pickExpiry(expiries: string[], hint: string): string {
  const uniqueSorted = [...new Set(expiries)].sort();
  const h = hint.toLowerCase();
  const isWindow = /2\s*-\s*4|2 to 4|two to four|3\s*week|month/.test(h);
  if (isWindow) {
    const inWindow = uniqueSorted.filter((e) => daysFromToday(e) >= 10 && daysFromToday(e) <= 35);
    const pool = inWindow.length ? inWindow : uniqueSorted.filter((e) => daysFromToday(e) >= 5);
    const chooseFrom = pool.length ? pool : uniqueSorted;
    return chooseFrom.reduce((best, e) => (Math.abs(daysFromToday(e) - 21) < Math.abs(daysFromToday(best) - 21) ? e : best));
  }
  const pool = uniqueSorted.filter((e) => daysFromToday(e) >= 2);
  return (pool.length ? pool : uniqueSorted)[0];
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

  const now = new Date();
  const gte = new Date(now);
  gte.setUTCDate(gte.getUTCDate() + 1);
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
    throw new Error(`No ${input.direction} contracts found for ${input.symbol} in the next 60 days.`);
  }

  const expiry = pickExpiry(
    contracts.map((c) => c.expiration_date),
    input.expiryHint,
  );
  const atExpiry = contracts.filter((c) => c.expiration_date === expiry && c.tradable !== false);
  const poolAll = atExpiry.length ? atExpiry : contracts.filter((c) => c.expiration_date === expiry);

  let pick: OptionContract | null = null;
  let quote: OptionQuote | undefined;

  // Cheap-contract targeting: quote a near-ATM -> OTM window and pick the
  // priciest contract still under maxPrice (best odds among affordable cheap
  // options). Falls back to the Brain's strike hint if nothing is priced.
  if (input.maxPrice && input.maxPrice > 0) {
    const lo = input.direction === "call" ? spot * 0.98 : spot * 0.6;
    const hi = input.direction === "call" ? spot * 1.4 : spot * 1.02;
    let candidates = poolAll.filter((c) => Number(c.strike_price) >= lo && Number(c.strike_price) <= hi);
    candidates.sort((a, b) =>
      input.direction === "call"
        ? Number(a.strike_price) - Number(b.strike_price)
        : Number(b.strike_price) - Number(a.strike_price),
    );
    candidates = candidates.slice(0, 50);
    if (candidates.length > 0) {
      const quotes = await getOptionQuotes(candidates.map((c) => c.symbol));
      const priced = candidates
        .map((c) => ({ c, q: quotes[c.symbol], ask: quotes[c.symbol]?.ap ?? 0 }))
        .filter((x) => x.ask > 0.05);
      const affordable = priced.filter((x) => x.ask <= input.maxPrice!);
      const chosen =
        affordable.length > 0
          ? affordable.reduce((best, x) => (x.ask > best.ask ? x : best))
          : priced.length > 0
            ? priced.reduce((best, x) => (x.ask < best.ask ? x : best))
            : null;
      if (chosen) {
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
    const quotes = await getOptionQuotes([pick.symbol]);
    quote = quotes[pick.symbol];
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
