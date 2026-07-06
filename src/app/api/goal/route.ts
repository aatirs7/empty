import { NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";
import { getWeeklyPL } from "@/lib/alpaca";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const s = await getSettings();
  const goal = Number(s.weeklyGoal);
  let weeklyPL = 0;
  let error: string | null = null;
  try {
    weeklyPL = (await getWeeklyPL()).weeklyPL;
  } catch (e) {
    error = e instanceof Error ? e.message : "error";
  }
  const pct = goal > 0 ? Math.max(0, Math.min(100, Math.round((weeklyPL / goal) * 100))) : 0;
  return NextResponse.json({
    ok: true,
    weeklyPL,
    goal,
    pct,
    goalMet: goal > 0 && weeklyPL >= goal,
    autoManage: s.autoManage,
    riskTolerance: s.riskTolerance,
    error,
  });
}
