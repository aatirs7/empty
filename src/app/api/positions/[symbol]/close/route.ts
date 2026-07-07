import { NextResponse } from "next/server";
import { getBroker } from "@/lib/broker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Flatten a single position. PAPER-ONLY (closePosition re-asserts TRADING_MODE).
export async function POST(_req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  if (process.env.TRADING_MODE !== "paper") {
    return NextResponse.json({ ok: false, error: "not paper mode" }, { status: 403 });
  }
  try {
    const order = await getBroker().closePosition(symbol);
    return NextResponse.json({ ok: true, orderId: order.id, status: order.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "error" }, { status: 502 });
  }
}
