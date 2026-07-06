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
    <div>
      {err && <p className="text-xs text-down mb-2">{err}</p>}
      <div className="flex gap-2">
        <button
          onClick={() => act("reject")}
          disabled={!!busy}
          className="flex-1 py-2.5 rounded-xl border border-border text-sm disabled:opacity-40"
        >
          {busy === "reject" ? "…" : "Skip"}
        </button>
        <button
          onClick={() => act("approve")}
          disabled={!!busy}
          className="flex-1 py-2.5 rounded-xl bg-up text-white text-sm font-medium disabled:opacity-40"
        >
          {busy === "approve" ? "…" : "Approve"}
        </button>
      </div>
    </div>
  );
}
