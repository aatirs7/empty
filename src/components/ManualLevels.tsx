"use client";
import { useCallback, useEffect, useState } from "react";

interface SavedLevel {
  id: number;
  level: number | null;
  direction: string | null;
  distancePct: number | null;
  enteredAt: string | null;
}

/** Owner input for the experimental QQQ Manual profile: ONE list of the morning's
 *  QQQ levels, used across all charts while monitoring (Farrukh 2026-07-16). Saving
 *  replaces today's levels. Entry = level touch, gated by the 60% probability floor
 *  and positive EV after spread+theta; exits run Farrukh's ladder to the next level. */
export default function ManualLevels() {
  const [input, setInput] = useState("");
  const [saved, setSaved] = useState<SavedLevel[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [auto, setAuto] = useState<boolean | null>(null);
  const [hasAccount, setHasAccount] = useState(true);
  const [fresh, setFresh] = useState(true); // false = showing a previous day's list (carries forward)

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/manual-levels", { cache: "no-store" });
      const j = await r.json();
      if (j.ok) {
        setSaved(j.levels);
        setAuto(!!j.auto);
        setHasAccount(!!j.hasOwnAccount);
        setFresh(j.fresh !== false);
        const lv = (j.levels as SavedLevel[]).map((l) => l.level).filter((n): n is number => n != null);
        if (lv.length) setInput(lv.join(", "));
      }
    } catch {
      /* leave empty */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    setBusy(true);
    setMsg(null);
    const levels = input
      .split(/[,\s]+/)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0);
    try {
      const r = await fetch("/api/manual-levels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ levels }),
      });
      const j = await r.json();
      setMsg(j.ok ? `Saved ${j.saved} level${j.saved === 1 ? "" : "s"} (QQQ at ${j.spot})` : j.error || "save failed");
      if (j.ok) await load();
    } catch {
      setMsg("save failed — check your connection");
    }
    setBusy(false);
  }

  async function toggleAuto() {
    if (auto == null) return;
    const next = !auto;
    setAuto(next); // optimistic
    try {
      const r = await fetch("/api/manual-levels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto: next }),
      });
      const j = await r.json();
      if (!j.ok) setAuto(!next);
      else setHasAccount(!!j.hasOwnAccount);
    } catch {
      setAuto(!next);
    }
  }

  return (
    <div className="bg-panel border border-accent/30 rounded-2xl p-4 space-y-3">
      <div>
        <p className="text-sm font-medium">Today&apos;s QQQ levels (manual)</p>
        <p className="text-[11px] text-muted leading-relaxed mt-0.5">
          One list, comma-separated — used across all charts while monitoring. Levels below the current price become
          CALL setups (support), above become PUT setups (resistance). Levels carry forward day to day; saving replaces
          today&apos;s list.
        </p>
        {!fresh && saved && saved.length > 0 && (
          <p className="text-[11px] text-accent mt-1">Showing your last saved list — it carries forward at the open unless you update it.</p>
        )}
      </div>

      <label className="block">
        <span className="text-xs text-muted">Levels</span>
        <input
          type="text"
          inputMode="decimal"
          placeholder="e.g. 715.36, 707.13, 700.88, 719.3"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="mt-1 w-full rounded-xl border border-border bg-panel-2 px-3 py-2 text-sm num"
        />
      </label>

      <button
        onClick={save}
        disabled={busy}
        className="w-full rounded-xl bg-accent text-white py-2.5 text-sm font-semibold disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save today's levels"}
      </button>
      {msg && <p className="text-xs text-center text-muted">{msg}</p>}

      {/* Auto-trade toggle (paper). Buys are additionally hard-blocked server-side
          if the QQQ account keys (ALPACA_*_2) are missing. */}
      <div className="flex items-center justify-between border-t border-border pt-3">
        <div>
          <p className="text-sm font-medium">Auto-trade these levels</p>
          <p className="text-[11px] text-muted">
            {auto == null
              ? "…"
              : auto
                ? hasAccount
                  ? "ON — Vega buys touched levels itself (paper)."
                  : "ON, but BLOCKED — the QQQ account keys are missing."
                : "OFF — setups appear for manual approval only."}
          </p>
        </div>
        <button
          onClick={toggleAuto}
          disabled={auto == null || busy}
          aria-label="Toggle auto-trade"
          className={`relative h-7 w-12 rounded-full transition-colors disabled:opacity-40 ${auto ? "bg-accent" : "bg-panel-2 border border-border"}`}
        >
          <span
            className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${auto ? "translate-x-5" : "translate-x-0.5"}`}
          />
        </button>
      </div>

      {saved && saved.length > 0 && (
        <div className="space-y-1 pt-1 border-t border-border">
          {saved.map((l) => (
            <div key={l.id} className="flex items-center justify-between text-xs num">
              <span>
                {l.level}{" "}
                <span className={l.direction === "call" ? "text-up" : "text-down"}>
                  ({l.direction === "call" ? "CALL" : "PUT"})
                </span>
              </span>
              {l.distancePct != null && <span className="text-muted">{l.distancePct.toFixed(2)}% away</span>}
            </div>
          ))}
        </div>
      )}

      <p className="text-[11px] text-muted leading-relaxed">
        Vega enters 10 same-day contracts (~$0.30) the moment a level is touched — if the level&apos;s historical hit
        rate clears 60% and the contract&apos;s expected value beats the spread and time decay. It trims 3 at +50%, 6
        at +100%, ratchets the stop up as the trade works (−30% → −10% → breakeven), and rides 1 runner toward the next
        level. Everything flattens before the close.
      </p>
    </div>
  );
}
