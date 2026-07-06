import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { proposals } from "@/db/schema";
import { resolveContract } from "@/lib/resolve";
import { computeRisk } from "@/lib/risk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Live "dollars at risk before you tap Approve": resolve the pending proposal's
// hints to a real contract, pull an indicative quote, and compute risk math.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const proposalId = Number(id);
  if (!Number.isInteger(proposalId)) {
    return NextResponse.json({ ok: false, error: "invalid proposal id" }, { status: 400 });
  }
  const [p] = await db.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
  if (!p) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  if (p.strategy === "no_trade" || !p.direction || p.direction === "none") {
    return NextResponse.json({ ok: false, error: "no_trade — nothing to price" }, { status: 400 });
  }

  const direction = p.direction as "call" | "put";
  try {
    const resolved = await resolveContract({
      symbol: p.symbol,
      direction,
      strikeHint: p.strikeHint ?? "ATM",
      expiryHint: p.expiryHint ?? "nearest weekly",
    });
    const risk =
      resolved.price != null
        ? computeRisk({
            direction,
            strike: resolved.strike,
            premiumPerShare: resolved.price,
            qty: 1,
            underlyingPrice: resolved.underlyingPrice,
          })
        : null;
    return NextResponse.json({ ok: true, resolved, risk });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "error" }, { status: 502 });
  }
}
