"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import RiskExplainer from "./RiskExplainer";
import type { Scenario } from "@/lib/risk";
import { usd } from "@/lib/format";

interface Resolved {
  symbol: string;
  direction: "call" | "put";
  strike: number;
  expiry: string;
  underlyingPrice: number;
  bid: number | null;
  ask: number | null;
  price: number | null;
}
interface Preview {
  ok: boolean;
  resolved?: Resolved;
  risk?: { maxLoss: number; breakeven: number; scenarios: Scenario[] } | null;
  error?: string;
}

// Live "dollars at risk before you approve" for a PENDING proposal.
export default function PendingRisk({ id }: { id: number }) {
  const router = useRouter();
  const [data, setData] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let on = true;
    fetch(`/api/proposals/${id}/preview`)
      .then((r) => r.json())
      .then((j) => on && setData(j))
      .catch(() => on && setData({ ok: false, error: "failed to load a live quote" }));
    return () => {
      on = false;
    };
  }, [id]);

  async function approve() {
    setBusy("approve");
    setErr("");
    const res = await fetch(`/api/proposals/${id}/approve`, { method: "POST" });
    const j = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setErr(j.error || "failed");
      return;
    }
    router.refresh();
  }
  async function reject() {
    setBusy("reject");
    await fetch(`/api/proposals/${id}/reject`, { method: "POST" });
    setBusy(null);
    router.refresh();
  }

  const buttons = (
    <div className="flex gap-2 pt-1">
      <button
        onClick={reject}
        disabled={!!busy}
        className="flex-1 rounded-xl border border-border py-3 disabled:opacity-40"
      >
        {busy === "reject" ? "…" : "Reject"}
      </button>
      <button
        onClick={approve}
        disabled={!!busy}
        className="flex-1 rounded-xl bg-up/90 text-black py-3 font-medium disabled:opacity-40"
      >
        {busy === "approve" ? "Placing…" : "Approve & place"}
      </button>
    </div>
  );

  if (!data) return <p className="text-sm text-muted">Pricing the live contract…</p>;

  if (!data.ok || !data.resolved) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-down">Couldn&apos;t price it live ({data.error}). You can still approve, it fills at the next open.</p>
        {err && <p className="text-sm text-down">{err}</p>}
        {buttons}
      </div>
    );
  }

  const r = data.resolved;
  return (
    <div className="space-y-3">
      <div className="text-xs text-muted num">
        Live contract: {r.symbol} · strike {usd(r.strike, 0)} · exp {r.expiry} · bid {r.bid ?? "-"} / ask {r.ask ?? "-"}
      </div>
      {data.risk ? (
        <RiskExplainer
          direction={r.direction}
          underlyingPrice={r.underlyingPrice}
          maxLoss={data.risk.maxLoss}
          breakeven={data.risk.breakeven}
          scenarios={data.risk.scenarios}
        />
      ) : (
        <p className="text-sm text-muted">No live quote right now (market may be closed). You can still approve; it fills at the next open.</p>
      )}
      {err && <p className="text-sm text-down">{err}</p>}
      {buttons}
    </div>
  );
}
