/**
 * Auto-management of open positions. PAPER-ONLY.
 *
 * Two exit regimes:
 *  - ZONE positions (opened off a zone setup): STRUCTURAL exit per STRATEGY.md —
 *    close when a daily candle closes back THROUGH the zone against the position
 *    (the rejection failed). No fixed profit target. Plus a near-expiry safety.
 *  - Non-zone positions: the goal / take-profit / stop-loss / near-expiry rules.
 *
 * It never opens trades (that's auto-execute) and only ever closes.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { orders, proposals } from "../db/schema";
import { getBroker } from "./broker";
import { getStockBars } from "./alpaca";
import { getSettings } from "./settings";
import { optionExpiryFromOcc, parseOcc } from "./format";
import type { ZoneSetup } from "./strategy";

export type RiskTolerance = "conservative" | "balanced" | "aggressive";

interface Thresholds {
  takeProfit: number;
  stopLoss: number;
  closeDays: number;
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

/** The zone a position was opened from (latest order -> proposal.zoneSetup), or null. */
async function zoneOfPosition(occSymbol: string): Promise<{ bottom: number; top: number; direction: "call" | "put" } | null> {
  const [ord] = await db
    .select()
    .from(orders)
    .where(eq(orders.contractSymbol, occSymbol))
    .orderBy(desc(orders.id))
    .limit(1);
  if (!ord?.proposalId) return null;
  const [prop] = await db.select().from(proposals).where(eq(proposals.id, ord.proposalId)).limit(1);
  const zs = prop?.zoneSetup as ZoneSetup | null;
  if (!zs?.active_zone || (zs.direction !== "call" && zs.direction !== "put")) return null;
  return { bottom: zs.active_zone.bottom, top: zs.active_zone.top, direction: zs.direction };
}

/** Most recent COMPLETED daily close of the underlying (excludes today's forming bar). */
async function lastCompletedClose(underlying: string): Promise<number | null> {
  try {
    const bars = await getStockBars(underlying, 10);
    const today = new Date().toISOString().slice(0, 10);
    const completed = bars.filter((b) => b.t.slice(0, 10) < today);
    return completed.length ? completed[completed.length - 1].c : null;
  } catch {
    return null;
  }
}

export async function autoManagePositions(profileId?: string): Promise<ManageSummary> {
  const settings = await getSettings();
  if (!settings.autoManage) return { enabled: false, actions: [] };
  if (process.env.TRADING_MODE !== "paper") {
    throw new Error(`GUARDRAIL: TRADING_MODE must be "paper", got "${process.env.TRADING_MODE}".`);
  }

  const broker = getBroker(profileId);
  const tol = THRESHOLDS[(settings.riskTolerance as RiskTolerance)] ?? THRESHOLDS.balanced;
  const goal = Number(settings.weeklyGoal);
  const { weeklyPL } = await broker.getWeeklyPL();
  const goalMet = goal > 0 && weeklyPL >= goal;

  const positions = await broker.listPositions();
  const actions: ManageAction[] = [];

  for (const p of positions) {
    const plPc = p.unrealized_plpc != null ? Number(p.unrealized_plpc) : 0;
    const expiry = optionExpiryFromOcc(p.symbol);
    const days = expiry ? Math.ceil((Date.parse(`${expiry}T00:00:00Z`) - Date.now()) / 86_400_000) : Infinity;

    let reason = "";
    const zone = await zoneOfPosition(p.symbol);
    if (zone) {
      // Structural exit: a daily close back through the zone against the position.
      const occ = parseOcc(p.symbol);
      const lastClose = occ ? await lastCompletedClose(occ.underlying) : null;
      if (lastClose != null && zone.direction === "call" && lastClose < zone.bottom) {
        reason = `closed through the zone (${lastClose} < ${zone.bottom}); rejection failed`;
      } else if (lastClose != null && zone.direction === "put" && lastClose > zone.top) {
        reason = `closed through the zone (${lastClose} > ${zone.top}); rejection failed`;
      } else if (days <= 1) {
        reason = "about to expire";
      }
    } else {
      // Non-zone position: goal / take-profit / stop-loss / near-expiry.
      if (goalMet && plPc > 0) reason = "weekly goal reached, locking in the gain";
      else if (plPc >= tol.takeProfit) reason = `hit take-profit (+${Math.round(plPc * 100)}%)`;
      else if (plPc <= tol.stopLoss) reason = `hit stop-loss (${Math.round(plPc * 100)}%)`;
      else if (days <= tol.closeDays) reason = "about to expire";
    }

    if (reason) {
      try {
        await broker.closePosition(p.symbol);
        // Record the exit so the trade shows in Closed (not vanish from both tabs).
        const exit = p.current_price ? Number(p.current_price) : Number(p.avg_entry_price);
        const realizedPl = p.unrealized_pl != null ? Math.round(Number(p.unrealized_pl) * 100) / 100 : null;
        const [ord] = await db
          .select({ id: orders.id, pid: orders.proposalId })
          .from(orders)
          .where(eq(orders.contractSymbol, p.symbol))
          .orderBy(desc(orders.id))
          .limit(1);
        if (ord) {
          await db
            .update(orders)
            .set({ exitPrice: String(exit), exitAt: new Date(), realizedPl: realizedPl != null ? String(realizedPl) : null, exitReason: reason.slice(0, 60) })
            .where(eq(orders.id, ord.id));
          await db.update(proposals).set({ status: "closed" }).where(eq(proposals.id, ord.pid));
        }
        actions.push({ symbol: p.symbol, reason });
      } catch {
        // ignore a single failed close; continue managing the rest
      }
    }
  }

  return { enabled: true, goalMet, weeklyPL, goal, actions };
}
