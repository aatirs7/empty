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
      .select({ id: orders.id, pid: orders.proposalId, qty: orders.qty, buyFill: orders.filledPrice })
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
    // Use the ACTUAL close fill + buy fill so realized P&L matches the account.
    let exitFill = pos?.current_price ? Number(pos.current_price) : pos ? Number(pos.avg_entry_price) : null;
    try {
      const filled = await broker.waitForFill(order.id, 8000, 500);
      if (filled.filled_avg_price && Number(filled.filled_avg_price) > 0) exitFill = Number(filled.filled_avg_price);
    } catch {
      /* keep the estimate */
    }
    let pl: number | null = null;
    if (ord) {
      const buyFill = ord.buyFill ? Number(ord.buyFill) : pos ? Number(pos.avg_entry_price) : null;
      const qty = ord.qty ?? (pos ? Math.abs(Number(pos.qty)) || 1 : 1);
      if (exitFill != null && buyFill != null) pl = Math.round((exitFill - buyFill) * 100 * qty * 100) / 100;
      await db
        .update(orders)
        .set({ exitPrice: exitFill != null ? String(exitFill) : null, exitAt: new Date(), realizedPl: pl != null ? String(pl) : null, exitReason: "manual" })
        .where(eq(orders.id, ord.id));
      await db.update(proposals).set({ status: "closed" }).where(eq(proposals.id, ord.pid));
    }
    // Sell notification for the manual close.
    const occ = parseOcc(symbol);
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
