import { NextResponse } from "next/server";
import { db } from "@/db";
import { positionsSnapshots } from "@/db/schema";
import { getBroker } from "@/lib/broker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Current paper positions + live P&L. Pass ?snapshot=1 to also persist a
// positions_snapshots row (used for history/sparkline).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const snapshot = url.searchParams.get("snapshot") === "1";

  const positions = await getBroker().listPositions();
  const totalUnrealizedPl = positions.reduce((s, p) => s + (p.unrealized_pl ? Number(p.unrealized_pl) : 0), 0);
  const totalMarketValue = positions.reduce((s, p) => s + (p.market_value ? Number(p.market_value) : 0), 0);
  const totalCostBasis = positions.reduce((s, p) => s + (p.cost_basis ? Number(p.cost_basis) : 0), 0);

  const payload = {
    positions,
    totalUnrealizedPl: Math.round(totalUnrealizedPl * 100) / 100,
    totalMarketValue: Math.round(totalMarketValue * 100) / 100,
    totalCostBasis: Math.round(totalCostBasis * 100) / 100,
    at: new Date().toISOString(),
  };

  if (snapshot) {
    await db.insert(positionsSnapshots).values({ payload });
  }

  return NextResponse.json({ ok: true, ...payload });
}
