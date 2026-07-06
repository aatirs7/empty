"use client";
import { useEffect, useState } from "react";

type Mode = "system" | "light" | "dark";
const OPTS: Mode[] = ["system", "light", "dark"];

export default function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("system");

  useEffect(() => {
    setMode(((localStorage.getItem("vega-theme") as Mode) || "system"));
  }, []);

  function apply(m: Mode) {
    setMode(m);
    if (m === "system") {
      localStorage.removeItem("vega-theme");
      delete document.documentElement.dataset.theme;
    } else {
      localStorage.setItem("vega-theme", m);
      document.documentElement.dataset.theme = m;
    }
  }

  return (
    <div className="bg-panel border border-border rounded-2xl p-4">
      <p className="text-sm font-medium">Appearance</p>
      <p className="text-xs text-muted mt-0.5 mb-3">Match your phone, or force light / dark.</p>
      <div className="grid grid-cols-3 gap-2">
        {OPTS.map((o) => (
          <button
            key={o}
            onClick={() => apply(o)}
            className={`py-2.5 rounded-xl text-sm capitalize border transition-colors ${
              mode === o ? "border-accent text-accent bg-accent/10 font-medium" : "border-border text-muted"
            }`}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}
