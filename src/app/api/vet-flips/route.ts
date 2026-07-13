import { NextResponse } from "next/server";
import { vetFlips } from "@/lib/vet-flips";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // bounded concurrent web-search vetting; Vercel Pro window

// Post-scan job (Vercel Cron, ~30 min after the midnight scan): news-vet the day's
// valid FLIP candidates (SBv2) and store each verdict on the candidate so the live
// monitor reads it with zero latency. CRON_SECRET-guarded. PAPER/analysis only.
export async function GET(req: Request) {
  if (process.env.CRON_SECRET && req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const results = await vetFlips();
    return NextResponse.json({ ok: true, results });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
