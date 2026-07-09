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
  getPortfolioPL(): Promise<PortfolioPL>;
  getWeeklyPL(): Promise<{ weeklyPL: number; currentEquity: number }>;
}

/** Account keys for a profile: QQQ 0DTE uses the second paper account; others default. */
function accountKeysFor(profileId?: string): AccountKeys | null {
  if (profileId === "qqq_0dte") {
    const id = process.env.ALPACA_API_KEY_ID2?.trim();
    const secret = process.env.ALPACA_API_SECRET_KEY2?.trim();
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
