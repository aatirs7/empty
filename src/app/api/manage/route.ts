import { NextResponse } from "next/server";
import { autoManagePositions } from "@/lib/manage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Run goal-driven auto-management (closes positions per rules). PAPER-ONLY.
export async function POST() {
  if (process.env.TRADING_MODE !== "paper") {
    return NextResponse.json({ ok: false, error: "not paper mode" }, { status: 403 });
  }
  try {
    const result = await autoManagePositions();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
