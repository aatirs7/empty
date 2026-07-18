import { NextResponse } from "next/server";
import { monitorTick, heartbeat } from "@/lib/monitor";
import { getClock } from "@/lib/alpaca";
import { inEtTradingWindow } from "@/lib/market-hours";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // one tick; Vercel Pro allows the longer window

// Cached Alpaca clock for the holiday case: inside the ET window on a holiday the
// clock says closed with a far-future next_open — remember that (module scope
// survives on warm instances) so repeat invocations skip even the network call.
let closedUntil = 0; // epoch ms of next_open while the market is closed

// One monitor tick, called by Vercel Cron every minute. PAPER-ONLY.
// Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set.
//
// DB-traffic contract (Neon scale-to-zero): OUT OF SESSION THIS ROUTE MUST NOT
// TOUCH THE DATABASE. Order of gates: (1) pure clock math — nights/weekends return
// with zero network and zero DB; (2) Alpaca clock — holidays return with zero DB;
// (3) only a genuinely open market reaches heartbeat() + monitorTick().
export async function GET(req: Request) {
  if (process.env.CRON_SECRET && req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (process.env.TRADING_MODE !== "paper") {
    return NextResponse.json({ ok: false, error: "not paper mode" }, { status: 403 });
  }
  try {
    if (!inEtTradingWindow()) {
      return NextResponse.json({ ok: true, skipped: "outside ET trading window" });
    }
    if (Date.now() < closedUntil) {
      return NextResponse.json({ ok: true, skipped: "market closed (cached clock)" });
    }
    const clock = await getClock();
    if (!clock.is_open) {
      closedUntil = Date.parse(clock.next_open) || Date.now() + 5 * 60_000;
      return NextResponse.json({ ok: true, skipped: "market closed", nextOpen: clock.next_open });
    }
    closedUntil = 0;
    await heartbeat(); // stamp "alive" — session only, so Neon sleeps off-hours
    const fires = await monitorTick();
    return NextResponse.json({ ok: true, fires });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
