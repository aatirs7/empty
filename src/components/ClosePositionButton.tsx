"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ClosePositionButton({ symbol }: { symbol: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function close() {
    if (!window.confirm(`Close ${symbol}? This flattens the paper position.`)) return;
    setBusy(true);
    await fetch(`/api/positions/${encodeURIComponent(symbol)}/close`, { method: "POST" });
    setBusy(false);
    router.push("/positions");
    router.refresh();
  }

  return (
    <button
      onClick={close}
      disabled={busy}
      className="w-full rounded-2xl border border-down/40 text-down py-3 text-sm disabled:opacity-40"
    >
      {busy ? "Closing…" : "Close position"}
    </button>
  );
}
