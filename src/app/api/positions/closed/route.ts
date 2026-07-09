import { NextResponse } from "next/server";
import { getClosedTrades } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Closed (sold) trades for the Positions "Closed" tab.
export async function GET(req: Request) {
  const profile = new URL(req.url).searchParams.get("profile") ?? undefined;
  const trades = await getClosedTrades(profile);
  const realized = trades.reduce((s, t) => s + (t.realizedPl != null ? Number(t.realizedPl) : 0), 0);
  return NextResponse.json({ ok: true, trades, realized: Math.round(realized * 100) / 100 });
}
