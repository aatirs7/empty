/**
 * Goal-driven auto-management of open positions. PAPER-ONLY.
 *
 * When enabled, closes positions based on the user's risk tolerance and weekly
 * profit goal:
 *   - lock in gains once the weekly goal is reached
 *   - take profit / cut losses at tolerance thresholds
 *   - close positions about to expire
 * It never opens trades (that's auto-execute) and only ever closes — the worst
 * it can do on paper is exit a position.
 */
import { listPositions, closePosition, getWeeklyPL } from "./alpaca";
import { getSettings } from "./settings";
import { optionExpiryFromOcc } from "./format";

export type RiskTolerance = "conservative" | "balanced" | "aggressive";

interface Thresholds {
  takeProfit: number; // e.g. 0.5 = +50%
  stopLoss: number; // e.g. -0.4 = -40%
  closeDays: number; // close when this many days (or fewer) to expiry
}

export const THRESHOLDS: Record<RiskTolerance, Thresholds> = {
  conservative: { takeProfit: 0.3, stopLoss: -0.25, closeDays: 3 },
  balanced: { takeProfit: 0.5, stopLoss: -0.4, closeDays: 2 },
  aggressive: { takeProfit: 1.0, stopLoss: -0.6, closeDays: 1 },
};

export interface ManageAction {
  symbol: string;
  reason: string;
}
export interface ManageSummary {
  enabled: boolean;
  goalMet?: boolean;
  weeklyPL?: number;
  goal?: number;
  actions: ManageAction[];
}

export async function autoManagePositions(): Promise<ManageSummary> {
  const settings = await getSettings();
  if (!settings.autoManage) return { enabled: false, actions: [] };
  if (process.env.TRADING_MODE !== "paper") {
    throw new Error(`GUARDRAIL: TRADING_MODE must be "paper", got "${process.env.TRADING_MODE}".`);
  }

  const tol = THRESHOLDS[(settings.riskTolerance as RiskTolerance)] ?? THRESHOLDS.balanced;
  const goal = Number(settings.weeklyGoal);
  const { weeklyPL } = await getWeeklyPL();
  const goalMet = goal > 0 && weeklyPL >= goal;

  const positions = await listPositions();
  const actions: ManageAction[] = [];

  for (const p of positions) {
    const plPc = p.unrealized_plpc != null ? Number(p.unrealized_plpc) : 0;
    const expiry = optionExpiryFromOcc(p.symbol);
    const days = expiry ? Math.ceil((Date.parse(`${expiry}T00:00:00Z`) - Date.now()) / 86_400_000) : Infinity;

    let reason = "";
    if (goalMet && plPc > 0) reason = "weekly goal reached, locking in the gain";
    else if (plPc >= tol.takeProfit) reason = `hit take-profit (+${Math.round(plPc * 100)}%)`;
    else if (plPc <= tol.stopLoss) reason = `hit stop-loss (${Math.round(plPc * 100)}%)`;
    else if (days <= tol.closeDays) reason = "about to expire";

    if (reason) {
      try {
        await closePosition(p.symbol);
        actions.push({ symbol: p.symbol, reason });
      } catch {
        // ignore a single failed close; continue managing the rest
      }
    }
  }

  return { enabled: true, goalMet, weeklyPL, goal, actions };
}
