/**
 * Per-account scorecard — a SUMMARY OF REAL TRADING ACTIVITY (not a simulation).
 * For each strategy's own paper account it reports the actual net P&L (Alpaca
 * account equity change = the source of truth), plus stats computed from the real
 * closed trades: win rate, average win/loss, average hold, best/worst, open
 * positions. No shadow sim, no baseline, no blending. All code-computed.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { orders, proposals } from "../db/schema";
import { getBroker } from "./broker";
import { getProfile } from "./profiles";
import { getProfileCost } from "./cost";
import { UI_PROFILE_IDS } from "./ui-profiles";

export interface ProfileScore {
  profileId: string;
  label: string;
  netPnl: number; // account equity change (realized + unrealized) — the truth
  realizedPnl: number; // sum of closed-trade realized P&L
  closed: number;
  wins: number;
  losses: number;
  winRate: number; // 0..1
  avgWinPct: number;
  avgLossPct: number;
  avgHoldDays: number;
  bestPnl: number;
  worstPnl: number;
  openCount: number;
  unrealizedPnl: number;
  apiCost: number;
}

export interface Scorecard {
  profiles: ProfileScore[];
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r2 = (n: number) => Math.round(n * 100) / 100;

export async function computeScorecard(): Promise<Scorecard> {
  const profiles: ProfileScore[] = [];
  for (const pid of UI_PROFILE_IDS) {
    const broker = getBroker(pid);
    const pl = await broker.getPortfolioPL().catch(() => ({ totalPL: 0 } as { totalPL: number }));
    const positions = await broker.listPositions().catch(() => []);
    const unrealized = positions.reduce((s, p) => s + (p.unrealized_pl != null ? Number(p.unrealized_pl) : 0), 0);

    // Real closed trades for this profile's account.
    const rows = await db
      .select({ rp: orders.realizedPl, entry: orders.filledPrice, exit: orders.exitPrice, sub: orders.submittedAt, exitAt: orders.exitAt })
      .from(orders)
      .innerJoin(proposals, eq(orders.proposalId, proposals.id))
      .where(and(eq(proposals.profileId, pid), isNotNull(orders.exitAt)));

    const pnls = rows.map((r) => (r.rp != null ? Number(r.rp) : 0));
    const closed = rows.length;
    const wins = pnls.filter((p) => p > 0).length;
    const losses = pnls.filter((p) => p < 0).length;
    const retPcts = rows.map((r) => {
      const e = r.entry ? Number(r.entry) : 0;
      const x = r.exit ? Number(r.exit) : 0;
      return e > 0 ? ((x - e) / e) * 100 : 0;
    });
    const holds = rows
      .map((r) => (r.sub && r.exitAt ? (new Date(r.exitAt).getTime() - new Date(r.sub).getTime()) / 86_400_000 : 0))
      .filter((h) => h > 0);

    profiles.push({
      profileId: pid,
      label: getProfile(pid).label,
      netPnl: r2(pl.totalPL),
      realizedPnl: r2(pnls.reduce((a, b) => a + b, 0)),
      closed,
      wins,
      losses,
      winRate: closed ? wins / closed : 0,
      avgWinPct: r2(mean(retPcts.filter((p) => p > 0))),
      avgLossPct: r2(mean(retPcts.filter((p) => p < 0))),
      avgHoldDays: Math.round(mean(holds) * 10) / 10,
      bestPnl: r2(pnls.length ? Math.max(...pnls) : 0),
      worstPnl: r2(pnls.length ? Math.min(...pnls) : 0),
      openCount: positions.length,
      unrealizedPnl: r2(unrealized),
      apiCost: (await getProfileCost(pid)).total,
    });
  }
  return { profiles };
}
