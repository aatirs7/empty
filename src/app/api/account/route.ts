import { NextResponse } from "next/server";
import { getAccount } from "@/lib/alpaca";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Live paper account balance (equity, cash, buying power, today's change).
export async function GET() {
  try {
    const a = await getAccount();
    const equity = Number(a.equity ?? a.portfolio_value ?? 0);
    const lastEquity = Number(a.last_equity ?? equity);
    return NextResponse.json({
      ok: true,
      accountNumber: a.account_number ?? null,
      equity,
      cash: Number(a.cash),
      buyingPower: Number(a.buying_power),
      positionsValue: Number(a.long_market_value ?? 0),
      dayPL: Math.round((equity - lastEquity) * 100) / 100,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
