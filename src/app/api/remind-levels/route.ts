import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { candidates } from "@/db/schema";
import { getProfile } from "@/lib/profiles";
import { getClock } from "@/lib/alpaca";
import { sendPush } from "@/lib/push";
import { latestManualLevels } from "@/lib/manual-levels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 8:45 AM ET daily reminder (Vercel Cron): push the owner to enter the day's QQQ
// Manual levels before the open. Skips when levels are already in, on non-trading
// days, and when the profile is shelved. Two UTC crons cover DST; the ET-hour guard
// below lets only the 8:xx ET firing through (same pattern as operation-vega.yml).
export async function GET(req: Request) {
  if (process.env.CRON_SECRET && req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const etHour = Number(new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }));
  if (etHour !== 8) {
    return NextResponse.json({ ok: true, skipped: `wrong ET hour (${etHour}) — DST twin cron` });
  }

  if (getProfile("qqq_manual").shelved) {
    return NextResponse.json({ ok: true, skipped: "qqq_manual shelved" });
  }

  // Non-trading day (weekend crons don't fire, but holidays do): at 8:45 ET premarket
  // of a trading day, next_open is TODAY 9:30 — a later date means a holiday.
  try {
    const clock = await getClock();
    const nextOpenEt = new Date(clock.next_open).toLocaleDateString("en-US", { timeZone: "America/New_York" });
    const todayEt = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
    if (!clock.is_open && nextOpenEt !== todayEt) {
      return NextResponse.json({ ok: true, skipped: "market holiday" });
    }
  } catch {
    /* clock unavailable — send the reminder anyway (harmless on a holiday) */
  }

  const runDate = new Date().toISOString().slice(0, 10);
  const rows = await db
    .select({ id: candidates.id })
    .from(candidates)
    .where(and(eq(candidates.runDate, runDate), eq(candidates.profileId, "qqq_manual")));
  if (rows.length > 0) {
    return NextResponse.json({ ok: true, skipped: `levels already set (${rows.length})` });
  }

  // Levels carry forward at the open (monitor clones the latest list), so the
  // reminder distinguishes "yesterday's list will be reused" from "nothing at all".
  const prev = await latestManualLevels();
  const hasCarry = prev != null && prev.levels.length > 0;
  await sendPush(
    hasCarry ? "QQQ levels: yesterday's list will be reused" : "Set today's QQQ levels",
    hasCarry
      ? "Market opens in 45 minutes — update your levels now if the chart changed, or Vega trades yesterday's."
      : "Market opens in 45 minutes — Vega has no levels to trade yet.",
    "/setups?profile=qqq_manual",
  ).catch(() => {});
  return NextResponse.json({ ok: true, reminded: true, carryAvailable: hasCarry });
}
