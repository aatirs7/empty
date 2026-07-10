import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { researchRuns } from "@/db/schema";
import { buildDailyReport } from "@/lib/daily-report";
import { postDiscordReport } from "@/lib/discord";
import { getClock } from "@/lib/alpaca";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Daily activity report -> Discord, right after the close. Cron fires at two UTC
// times (one per DST offset); this route only sends once the market is CLOSED and
// only ONCE per day (dedup marker), so it lands ~4:10pm ET year-round.
// ?preview=1 returns the markdown without posting. ?force=1 ignores the gates.
export async function GET(req: Request) {
  if (process.env.CRON_SECRET && req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const preview = url.searchParams.get("preview") === "1";
  const force = url.searchParams.get("force") === "1";
  const today = new Date().toISOString().slice(0, 10);

  try {
    const report = await buildDailyReport();
    if (preview) {
      return new NextResponse(report.markdown, { headers: { "content-type": "text/markdown; charset=utf-8" } });
    }

    if (!force) {
      // Only after the close (skip when the market is still open — too early).
      const open = await getClock().then((c) => c.is_open).catch(() => false);
      if (open) return NextResponse.json({ ok: true, skipped: "market still open" });
      // Once per day.
      const [sent] = await db
        .select({ id: researchRuns.id })
        .from(researchRuns)
        .where(and(eq(researchRuns.model, "daily-report"), eq(researchRuns.runDate, today)))
        .limit(1);
      if (sent) return NextResponse.json({ ok: true, skipped: "already sent today" });
      if (!report.hasActivity) return NextResponse.json({ ok: true, skipped: "no activity today" });
    }

    const res = await postDiscordReport(report.embed, report.markdown, report.filename);
    if (res.ok) {
      await db.insert(researchRuns).values({ runDate: today, status: "complete", model: "daily-report", marketContext: "Daily report posted to Discord." });
    }
    return NextResponse.json({ ok: res.ok, status: res.status, error: res.error, date: report.date });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
