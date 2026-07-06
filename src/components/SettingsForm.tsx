"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

interface Initial {
  autoExecute: boolean;
  autoMinConfidence: number;
  maxAutoTradesPerDay: number;
}

export default function SettingsForm({ initial }: { initial: Initial }) {
  const router = useRouter();
  const [autoExecute, setAutoExecute] = useState(initial.autoExecute);
  const [minConf, setMinConf] = useState(initial.autoMinConfidence);
  const [maxTrades, setMaxTrades] = useState(initial.maxAutoTradesPerDay);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save(patch: Partial<Initial>) {
    setBusy(true);
    setSaved(false);
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    setBusy(false);
    if (res.ok) {
      setSaved(true);
      router.refresh();
    }
  }

  async function killSwitch() {
    setAutoExecute(false);
    await save({ autoExecute: false });
  }

  return (
    <div className="space-y-5">
      {autoExecute && (
        <div className="bg-accent/15 border border-accent/40 rounded-xl p-4">
          <p className="text-accent text-sm font-medium">● Auto-execute is ON</p>
          <p className="text-xs text-muted mt-1">
            Vega will place paper trades automatically for high-confidence proposals. Turn it off any time.
          </p>
          <button onClick={killSwitch} disabled={busy} className="mt-3 w-full rounded-lg bg-accent text-white py-2.5 font-medium disabled:opacity-40">
            Turn auto-execute OFF now
          </button>
        </div>
      )}

      <div className="bg-panel border border-border rounded-xl p-4 space-y-4">
        <label className="flex items-center justify-between">
          <span>
            <span className="block text-sm font-medium">Auto-execute (paper only)</span>
            <span className="block text-xs text-muted">Off by default. You stay in the loop unless this is on.</span>
          </span>
          <input
            type="checkbox"
            checked={autoExecute}
            onChange={(e) => {
              setAutoExecute(e.target.checked);
              save({ autoExecute: e.target.checked });
            }}
            className="h-6 w-6 accent-[var(--accent)]"
          />
        </label>

        <div>
          <div className="flex justify-between text-sm">
            <span>Min confidence to auto-trade</span>
            <span className="num text-muted">{Math.round(minConf * 100)}%</span>
          </div>
          <input
            type="range"
            min={0.5}
            max={0.95}
            step={0.05}
            value={minConf}
            onChange={(e) => setMinConf(Number(e.target.value))}
            onPointerUp={() => save({ autoMinConfidence: minConf })}
            className="w-full accent-[var(--accent)]"
          />
        </div>

        <label className="flex items-center justify-between text-sm">
          <span>Max auto-trades per day</span>
          <input
            type="number"
            min={1}
            max={5}
            value={maxTrades}
            onChange={(e) => setMaxTrades(Number(e.target.value))}
            onBlur={() => save({ maxAutoTradesPerDay: maxTrades })}
            className="w-16 rounded-lg bg-panel-2 border border-border px-2 py-1 num text-right"
          />
        </label>
      </div>

      <p className="text-xs text-muted">
        {busy ? "Saving…" : saved ? "Saved." : "Changes save automatically."} Auto-execute is always paper-only and
        enforces the same per-order and open-position caps as manual approval.
      </p>
    </div>
  );
}
