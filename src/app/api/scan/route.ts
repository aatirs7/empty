import { NextResponse } from "next/server";
import { runScan } from "@/lib/scanner";
import { autoManagePositions } from "@/lib/manage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // full-universe scan; Vercel Pro window

// Overnight job (Vercel Cron, ~midnight ET): rebuild the session's candidates off
// the fully-settled prior daily close AND run the daily close-through exits.
// Guarded by CRON_SECRET. PAPER-ONLY.
export async function GET(req: Request) {
  if (process.env.CRON_SECRET && req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const scan = await runScan();
    let manage = null;
    try {
      manage = await autoManagePositions();
    } catch (e) {
      manage = { error: e instanceof Error ? e.message : "manage failed" };
    }
    return NextResponse.json({ ok: true, scan, manage });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
