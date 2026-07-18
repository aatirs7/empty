import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { candidates, monitorState } from "@/db/schema";
import { getClock } from "@/lib/alpaca";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Next scheduled scan: next 04:00 UTC (~midnight ET) on a weekday. */
function nextScanAt(): string {
  const now = new Date();
  const d = new Date(now);
  d.setUTCHours(4, 0, 0, 0);
  if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

// Live status for the Log page: monitor heartbeat, market state, last/next scan.
export async function GET() {
  const [ms] = await db.select().from(monitorState).limit(1);
  const [latest] = await db.select({ d: candidates.runDate }).from(candidates).orderBy(desc(candidates.runDate)).limit(1);
  let lastScanAt: string | null = null;
  let candidateCount = 0;
  if (latest) {
    const rows = await db.select({ c: candidates.createdAt }).from(candidates).where(eq(candidates.runDate, latest.d));
    candidateCount = rows.length;
    lastScanAt = rows.reduce<string | null>((m, r) => {
      const t = (r.c as Date).toISOString();
      return !m || t > m ? t : m;
    }, null);
  }
  let marketOpen = false;
  try {
    marketOpen = (await getClock()).is_open;
  } catch {
    // leave false
  }
  const heartbeatAt = ms?.updatedAt ? (ms.updatedAt as Date).toISOString() : null;
  // The heartbeat is SESSION-ONLY (the monitor cron returns before any DB touch
  // outside market hours so Neon can scale to zero) — so a stale heartbeat while
  // the market is closed means "idle", not "down". Only demand freshness when open.
  const fresh = heartbeatAt ? Date.now() - new Date(heartbeatAt).getTime() < 3 * 60_000 : false;
  const alive = marketOpen ? fresh : true;

  return NextResponse.json({
    ok: true,
    marketOpen,
    monitorAlive: alive,
    heartbeatAt,
    lastScanAt,
    candidateCount,
    nextScanAt: nextScanAt(),
  });
}
