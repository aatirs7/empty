import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { watchlist } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Toggle active on/off.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wid = Number(id);
  if (!Number.isInteger(wid)) return NextResponse.json({ ok: false, error: "bad id" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { active?: boolean };
  if (typeof body.active !== "boolean") {
    return NextResponse.json({ ok: false, error: "active must be boolean" }, { status: 400 });
  }
  await db.update(watchlist).set({ active: body.active }).where(eq(watchlist.id, wid));
  const rows = await db.select().from(watchlist).orderBy(watchlist.symbol);
  return NextResponse.json({ ok: true, watchlist: rows });
}

// Remove a symbol entirely.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wid = Number(id);
  if (!Number.isInteger(wid)) return NextResponse.json({ ok: false, error: "bad id" }, { status: 400 });
  await db.delete(watchlist).where(eq(watchlist.id, wid));
  const rows = await db.select().from(watchlist).orderBy(watchlist.symbol);
  return NextResponse.json({ ok: true, watchlist: rows });
}
