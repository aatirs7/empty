import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { watchlist } from "@/db/schema";
import { getAsset } from "@/lib/alpaca";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db.select().from(watchlist).orderBy(watchlist.symbol);
  return NextResponse.json({ ok: true, watchlist: rows });
}

// Add a symbol (or re-activate it). Validates it's a tradable US equity.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { symbol?: string };
  const symbol = (body.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z]{1,5}$/.test(symbol)) {
    return NextResponse.json({ ok: false, error: "Enter a valid ticker (1-5 letters)." }, { status: 400 });
  }

  const asset = await getAsset(symbol);
  if (!asset || asset.class !== "us_equity" || !asset.tradable) {
    return NextResponse.json({ ok: false, error: `"${symbol}" isn't a tradable US stock.` }, { status: 400 });
  }

  const [existing] = await db.select().from(watchlist).where(eq(watchlist.symbol, symbol)).limit(1);
  if (existing) {
    if (!existing.active) await db.update(watchlist).set({ active: true }).where(eq(watchlist.id, existing.id));
  } else {
    await db.insert(watchlist).values({ symbol, notes: asset.name ?? null, active: true });
  }

  const rows = await db.select().from(watchlist).orderBy(watchlist.symbol);
  return NextResponse.json({ ok: true, watchlist: rows });
}
