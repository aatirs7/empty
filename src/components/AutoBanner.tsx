"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

// Shown once per session while automation is ON, and dismissable.
export default function AutoBanner() {
  const [state, setState] = useState<{ autoExecute: boolean; autoManage: boolean } | null>(null);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => setState({ autoExecute: !!s.autoExecute, autoManage: !!s.autoManage }))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!state) return;
    const key = `vega-banner-${state.autoExecute}-${state.autoManage}`;
    setDismissed(sessionStorage.getItem(key) === "1");
  }, [state]);

  if (!state || (!state.autoExecute && !state.autoManage) || dismissed) return null;

  const label =
    state.autoExecute && state.autoManage
      ? "Autopilot is on, Vega is buying and managing paper trades"
      : state.autoExecute
        ? "Auto-buy is on, Vega buys paper trades on its own"
        : "Auto-manage is on, Vega closes paper trades on its own";

  function dismiss() {
    if (!state) return;
    sessionStorage.setItem(`vega-banner-${state.autoExecute}-${state.autoManage}`, "1");
    setDismissed(true);
  }

  return (
    <div className="bg-accent/15 border-b border-accent/40 text-accent text-xs px-3 py-2 flex items-center gap-2">
      <Link href="/settings" className="flex-1 text-center">
        ● {label}. Tap to manage.
      </Link>
      <button onClick={dismiss} aria-label="Dismiss" className="text-accent/70 text-base leading-none px-1">
        ×
      </button>
    </div>
  );
}
