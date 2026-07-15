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
 *  never blends. QQQ 0DTE → ALPACA_*_2, SBv2 → ALPACA_*_3, QQQ Manual → ALPACA_*_4.
 *  SBv1 (sniper_swing) and the shelved zones_legacy share the default keys. Falls
 *  back when a profile's own account isn't configured (shadow-only until then).
 *  QQQ Manual falls back to the QQQ account (*_2) for READS only — its auto-buy and
 *  exit management are hard-gated on keys4 in monitor.ts, so the two QQQ variants
 *  can never place or manage orders on the same account. */
function accountKeysFor(profileId?: string): AccountKeys | null {
  if (profileId === "qqq_0dte" || profileId === "qqq_manual") {
    if (profileId === "qqq_manual") {
      const id4 = process.env.ALPACA_API_KEY_ID4?.trim();
      const secret4 = process.env.ALPACA_API_SECRET_KEY4?.trim();
      if (id4 && secret4) return { id: id4, secret: secret4 };
    }
    const id = process.env.ALPACA_API_KEY_ID2?.trim();
    const secret = process.env.ALPACA_API_SECRET_KEY2?.trim();
    if (id && secret) return { id, secret };
  }
  if (profileId === "sbv2") {
    const id = process.env.ALPACA_API_KEY_ID3?.trim();
    const secret = process.env.ALPACA_API_SECRET_KEY3?.trim();
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
