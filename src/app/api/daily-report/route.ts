import { NextResponse } from "next/server";
import { buildDailyReport } from "@/lib/daily-report";
import { postDiscordReport } from "@/lib/discord";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Daily activity report -> Discord. Called by Vercel Cron after the close.
// ?preview=1 returns the markdown without posting (for testing).
// ?force=1 posts even on a no-activity day.
export async function GET(req: Request) {
  if (process.env.CRON_SECRET && req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const preview = url.searchParams.get("preview") === "1";
  const force = url.searchParams.get("force") === "1";

  try {
    const report = await buildDailyReport();
    if (preview) {
      return new NextResponse(report.markdown, { headers: { "content-type": "text/markdown; charset=utf-8" } });
    }
    if (!report.hasActivity && !force) {
      return NextResponse.json({ ok: true, skipped: "no activity today (use ?force=1 to send anyway)" });
    }
    const res = await postDiscordReport(report.embed, report.markdown, report.filename);
    return NextResponse.json({ ok: res.ok, status: res.status, error: res.error, date: report.date });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
