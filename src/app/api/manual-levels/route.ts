import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { candidates } from "@/db/schema";
import { getProfileSettings, setProfileAuto } from "@/lib/profile-settings";
import { saveManualLevels, latestManualLevels, MANUAL_PROFILE_ID } from "@/lib/manual-levels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// QQQ Manual: ONE list of owner-entered QQQ levels. Levels CARRY FORWARD day to day
// (the monitor clones the latest list into today at the open if nothing was entered);
// saving here replaces today's list. Entry = level touch + ladder exits; see
// src/lib/manual-levels.ts + monitor.ts. Session-cookie protected (owner-only). PAPER.

export async function GET() {
  const today = new Date().toISOString().slice(0, 10);
  // Show the LATEST day's levels (today's, or the list that will carry forward).
  const latest = await latestManualLevels();
  const rows = latest
    ? await db
        .select()
        .from(candidates)
        .where(and(eq(candidates.runDate, latest.runDate), eq(candidates.profileId, MANUAL_PROFILE_ID)))
    : [];
  const settings = await getProfileSettings(MANUAL_PROFILE_ID);
  return NextResponse.json({
    ok: true,
    auto: settings.autoExecute,
    hasOwnAccount: !!process.env.ALPACA_API_KEY_ID2?.trim(),
    fresh: latest?.runDate === today, // false = showing a previous day's list (will carry forward)
    levelsDate: latest?.runDate ?? null,
    levels: rows
      .map((r) => {
        const manual = (r.setup as { manual?: { level?: number; enteredAt?: string; carriedFrom?: string } } | null)?.manual;
        return {
          id: r.id,
          level: manual?.level ?? null,
          direction: r.direction,
          distancePct: r.distanceToEdgePct != null ? Number(r.distanceToEdgePct) : null,
          enteredAt: manual?.enteredAt ?? null,
          carriedFrom: manual?.carriedFrom ?? null,
        };
      })
      .sort((a, b) => (b.level ?? 0) - (a.level ?? 0)),
  });
}

export async function POST(req: Request) {
  let body: { levels?: number[]; auto?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }

  // Auto-mode toggle (PAPER auto-buy + auto-manage for this profile only). A
  // toggle-only POST must NOT touch the day's levels.
  if (typeof body.auto === "boolean") {
    await setProfileAuto(MANUAL_PROFILE_ID, { autoExecute: body.auto, autoManage: body.auto });
    if (!Array.isArray(body.levels)) {
      return NextResponse.json({ ok: true, auto: body.auto, hasOwnAccount: !!process.env.ALPACA_API_KEY_ID2?.trim() });
    }
  }
  if (!Array.isArray(body.levels)) {
    return NextResponse.json({ ok: false, error: "nothing to save" }, { status: 400 });
  }
  const levels = body.levels.filter((n): n is number => Number.isFinite(n) && n > 0);
  if (levels.length > 24) {
    return NextResponse.json({ ok: false, error: "too many levels (max 24)" }, { status: 400 });
  }

  try {
    const runDate = new Date().toISOString().slice(0, 10);
    const result = await saveManualLevels(levels, runDate);
    return NextResponse.json({ ok: true, ...result });
  } catch {
    return NextResponse.json({ ok: false, error: "QQQ quote unavailable — try again in a moment" }, { status: 502 });
  }
}
