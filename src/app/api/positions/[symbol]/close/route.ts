import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { orders, proposals } from "@/db/schema";
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
    const broker = getBroker();
    const pos = await broker.getPosition(symbol).catch(() => null);
    const order = await broker.closePosition(symbol);
    // Record the exit (price, P&L) and mark the proposal closed.
    const [ord] = await db
      .select({ id: orders.id, pid: orders.proposalId, qty: orders.qty })
      .from(orders)
      .where(eq(orders.contractSymbol, symbol))
      .orderBy(desc(orders.id))
      .limit(1);
    if (ord) {
      if (pos) {
        const exit = pos.current_price ? Number(pos.current_price) : Number(pos.avg_entry_price);
        const realizedPl = pos.unrealized_pl != null ? Math.round(Number(pos.unrealized_pl) * 100) / 100 : null;
        await db
          .update(orders)
          .set({ exitPrice: String(exit), exitAt: new Date(), realizedPl: realizedPl != null ? String(realizedPl) : null, exitReason: "manual" })
          .where(eq(orders.id, ord.id));
      }
      await db.update(proposals).set({ status: "closed" }).where(eq(proposals.id, ord.pid));
    }
    return NextResponse.json({ ok: true, orderId: order.id, status: order.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "error" }, { status: 502 });
  }
}
