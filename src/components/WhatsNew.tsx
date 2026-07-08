"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

// Bump when there are new updates to announce; the modal auto-opens once per
// version. Keep this list current — add an entry whenever a feature ships.
const VERSION = "2026-07-08-v3";

const UPDATES: { title: string; body: string }[] = [
  {
    title: "Desktop layout",
    body: "Vega now has a proper laptop/desktop view — a left sidebar for navigation and a wider, calmer canvas. Your phone view is completely unchanged.",
  },
  {
    title: "Friday-contract test config",
    body: "Each alert now buys 1 contract around $0.50 expiring this Friday, then sells at +100% or stops out at −30%. Simple, and a clean bridge toward real money.",
  },
  {
    title: "Open & Closed positions",
    body: "Positions now has an Open / Closed toggle. Closed trades show what you sold for, the profit or loss, why it closed, and a realized-P&L total.",
  },
  {
    title: "Confidence ranking",
    body: "Every setup gets a 0–100 score. Setups are listed strongest-first with a Top pick, and the auto-buy bar is set at 70+.",
  },
  {
    title: "Clearer alerts",
    body: "Each alert shows the exact date and time it fired, and names which edge of the zone was tapped and at what price — so you can judge timing and accuracy.",
  },
  {
    title: "A cheaper universe",
    body: "The scan list swapped ~200 mega-caps for ~110 cheap, liquid stocks ($5–65), so a $0.50–$1 contract can actually get pushed in-the-money on a bounce. Big names were too pricey for the account.",
  },
  {
    title: "Always up to date",
    body: "Pull down on any page to refresh, screens update every 30 seconds, and the Log shows whether the live monitor is running with a countdown to the next scan.",
  },
];

export default function WhatsNew() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    setMounted(true);
    try {
      if (localStorage.getItem("vega_whatsnew") !== VERSION) setOpen(true);
    } catch {
      /* ignore */
    }
    const openFn = () => {
      setStep(0);
      setOpen(true);
    };
    window.addEventListener("vega:whatsnew", openFn);
    return () => window.removeEventListener("vega:whatsnew", openFn);
  }, []);

  const close = () => {
    try {
      localStorage.setItem("vega_whatsnew", VERSION);
    } catch {
      /* ignore */
    }
    setOpen(false);
  };

  const last = UPDATES.length - 1;
  const next = () => (step >= last ? close() : setStep((s) => s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));
  const u = UPDATES[step];

  return (
    <>
      {open &&
        mounted &&
        createPortal(
          <div
            className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={close}
          >
            <div
              className="bg-panel border border-border w-full max-w-sm rounded-3xl overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              {/* header */}
              <div className="flex items-center justify-between px-5 pt-4">
                <span className="text-[11px] uppercase tracking-wider text-muted">What&apos;s new</span>
                <button onClick={close} aria-label="Close" className="text-muted h-7 w-7 grid place-items-center -mr-1">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* one update per page */}
              <div key={step} className="wn-slide px-6 pt-3 pb-5 min-h-[188px] flex flex-col justify-center">
                <p className="text-[11px] num text-muted mb-1">
                  {step + 1} / {UPDATES.length}
                </p>
                <h2 className="text-xl font-bold tracking-tight">{u.title}</h2>
                <p className="text-sm text-muted leading-relaxed mt-2">{u.body}</p>
              </div>

              {/* dots */}
              <div className="flex justify-center gap-1.5 pb-3">
                {UPDATES.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setStep(i)}
                    aria-label={`Go to update ${i + 1}`}
                    className={`h-1.5 rounded-full transition-all ${i === step ? "w-5 bg-accent" : "w-1.5 bg-border"}`}
                  />
                ))}
              </div>

              {/* nav */}
              <div className="flex items-center gap-3 px-5 pb-5">
                <button
                  onClick={back}
                  disabled={step === 0}
                  className="flex-1 rounded-xl border border-border py-2.5 text-sm font-medium disabled:opacity-30"
                >
                  Back
                </button>
                <button onClick={next} className="flex-1 rounded-xl bg-accent text-white py-2.5 text-sm font-semibold">
                  {step >= last ? "Done" : "Next"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
