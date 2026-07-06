import { NextResponse } from "next/server";
import { executeProposal, ExecuteError } from "@/lib/execute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Approve a proposal -> place the paper order (manual execution).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const proposalId = Number(id);
  if (!Number.isInteger(proposalId)) {
    return NextResponse.json({ ok: false, error: "invalid proposal id" }, { status: 400 });
  }
  try {
    const result = await executeProposal(proposalId, "manual");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ExecuteError) {
      const status = err.code === "not_found" ? 404 : err.code === "not_paper" ? 403 : 409;
      return NextResponse.json({ ok: false, code: err.code, error: err.message }, { status });
    }
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "error" }, { status: 500 });
  }
}
