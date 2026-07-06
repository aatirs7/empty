"use client";
import { useEffect, useState } from "react";

export default function HeaderThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("vega-theme");
    setDark(stored ? stored === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches);
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    localStorage.setItem("vega-theme", mode);
    document.documentElement.dataset.theme = mode;
  }

  if (dark === null) return <span className="block w-5 h-5" />;

  return (
    <button onClick={toggle} aria-label="Toggle light and dark mode" className="text-muted p-1 -ml-1">
      {dark ? (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}
