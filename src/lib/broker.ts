/**
 * Broker abstraction. PAPER-ONLY, and now PER-PROFILE: each strategy profile can
 * trade its own paper account (SniperBot on the default keys, QQQ 0DTE on the
 * ALPACA_*_2 account). getBroker(profileId) binds the right account keys; every
 * TRADING call runs inside withAccount() so the correct account is used.
 *
 * Guardrail #1 holds: getBroker asserts paper and there is no live adapter.
 */
import {
  getAccount,
  listPositions,
  getPosition,
  placeOptionOrder,
  waitForFill,
  closePosition,
  getClosedOrders,
  getPortfolioPL,
  getWeeklyPL,
  withAccount,
  type Account,
  type Position,
  type Order,
  type PlaceOptionOrderInput,
  type PortfolioPL,
  type AccountKeys,
} from "./alpaca";

export interface BrokerAdapter {
  readonly mode: "paper";
  getAccount(): Promise<Account>;
  listPositions(): Promise<Position[]>;
  getPosition(symbol: string): Promise<Position | null>;
  placeOptionOrder(input: PlaceOptionOrderInput): Promise<Order>;
  waitForFill(orderId: string, timeoutMs?: number, intervalMs?: number): Promise<Order>;
  closePosition(symbol: string, qty?: number): Promise<Order>;
  getClosedOrders(symbol: string): Promise<Order[]>;
  getPortfolioPL(): Promise<PortfolioPL>;
  getWeeklyPL(): Promise<{ weeklyPL: number; currentEquity: number }>;
}

/** Account keys for a profile: each strategy trades its OWN paper account so P&L
 *  never blends. QQQ account (ALPACA_*_2, PA3NPEDZA11B) → owner handed it from the
 *  PAUSED qqq_0dte to qqq_manual on 2026-07-15 (qqq_0dte keeps read access to its
 *  history; it is shelved, so it can place no new orders). SBv2 → ALPACA_*_3.
 *  SBv1 (sniper_swing) and the shelved zones_legacy share the default keys. Falls
 *  back to the default keys when a profile's account isn't configured. */
function accountKeysFor(profileId?: string): AccountKeys | null {
  if (profileId === "qqq_0dte" || profileId === "qqq_manual") {
    const id = process.env.ALPACA_API_KEY_ID2?.trim();
    const secret = process.env.ALPACA_API_SECRET_KEY2?.trim();
    if (id && secret) return { id, secret };
  }
  if (profileId === "sbv2") {
    const id = process.env.ALPACA_API_KEY_ID3?.trim();
    const secret = process.env.ALPACA_API_SECRET_KEY3?.trim();
    if (id && secret) return { id, secret };
  }
  if (profileId === "sbv3") {
    // SBv2 clone for Farrukh's update — own account when keys5 exist; monitor.ts
    // hard-gates its auto-buy/manage on keys5 so the default-keys fallback stays
    // read-only (it must never trade SBv1's account).
    const id = process.env.ALPACA_API_KEY_ID5?.trim();
    const secret = process.env.ALPACA_API_SECRET_KEY5?.trim();
    if (id && secret) return { id, secret };
  }
  return null; // default keys
}

class AlpacaBroker implements BrokerAdapter {
  readonly mode = "paper" as const;
  constructor(private keys: AccountKeys | null) {}
  private run<T>(fn: () => Promise<T>): Promise<T> {
    return this.keys ? withAccount(this.keys, fn) : fn();
  }
  getAccount = () => this.run(() => getAccount());
  listPositions = () => this.run(() => listPositions());
  getPosition = (symbol: string) => this.run(() => getPosition(symbol));
  placeOptionOrder = (input: PlaceOptionOrderInput) => this.run(() => placeOptionOrder(input));
  waitForFill = (orderId: string, timeoutMs?: number, intervalMs?: number) => this.run(() => waitForFill(orderId, timeoutMs, intervalMs));
  closePosition = (symbol: string, qty?: number) => this.run(() => closePosition(symbol, qty));
  getClosedOrders = (symbol: string) => this.run(() => getClosedOrders(symbol));
  getPortfolioPL = () => this.run(() => getPortfolioPL());
  getWeeklyPL = () => this.run(() => getWeeklyPL());
}

/** The active broker for a profile. Asserts paper mode; there is no live adapter. */
export function getBroker(profileId?: string): BrokerAdapter {
  const mode = process.env.TRADING_MODE ?? "paper";
  if (mode !== "paper") {
    throw new Error(`GUARDRAIL: TRADING_MODE must be "paper", got "${mode}". No live-trading path exists.`);
  }
  return new AlpacaBroker(accountKeysFor(profileId));
}
