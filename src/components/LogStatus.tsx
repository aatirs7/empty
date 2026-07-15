"use client";
import { useEffect, useState } from "react";
import { etTime } from "@/lib/format";

interface Status {
  marketOpen: boolean;
  monitorAlive: boolean;
  lastScanAt: string | null;
  candidateCount: number;
  nextScanAt: string;
}

function countdown(toIso: string): string {
  const ms = new Date(toIso).getTime() - Date.now();
  if (ms <= 60_000) return "any moment";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function LogStatus() {
  const [s, setS] = useState<Status | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    const load = () =>
      fetch("/api/status")
        .then((r) => r.json())
        .then((j) => (j.ok ? setS(j) : null))
        .catch(() => {});
    load();
    // Foreground-only: a 1s tick kept the CPU awake re-rendering this component
    // every second even backgrounded (2026-07-15 device-lag fix). The countdown
    // renders minute granularity, so a 30s tick is plenty.
    const whenVisible = (fn: () => void) => () => {
      if (document.visibilityState === "visible") fn();
    };
    const poll = setInterval(whenVisible(load), 30_000); // refresh status every 30s
    const clock = setInterval(
      whenVisible(() => tick((n) => n + 1)),
      30_000,
    );
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, []);

  const live = s?.monitorAlive && s?.marketOpen;
  const idle = s?.monitorAlive && !s?.marketOpen;
  const label = !s ? "checking…" : live ? "Live" : idle ? "Idle (market closed)" : "Down";
  const dot = !s ? "bg-muted" : live ? "bg-up" : idle ? "bg-muted" : "bg-down";

  return (
    <div className="bg-panel border border-border rounded-2xl p-4 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${dot} ${live ? "animate-pulse" : ""}`} />
        <div>
          <p className="text-sm font-medium">Live monitor: {label}</p>
          <p className="text-[11px] text-muted">
            {s?.lastScanAt ? `Last scan ${etTime(s.lastScanAt)} · ${s.candidateCount} candidates` : "no scan yet"}
          </p>
        </div>
      </div>
      <div className="text-right">
        <p className="text-[11px] text-muted">Next scan in</p>
        <p className="text-sm num">{s ? countdown(s.nextScanAt) : "—"}</p>
      </div>
    </div>
  );
}
