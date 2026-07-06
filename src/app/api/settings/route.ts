import { NextResponse } from "next/server";
import { getSettings, updateSettings, type SettingsPatch } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getSettings());
}

// Update auto-execute settings (paper-only mode toggle + its caps).
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: SettingsPatch = {};
  if (typeof body.autoExecute === "boolean") patch.autoExecute = body.autoExecute;
  if (typeof body.autoMinConfidence === "number") patch.autoMinConfidence = body.autoMinConfidence;
  if (typeof body.maxAutoTradesPerDay === "number") patch.maxAutoTradesPerDay = body.maxAutoTradesPerDay;
  const updated = await updateSettings(patch);
  return NextResponse.json(updated);
}
