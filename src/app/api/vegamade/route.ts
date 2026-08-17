import { NextResponse } from "next/server";
import { runVegaMade } from "@/lib/vegamade";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// VegaMade v4 daily shares runner (Vercel Cron, once after the close on trading days).
// Manages open swing positions + takes new long entries on fresh demand-zone taps when
// the market regime is risk-on. PAPER-ONLY (getBroker asserts paper); no-ops unless
// vegamade_v1 autoExecute is on. CRON_SECRET-guarded. `?dry=1` = dry run (places nothing).
export async function GET(req: Request) {
  if (process.env.CRON_SECRET && req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (process.env.TRADING_MODE !== "paper") {
    return NextResponse.json({ ok: false, error: "not paper mode" }, { status: 403 });
  }
  try {
    const dryRun = new URL(req.url).searchParams.get("dry") === "1";
    const r = await runVegaMade({ dryRun });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
