"use client";
import { useEffect, useState } from "react";

// Bump when there are new updates to announce; the modal auto-opens once per version.
const VERSION = "2026-07-08";

const UPDATES: { title: string; body: string }[] = [
  {
    title: "🎯 Cheaper universe (big one)",
    body: "Swapped the ~200 mega-caps for ~110 cheap, liquid, optionable stocks ($5–65). The old list was mostly $100+ names whose contracts cost more than the whole $500 account — so the bot could almost never trade. Now it actually has cheap names to buy where a $0.50–$1 contract can get pushed in-the-money.",
  },
  {
    title: "📈 Confidence ranking",
    body: "Every setup now gets a 0–100 confidence score. The Setups page ranks the strongest first and flags the best one as “Top pick,” so high-conviction setups sit at the front of the line.",
  },
  {
    title: "🎟️ Weekly $0.50–$1 contracts",
    body: "Entries now target weekly or next-week contracts priced $0.50–$1.00 — the cheap ones that can run 100%+ on a good zone bounce. Strike doesn’t matter; price does.",
  },
  {
    title: "🪜 Scaled exits + ratcheting stop",
    body: "Takes profit in steps (+25/50/75/100%, all out at +150%). The stop starts at −40%, moves to breakeven once a trade is up +75%, and locks +25% profit once it’s up +100%. (Trims split across contracts when the account is big enough; on $500 it runs the ratcheting stop on the whole position.)",
  },
  {
    title: "⏱️ Alert timestamps",
    body: "Each alert now shows the exact date + time it fired, so you can check when it triggered against how it played out.",
  },
  {
    title: "📍 Zone-tap label",
    body: "Setups now show which edge was hit — “top zone tapped 115.08” or “bottom zone tapped 113.07” — so you know exactly which boundary triggered it.",
  },
  {
    title: "🟢 Live status + scan countdown",
    body: "The Log shows whether the live monitor is Live/Down and counts down to the next scan (which now runs around midnight ET off fully-settled data).",
  },
  {
    title: "🤖 Auto mode won’t nag",
    body: "In full-auto mode the bot decides everything itself — it no longer leaves trades sitting on the homepage asking you to approve or skip.",
  },
  {
    title: "🔄 Pull to refresh",
    body: "Pull down on any page to refresh (with a spinner), and pages auto-update every 30 seconds so you’re always seeing current data.",
  },
];

export default function WhatsNew() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem("vega_whatsnew") !== VERSION) setOpen(true);
    } catch {
      /* ignore */
    }
  }, []);

  const close = () => {
    try {
      localStorage.setItem("vega_whatsnew", VERSION);
    } catch {
      /* ignore */
    }
    setOpen(false);
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="What's new"
        className="text-muted h-7 w-7 grid place-items-center rounded-full border border-border text-sm font-semibold leading-none"
      >
        ?
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={close}
        >
          <div
            className="bg-panel border border-border w-full sm:max-w-md max-h-[85dvh] rounded-t-3xl sm:rounded-3xl flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-border">
              <div>
                <h2 className="text-lg font-bold">What’s new</h2>
                <p className="text-[11px] text-muted num">Updated {VERSION}</p>
              </div>
              <button onClick={close} aria-label="Close" className="text-muted h-8 w-8 grid place-items-center rounded-full">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="overflow-y-auto px-5 py-4 space-y-4">
              {UPDATES.map((u) => (
                <div key={u.title}>
                  <p className="text-sm font-semibold">{u.title}</p>
                  <p className="text-sm text-muted leading-relaxed mt-0.5">{u.body}</p>
                </div>
              ))}
              <p className="text-[11px] text-muted text-center leading-relaxed pt-1">
                Paper trading only. This is a learning instrument, not financial advice.
              </p>
            </div>

            <div className="px-5 py-3 border-t border-border">
              <button
                onClick={close}
                className="w-full bg-accent text-white rounded-xl py-2.5 text-sm font-semibold"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
