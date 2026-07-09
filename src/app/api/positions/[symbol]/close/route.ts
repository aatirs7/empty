import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { orders, proposals } from "@/db/schema";
import { getBroker } from "@/lib/broker";
import { sendPush } from "@/lib/push";
import { parseOcc } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Flatten a single position. PAPER-ONLY (closePosition re-asserts TRADING_MODE).
export async function POST(_req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  if (process.env.TRADING_MODE !== "paper") {
    return NextResponse.json({ ok: false, error: "not paper mode" }, { status: 403 });
  }
  try {
    // Find the originating order/proposal FIRST so we close on the right account
    // (QQQ trades live on a separate paper account from SniperBot).
    const [ord] = await db
      .select({ id: orders.id, pid: orders.proposalId, qty: orders.qty })
      .from(orders)
      .where(eq(orders.contractSymbol, symbol))
      .orderBy(desc(orders.id))
      .limit(1);
    let profileId: string | undefined;
    if (ord?.pid) {
      const [prop] = await db.select({ profileId: proposals.profileId }).from(proposals).where(eq(proposals.id, ord.pid)).limit(1);
      profileId = prop?.profileId ?? undefined;
    }
    const broker = getBroker(profileId);
    const pos = await broker.getPosition(symbol).catch(() => null);
    const order = await broker.closePosition(symbol);
    // Record the exit (price, P&L) and mark the proposal closed.
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
    // Sell notification for the manual close.
    const occ = parseOcc(symbol);
    const pl = pos?.unrealized_pl != null ? Number(pos.unrealized_pl) : null;
    await sendPush(
      `Sold ${occ?.underlying ?? symbol}`,
      pl != null ? `Closed manually · ${pl >= 0 ? "+" : ""}$${pl.toFixed(2)}.` : "Position closed manually.",
      "/positions",
    ).catch(() => {});
    return NextResponse.json({ ok: true, orderId: order.id, status: order.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "error" }, { status: 502 });
  }
}
