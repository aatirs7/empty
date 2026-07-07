/**
 * Broker abstraction. PAPER-ONLY.
 *
 * All execution and position management flows through a BrokerAdapter obtained
 * from getBroker(), which is the single choke point that asserts paper mode.
 * Today there is exactly one implementation (AlpacaBroker, paper). A future,
 * separately-approved phase could add a live adapter here behind its own gating
 * (dollar caps, confirmation, auto-off-on-switch). Until then, guardrail #1
 * holds: there is no live-trading code path.
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
  type Account,
  type Position,
  type Order,
  type PlaceOptionOrderInput,
  type PortfolioPL,
} from "./alpaca";

export interface BrokerAdapter {
  readonly mode: "paper";
  getAccount(): Promise<Account>;
  listPositions(): Promise<Position[]>;
  getPosition(symbol: string): Promise<Position | null>;
  placeOptionOrder(input: PlaceOptionOrderInput): Promise<Order>;
  waitForFill(orderId: string, timeoutMs?: number, intervalMs?: number): Promise<Order>;
  closePosition(symbol: string): Promise<Order>;
  getPortfolioPL(): Promise<PortfolioPL>;
  getWeeklyPL(): Promise<{ weeklyPL: number; currentEquity: number }>;
}

class AlpacaBroker implements BrokerAdapter {
  readonly mode = "paper" as const;
  getAccount = getAccount;
  listPositions = listPositions;
  getPosition = getPosition;
  placeOptionOrder = placeOptionOrder;
  waitForFill = waitForFill;
  closePosition = closePosition;
  getPortfolioPL = getPortfolioPL;
  getWeeklyPL = getWeeklyPL;
}

/** The active broker. Asserts paper mode; there is no live adapter. */
export function getBroker(): BrokerAdapter {
  const mode = process.env.TRADING_MODE ?? "paper";
  if (mode !== "paper") {
    throw new Error(`GUARDRAIL: TRADING_MODE must be "paper", got "${mode}". No live-trading path exists.`);
  }
  return new AlpacaBroker();
}
