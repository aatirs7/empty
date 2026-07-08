import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { positionsSnapshots, orders } from "@/db/schema";
import { getBroker } from "@/lib/broker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Current paper positions + live P&L. Pass ?snapshot=1 to also persist a
// positions_snapshots row (used for history/sparkline).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const snapshot = url.searchParams.get("snapshot") === "1";

  const raw = await getBroker().listPositions();

  // Attach the exact time each entry order was placed/filled, from our orders table.
  const syms = raw.map((p) => p.symbol);
  const ords = syms.length ? await db.select().from(orders).where(inArray(orders.contractSymbol, syms)) : [];
  const timeBySym = new Map<string, { placedAt: string; filledAt: string | null }>();
  for (const o of ords) {
    if (!o.contractSymbol || !o.submittedAt) continue;
    const placedAt = (o.submittedAt as Date).toISOString();
    const prev = timeBySym.get(o.contractSymbol);
    if (!prev || placedAt < prev.placedAt) {
      timeBySym.set(o.contractSymbol, { placedAt, filledAt: o.filledAt ? (o.filledAt as Date).toISOString() : null });
    }
  }
  const positions = raw.map((p) => ({
    ...p,
    placedAt: timeBySym.get(p.symbol)?.placedAt ?? null,
    filledAt: timeBySym.get(p.symbol)?.filledAt ?? null,
  }));
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
