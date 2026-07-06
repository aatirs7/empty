import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { proposals } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reject a proposal -> status only, no order.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const proposalId = Number(id);
  if (!Number.isInteger(proposalId)) {
    return NextResponse.json({ ok: false, error: "invalid proposal id" }, { status: 400 });
  }
  const [row] = await db.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
  if (!row) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  if (row.status !== "pending") {
    return NextResponse.json({ ok: false, error: `already ${row.status}` }, { status: 409 });
  }
  await db.update(proposals).set({ status: "rejected" }).where(eq(proposals.id, proposalId));
  return NextResponse.json({ ok: true, status: "rejected" });
}
