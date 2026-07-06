"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ProposalActions({ id }: { id: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  async function act(kind: "approve" | "reject") {
    setBusy(kind);
    setErr("");
    const res = await fetch(`/api/proposals/${id}/${kind}`, { method: "POST" });
    const j = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setErr(j.error || "failed");
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      {err && <span className="text-xs text-down">{err}</span>}
      <button
        onClick={() => act("reject")}
        disabled={!!busy}
        className="px-3 py-1.5 rounded-lg border border-border text-sm disabled:opacity-40"
      >
        Reject
      </button>
      <button
        onClick={() => act("approve")}
        disabled={!!busy}
        className="px-3 py-1.5 rounded-lg bg-up/90 text-black text-sm font-medium disabled:opacity-40"
      >
        {busy === "approve" ? "…" : "Approve"}
      </button>
    </div>
  );
}
