"use client";
import { useCallback, useEffect, useState } from "react";

interface SavedLevel {
  id: number;
  tf: string;
  level: number | null;
  direction: string | null;
  distancePct: number | null;
  enteredAt: string | null;
}

const TFS = ["5m", "15m", "1h"] as const;
type Tf = (typeof TFS)[number];

/** Owner input for the experimental QQQ Manual profile: enter the morning's
 *  5m/15m/1h QQQ levels (comma-separated prices per timeframe). Saving replaces
 *  today's levels. The bot still requires a 5-min confirmation candle at a level,
 *  the 60% probability floor, and positive EV after spread+theta before entering. */
export default function ManualLevels() {
  const [inputs, setInputs] = useState<Record<Tf, string>>({ "5m": "", "15m": "", "1h": "" });
  const [saved, setSaved] = useState<SavedLevel[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [auto, setAuto] = useState<boolean | null>(null);
  const [hasAccount, setHasAccount] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/manual-levels", { cache: "no-store" });
      const j = await r.json();
      if (j.ok) {
        setSaved(j.levels);
        setAuto(!!j.auto);
        setHasAccount(!!j.hasOwnAccount);
        const next: Record<Tf, string> = { "5m": "", "15m": "", "1h": "" };
        for (const l of j.levels as SavedLevel[]) {
          const tf = (TFS as readonly string[]).includes(l.tf) ? (l.tf as Tf) : "15m";
          if (l.level != null) next[tf] = next[tf] ? `${next[tf]}, ${l.level}` : String(l.level);
        }
        setInputs(next);
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
    const levels = TFS.flatMap((tf) =>
      inputs[tf]
        .split(/[,\s]+/)
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n) && n > 0)
        .map((price) => ({ tf, price })),
    );
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
          Enter your marked levels each morning, comma-separated per chart. Levels below the current price become CALL
          setups (support), above become PUT setups (resistance). Saving replaces today&apos;s levels.
        </p>
      </div>

      {TFS.map((tf) => (
        <label key={tf} className="block">
          <span className="text-xs text-muted">{tf} chart levels</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="e.g. 712.50, 718.25"
            value={inputs[tf]}
            onChange={(e) => setInputs((p) => ({ ...p, [tf]: e.target.value }))}
            className="mt-1 w-full rounded-xl border border-border bg-panel-2 px-3 py-2 text-sm num"
          />
        </label>
      ))}

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
                  ? "ON — Vega buys confirmed setups itself (paper)."
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
              <span className="text-muted">{l.tf}</span>
              <span>
                {l.level}{" "}
                <span className={l.direction === "call" ? "text-up" : "text-down"}>
                  ({l.direction === "call" ? "CALL" : "PUT"})
                </span>
                {l.distancePct != null && <span className="text-muted"> · {l.distancePct.toFixed(2)}% away</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      <p className="text-[11px] text-muted leading-relaxed">
        Entry still requires a 5-minute confirmation candle at the level — never a bare touch — plus a 60%+ historical
        hit rate and a contract whose expected value clears the spread and time decay. 0DTE contracts only.
      </p>
    </div>
  );
}
