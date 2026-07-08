import { NextResponse } from "next/server";
import { monitorTick, heartbeat } from "@/lib/monitor";
import { getClock } from "@/lib/alpaca";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // one tick; Vercel Pro allows the longer window

// One monitor tick, called by Vercel Cron every minute. PAPER-ONLY.
// Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set.
export async function GET(req: Request) {
  if (process.env.CRON_SECRET && req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (process.env.TRADING_MODE !== "paper") {
    return NextResponse.json({ ok: false, error: "not paper mode" }, { status: 403 });
  }
  try {
    await heartbeat(); // stamp "alive" every invocation, even when closed
    const clock = await getClock();
    if (!clock.is_open) return NextResponse.json({ ok: true, skipped: "market closed", nextOpen: clock.next_open });
    const fires = await monitorTick();
    return NextResponse.json({ ok: true, fires });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
