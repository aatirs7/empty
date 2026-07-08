import { NextResponse } from "next/server";
import { sendPush } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fire a test notification to every subscribed device.
export async function POST() {
  const sent = await sendPush("Vega", "Test notification — you're all set.", "/");
  return NextResponse.json({ ok: true, sent });
}
