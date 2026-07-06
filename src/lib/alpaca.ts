/**
 * Alpaca broker layer — PAPER ONLY.
 *
 * Two base URLs:
 *   - trading (orders, positions, option contracts): ALPACA_BASE_URL
 *   - market data (quotes, snapshots):                ALPACA_DATA_URL
 *
 * GUARDRAIL: the trading base URL is pinned to the paper endpoint. Any other
 * value throws. There is no live-trading path in this repo.
 */

const PAPER_TRADING_URL = "https://paper-api.alpaca.markets";
const DEFAULT_DATA_URL = "https://data.alpaca.markets";

/** Strip trailing slash and any trailing API-version segment (/v2, /v1beta1, ...). */
function normalizeBase(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v\d[\w]*$/, "");
}

function tradingBase(): string {
  const base = normalizeBase(process.env.ALPACA_BASE_URL ?? PAPER_TRADING_URL);
  if (base !== PAPER_TRADING_URL) {
    throw new Error(
      `GUARDRAIL: ALPACA_BASE_URL must be the paper endpoint (${PAPER_TRADING_URL}), got "${process.env.ALPACA_BASE_URL}". Live trading is not supported.`,
    );
  }
  return base;
}

function dataBase(): string {
  return normalizeBase(process.env.ALPACA_DATA_URL ?? DEFAULT_DATA_URL);
}

function authHeaders(): Record<string, string> {
  const id = process.env.ALPACA_API_KEY_ID;
  const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!id || !secret) {
    throw new Error("Missing ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY");
  }
  return {
    "APCA-API-KEY-ID": id,
    "APCA-API-SECRET-KEY": secret,
  };
}

async function request<T>(base: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...authHeaders(),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Alpaca ${init.method ?? "GET"} ${path} -> ${res.status}: ${text}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

const trading = <T>(path: string, init?: RequestInit) => request<T>(tradingBase(), path, init);
const data = <T>(path: string, init?: RequestInit) => request<T>(dataBase(), path, init);

// ---------- Types (only the fields we use) ----------

export interface Account {
  id: string;
  status: string;
  options_trading_level?: number;
  options_approved_level?: number;
  buying_power: string;
  cash: string;
}

export interface OptionContract {
  id: string;
  symbol: string; // OCC symbol, e.g. AAPL240119C00190000
  underlying_symbol: string;
  type: "call" | "put";
  strike_price: string;
  expiration_date: string; // YYYY-MM-DD
  status: string;
  tradable: boolean;
}

export interface OptionQuote {
  ap: number; // ask price
  as?: number; // ask size
  bp: number; // bid price
  bs?: number; // bid size
  t: string;
}

export interface Order {
  id: string;
  client_order_id: string;
  symbol: string;
  qty: string;
  side: string;
  type: string;
  limit_price: string | null;
  filled_avg_price: string | null;
  filled_qty: string;
  status: string; // new | accepted | filled | partially_filled | canceled | rejected | ...
  submitted_at: string | null;
  filled_at: string | null;
}

export interface Position {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  market_value: string | null;
  cost_basis: string;
  unrealized_pl: string | null;
  unrealized_plpc: string | null;
  current_price: string | null;
  asset_class: string;
}

// ---------- Trading API ----------

export function getAccount(): Promise<Account> {
  return trading<Account>("/v2/account");
}

export interface Asset {
  symbol: string;
  name: string;
  class: string;
  status: string;
  tradable: boolean;
}

/** Look up a tradable asset by symbol, or null if it doesn't exist. */
export async function getAsset(symbol: string): Promise<Asset | null> {
  try {
    return await trading<Asset>(`/v2/assets/${encodeURIComponent(symbol)}`);
  } catch {
    return null;
  }
}

export function listPositions(): Promise<Position[]> {
  return trading<Position[]>("/v2/positions");
}

/** Single position by symbol, or null if none open. */
export async function getPosition(symbol: string): Promise<Position | null> {
  try {
    return await trading<Position>(`/v2/positions/${encodeURIComponent(symbol)}`);
  } catch {
    return null;
  }
}

export interface Bar {
  t: string;
  c: number;
}

/** Daily closing bars for an underlying stock (free IEX feed), most recent last. */
export async function getStockBars(symbol: string, days = 90): Promise<Bar[]> {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - days);
  const q = new URLSearchParams({
    timeframe: "1Day",
    start: start.toISOString().slice(0, 10),
    feed: "iex",
    limit: "1000",
    adjustment: "raw",
  });
  const resp = await data<{ bars?: { t: string; c: number }[] }>(
    `/v2/stocks/${encodeURIComponent(symbol)}/bars?${q.toString()}`,
  );
  return (resp.bars ?? []).map((b) => ({ t: b.t, c: b.c }));
}

export function getOrder(id: string): Promise<Order> {
  return trading<Order>(`/v2/orders/${id}`);
}

export interface ListContractsParams {
  underlyingSymbol: string;
  type?: "call" | "put";
  expirationDateGte?: string; // YYYY-MM-DD
  expirationDateLte?: string;
  strikePriceGte?: number;
  strikePriceLte?: number;
  limit?: number;
}

export async function listOptionContracts(params: ListContractsParams): Promise<OptionContract[]> {
  const q = new URLSearchParams();
  q.set("underlying_symbols", params.underlyingSymbol);
  q.set("status", "active");
  q.set("limit", String(params.limit ?? 1000));
  if (params.type) q.set("type", params.type);
  if (params.expirationDateGte) q.set("expiration_date_gte", params.expirationDateGte);
  if (params.expirationDateLte) q.set("expiration_date_lte", params.expirationDateLte);
  if (params.strikePriceGte != null) q.set("strike_price_gte", String(params.strikePriceGte));
  if (params.strikePriceLte != null) q.set("strike_price_lte", String(params.strikePriceLte));

  const all: OptionContract[] = [];
  let pageToken: string | undefined;
  do {
    if (pageToken) q.set("page_token", pageToken);
    const resp = await trading<{ option_contracts: OptionContract[]; next_page_token: string | null }>(
      `/v2/options/contracts?${q.toString()}`,
    );
    all.push(...(resp.option_contracts ?? []));
    pageToken = resp.next_page_token ?? undefined;
  } while (pageToken && all.length < (params.limit ?? 1000));
  return all;
}

export interface PlaceOptionOrderInput {
  symbol: string; // OCC symbol
  qty: number;
  side: "buy"; // paper long options only in this app
  limitPrice: number;
}

/**
 * Places a PAPER limit option order. Re-asserts the paper guardrails at the
 * call site (TRADING_MODE + per-order contract cap) so nothing can place an
 * order outside the rules.
 */
export async function placeOptionOrder(input: PlaceOptionOrderInput): Promise<Order> {
  if (process.env.TRADING_MODE !== "paper") {
    throw new Error(`GUARDRAIL: TRADING_MODE must be "paper", got "${process.env.TRADING_MODE}".`);
  }
  const cap = Number(process.env.MAX_CONTRACTS_PER_ORDER ?? 1);
  if (input.qty > cap) {
    throw new Error(`GUARDRAIL: qty ${input.qty} exceeds MAX_CONTRACTS_PER_ORDER (${cap}).`);
  }
  const body = {
    symbol: input.symbol,
    qty: String(input.qty),
    side: input.side,
    type: "limit",
    time_in_force: "day",
    limit_price: input.limitPrice.toFixed(2),
  };
  return trading<Order>("/v2/orders", { method: "POST", body: JSON.stringify(body) });
}

/** Polls an order until it reaches a terminal state or the timeout elapses. */
export async function waitForFill(orderId: string, timeoutMs = 20_000, intervalMs = 1500): Promise<Order> {
  const terminal = new Set(["filled", "canceled", "rejected", "expired"]);
  const deadline = Date.now() + timeoutMs;
  let order = await getOrder(orderId);
  while (!terminal.has(order.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    order = await getOrder(orderId);
  }
  return order;
}

// ---------- Market Data API ----------

/** Latest underlying stock trade price (spot). Uses the free IEX feed. */
export async function getUnderlyingPrice(symbol: string): Promise<number> {
  const resp = await data<{ trade?: { p: number } }>(
    `/v2/stocks/${encodeURIComponent(symbol)}/trades/latest?feed=iex`,
  );
  if (!resp.trade?.p) throw new Error(`No latest trade for ${symbol}`);
  return resp.trade.p;
}

/** Latest option quotes for one or more OCC symbols. Uses the indicative feed (free tier). */
export async function getOptionQuotes(occSymbols: string[]): Promise<Record<string, OptionQuote>> {
  if (occSymbols.length === 0) return {};
  const q = new URLSearchParams();
  q.set("symbols", occSymbols.join(","));
  q.set("feed", "indicative");
  const resp = await data<{ quotes?: Record<string, OptionQuote> }>(
    `/v1beta1/options/quotes/latest?${q.toString()}`,
  );
  return resp.quotes ?? {};
}

/** Close (liquidate) an entire position by symbol. PAPER-ONLY. Returns the closing order. */
export async function closePosition(symbol: string): Promise<Order> {
  if (process.env.TRADING_MODE !== "paper") {
    throw new Error(`GUARDRAIL: TRADING_MODE must be "paper", got "${process.env.TRADING_MODE}".`);
  }
  return trading<Order>(`/v2/positions/${encodeURIComponent(symbol)}`, { method: "DELETE" });
}

export interface PortfolioPL {
  baseValue: number; // equity at the start of the period (~account inception)
  currentEquity: number;
  totalPL: number; // currentEquity - baseValue (realized + unrealized, paper)
}

/** All-time paper account P&L from Alpaca's portfolio history. */
export async function getPortfolioPL(): Promise<PortfolioPL> {
  const resp = await trading<{ base_value: number; equity: (number | null)[] }>(
    "/v2/account/portfolio/history?period=all&timeframe=1D",
  );
  const equitySeries = (resp.equity ?? []).filter((v): v is number => typeof v === "number");
  const currentEquity = equitySeries.length ? equitySeries[equitySeries.length - 1] : resp.base_value;
  const baseValue = resp.base_value ?? 0;
  return {
    baseValue,
    currentEquity,
    totalPL: Math.round((currentEquity - baseValue) * 100) / 100,
  };
}

/** Mid price from a quote, falling back to ask, then bid. Returns null if unpriced. */
export function midPrice(quote: OptionQuote | undefined): number | null {
  if (!quote) return null;
  const { ap, bp } = quote;
  if (ap > 0 && bp > 0) return (ap + bp) / 2;
  if (ap > 0) return ap;
  if (bp > 0) return bp;
  return null;
}
