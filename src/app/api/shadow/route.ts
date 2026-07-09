import { NextResponse } from "next/server";
import { runShadow } from "@/lib/shadow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Per-profile shadow tracker (Vercel Cron): open shadows for each profile's valid
// setups, mark to the bid, exit on the per-profile rule. CRON_SECRET-guarded.
// Replaces the unreliable GitHub Actions shadow.yml.
export async function GET(req: Request) {
  if (process.env.CRON_SECRET && req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const r = await runShadow();
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
