import { NextResponse } from "next/server";
import { getSettings, updateSettings, type SettingsPatch } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getSettings());
}

// Update paper-only settings (automation toggles, goal, position sizing).
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: SettingsPatch = {};
  if (typeof body.autoExecute === "boolean") patch.autoExecute = body.autoExecute;
  if (typeof body.autoMinConfidence === "number") patch.autoMinConfidence = body.autoMinConfidence;
  if (typeof body.maxAutoTradesPerDay === "number") patch.maxAutoTradesPerDay = body.maxAutoTradesPerDay;
  if (typeof body.autoManage === "boolean") patch.autoManage = body.autoManage;
  if (typeof body.weeklyGoal === "number") patch.weeklyGoal = Math.max(0, body.weeklyGoal);
  if (body.riskTolerance === "conservative" || body.riskTolerance === "balanced" || body.riskTolerance === "aggressive")
    patch.riskTolerance = body.riskTolerance;
  if (typeof body.perTradeBudget === "number") patch.perTradeBudget = Math.max(20, body.perTradeBudget);
  if (typeof body.maxContracts === "number") patch.maxContracts = Math.max(1, Math.min(20, Math.floor(body.maxContracts)));
  if (typeof body.maxContractPrice === "number") patch.maxContractPrice = Math.max(0.2, body.maxContractPrice);
  const updated = await updateSettings(patch);
  return NextResponse.json(updated);
}
