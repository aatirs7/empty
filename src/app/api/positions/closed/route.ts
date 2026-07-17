import { NextResponse } from "next/server";
import { getClosedTrades, getClosedTotals } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Closed (sold) trades for the Positions "Closed" tab. `totals` are SQL-computed
// over ALL closed rows (ET day boundaries) — the trade list is display-only and
// length-capped, so summing it client-side would undercount.
export async function GET(req: Request) {
  const profile = new URL(req.url).searchParams.get("profile") ?? undefined;
  const [trades, totals] = await Promise.all([getClosedTrades(profile), getClosedTotals(profile)]);
  return NextResponse.json({ ok: true, trades, totals, realized: totals.all });
}
