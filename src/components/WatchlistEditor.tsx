"use client";
import { useEffect, useState } from "react";

interface Row {
  id: number;
  symbol: string;
  active: boolean;
  notes: string | null;
}

export default function WatchlistEditor() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/watchlist")
      .then((r) => r.json())
      .then((j) => setRows(j.watchlist ?? []))
      .catch(() => setRows([]));
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const symbol = input.trim().toUpperCase();
    if (!symbol) return;
    setBusy(true);
    setErr("");
    const res = await fetch("/api/watchlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol }),
    });
    const j = await res.json();
    setBusy(false);
    if (!res.ok) {
      setErr(j.error || "Couldn't add that one.");
      return;
    }
    setRows(j.watchlist);
    setInput("");
  }

  async function toggle(id: number, active: boolean) {
    const res = await fetch(`/api/watchlist/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active }),
    });
    const j = await res.json();
    if (res.ok) setRows(j.watchlist);
  }

  async function remove(id: number) {
    const res = await fetch(`/api/watchlist/${id}`, { method: "DELETE" });
    const j = await res.json();
    if (res.ok) setRows(j.watchlist);
  }

  const activeCount = rows?.filter((r) => r.active).length ?? 0;

  return (
    <div className="bg-panel border border-border rounded-2xl p-4 space-y-3">
      <div>
        <p className="text-sm font-medium">Stocks to research</p>
        <p className="text-xs text-muted mt-0.5">
          What Vega looks at each morning.{rows ? ` ${activeCount} active.` : ""}
        </p>
      </div>

      <form onSubmit={add} className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value.toUpperCase())}
          placeholder="Add a ticker (e.g. AMZN)"
          maxLength={5}
          className="flex-1 rounded-xl bg-panel-2 border border-border px-3 py-2 text-sm uppercase num outline-none focus:border-muted"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="rounded-xl bg-accent text-white px-4 py-2 text-sm disabled:opacity-40"
        >
          {busy ? "…" : "Add"}
        </button>
      </form>
      {err && <p className="text-xs text-down">{err}</p>}

      {!rows ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted">No stocks yet — add one above.</p>
      ) : (
        <div className="divide-y divide-border">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center justify-between py-2.5">
              <span className="num text-sm font-medium">{r.symbol}</span>
              <div className="flex items-center gap-4">
                <button onClick={() => toggle(r.id, !r.active)} className={`text-xs ${r.active ? "text-up" : "text-muted"}`}>
                  {r.active ? "Researching" : "Paused"}
                </button>
                <button onClick={() => remove(r.id)} aria-label={`Remove ${r.symbol}`} className="text-muted text-xl leading-none">
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-[11px] text-muted">More active stocks = more thorough research, slightly higher daily cost.</p>
    </div>
  );
}
