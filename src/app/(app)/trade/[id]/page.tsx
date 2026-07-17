import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orders, proposals } from "@/db/schema";
import { parseOcc, companyName, usd, etDateTime, stripDash } from "@/lib/format";
import { getProfile } from "@/lib/profiles";

export const dynamic = "force-dynamic";

// Closed-trade post-mortem: the contract, entry → exit, why it was sold, and the
// POTENTIAL (the target the trade was riding toward) vs what actually happened.
// Technical detail is fine here (owner's ask) — this is the analysis page.
export default async function TradePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [ord] = await db.select().from(orders).where(eq(orders.id, Number(id))).limit(1);
  const [prop] = ord?.proposalId
    ? await db.select().from(proposals).where(eq(proposals.id, ord.proposalId)).limit(1)
    : [];

  if (!ord) {
    return (
      <div className="space-y-4">
        <Link href="/positions" className="text-xs text-muted">← Positions</Link>
        <p className="text-sm text-muted text-center py-12">Trade not found.</p>
      </div>
    );
  }

  const occ = ord.contractSymbol ? parseOcc(ord.contractSymbol) : null;
  const profile = getProfile(prop?.profileId);
  const qty = ord.qty ?? 1;
  const entry = ord.filledPrice != null ? Number(ord.filledPrice) : null;
  const exit = ord.exitPrice != null ? Number(ord.exitPrice) : null;
  const pl = ord.realizedPl != null ? Number(ord.realizedPl) : null;
  const plPct = entry && exit && entry > 0 ? Math.round(((exit - entry) / entry) * 100) : null;
  const cost = entry != null ? entry * 100 * qty : null;

  const zs = prop?.zoneSetup as {
    active_zone?: { bottom: number; top: number };
    predictedTarget?: number | null;
    predictedTargetSafe?: number | null;
    expectedHoldMin?: number | null;
  } | null;
  const target = typeof zs?.predictedTarget === "number" ? zs.predictedTarget : null;
  const entrySpot = ord.underlyingPrice != null ? Number(ord.underlyingPrice) : null;

  // POTENTIAL: contract value if the underlying had reached the target (intrinsic at
  // target — conservative: ignores any remaining time value). Code-computed.
  let potential: { value: number; gain: number } | null = null;
  if (occ && target != null && entry != null) {
    const intrinsic = occ.type === "call" ? Math.max(0, target - occ.strike) : Math.max(0, occ.strike - target);
    potential = { value: intrinsic, gain: (intrinsic - entry) * 100 * qty };
  }

  const holdMs = ord.submittedAt && ord.exitAt ? new Date(ord.exitAt).getTime() - new Date(ord.submittedAt).getTime() : null;
  const holdLabel =
    holdMs == null ? null : holdMs < 90 * 60_000 ? `${Math.round(holdMs / 60_000)} min` : holdMs < 48 * 3_600_000 ? `${Math.round(holdMs / 3_600_000)} h` : `${Math.round(holdMs / 86_400_000)} d`;

  const sym = occ?.underlying ?? ord.contractSymbol ?? "?";

  return (
    <div className="space-y-4">
      <Link href="/positions" className="text-xs text-muted">← Positions</Link>

      <div className="text-center">
        <h1 className="text-2xl font-bold">
          {companyName(sym)} <span className="text-muted text-lg">({sym})</span>
        </h1>
        <p className="text-sm text-muted">
          {profile.label} · {occ ? `$${occ.strike} ${occ.type} · exp ${occ.expiry}` : ord.contractSymbol} · {qty}x
        </p>
      </div>

      {/* Outcome */}
      <div className="bg-panel border border-border rounded-2xl p-5 text-center">
        <p className="text-xs text-muted">Result</p>
        <p className={`text-3xl font-bold num mt-1 ${(pl ?? 0) >= 0 ? "text-up" : "text-down"}`}>
          {pl != null ? `${pl >= 0 ? "+" : ""}${usd(pl)}` : "—"}
          {plPct != null && <span className="text-base"> ({plPct >= 0 ? "+" : ""}{plPct}%)</span>}
        </p>
        {ord.exitReason && <p className="text-sm mt-2">Sold: <span className="text-foreground">{stripDash(ord.exitReason)}</span></p>}
        {holdLabel && <p className="text-[11px] text-muted num mt-1">Held {holdLabel}</p>}
      </div>

      {/* Potential vs actual */}
      <div className="bg-panel border border-border rounded-2xl p-4 space-y-2">
        <p className="text-xs uppercase tracking-wide text-muted">Potential vs actual</p>
        {target != null ? (
          <div className="text-sm space-y-1">
            <p className="num">
              Target: {sym} → <span className="text-foreground">{usd(target)}</span>
              {entrySpot != null && <span className="text-muted"> (from {usd(entrySpot)} at entry)</span>}
            </p>
            {potential && potential.value > 0 ? (
              <p className="num">
                At target the contract is worth ≈ <span className="text-foreground">{usd(potential.value)}</span>/sh →{" "}
                <span className={potential.gain >= 0 ? "text-up" : "text-down"}>
                  {potential.gain >= 0 ? "+" : ""}{usd(potential.gain)}
                </span>{" "}
                <span className="text-muted">(intrinsic only, ex-time-value)</span>
              </p>
            ) : (
              <p className="text-muted text-xs leading-relaxed">
                Strike stays out-of-the-money even at the target — this trade banked on the premium pump from a fast
                move, not intrinsic value.
              </p>
            )}
            <p className="num">
              Actual: {entry != null ? `bought ${usd(entry)}` : "—"}
              {exit != null ? ` → sold ${usd(exit)}` : ""} ·{" "}
              <span className={(pl ?? 0) >= 0 ? "text-up" : "text-down"}>{pl != null ? `${pl >= 0 ? "+" : ""}${usd(pl)}` : "—"}</span>
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted">No target was persisted for this trade (pre-target-exit era or fallback path).</p>
        )}
      </div>

      {/* Entry / exit facts */}
      <div className="bg-panel border border-border rounded-2xl p-4 grid grid-cols-2 gap-3 text-center">
        <div>
          <p className="text-xs text-muted">Entry</p>
          <p className="num font-semibold">{entry != null ? usd(entry) : "—"}<span className="text-xs text-muted"> /sh</span></p>
          {cost != null && <p className="text-[11px] text-muted num">{usd(cost)} total</p>}
          {ord.submittedAt && <p className="text-[11px] text-muted num">{etDateTime(ord.submittedAt)}</p>}
        </div>
        <div>
          <p className="text-xs text-muted">Exit</p>
          <p className="num font-semibold">{exit != null ? usd(exit) : "—"}<span className="text-xs text-muted"> /sh</span></p>
          {exit != null && <p className="text-[11px] text-muted num">{usd(exit * 100 * qty)} total</p>}
          {ord.exitAt && <p className="text-[11px] text-muted num">{etDateTime(ord.exitAt)}</p>}
        </div>
        <div className="col-span-2 border-t border-border pt-2 grid grid-cols-3 gap-2 text-[11px] text-muted num">
          <span>mode: {ord.executionMode ?? "—"}</span>
          <span>max loss: {ord.maxLoss != null ? usd(ord.maxLoss, 0) : "—"}</span>
          <span>breakeven: {ord.breakeven != null ? usd(ord.breakeven) : "—"}</span>
        </div>
      </div>

      {/* Setup context */}
      {prop && (
        <div className="bg-panel border border-border rounded-2xl p-4 space-y-2">
          <p className="text-xs uppercase tracking-wide text-muted">The setup</p>
          {zs?.active_zone && (
            <p className="text-xs num text-muted">
              zone {zs.active_zone.bottom}–{zs.active_zone.top}
              {zs.predictedTargetSafe != null && ` · safe target ${zs.predictedTargetSafe}`}
              {zs.expectedHoldMin != null && ` · expected hold ~${Math.round(zs.expectedHoldMin)}min`}
              {prop.confidence != null && ` · confidence ${Math.round(Number(prop.confidence) * 100)}/100`}
            </p>
          )}
          {prop.zoneRead && <p className="text-xs text-muted leading-relaxed">{stripDash(prop.zoneRead)}</p>}
          <Link href={`/proposal/${prop.id}`} className="block text-xs text-accent">Original proposal →</Link>
        </div>
      )}
    </div>
  );
}
