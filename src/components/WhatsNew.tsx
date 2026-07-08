"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

// Bump when there are new updates to announce; the modal auto-opens once per version.
const VERSION = "2026-07-08-v2";

const UPDATES: { title: string; body: string }[] = [
  {
    title: "A cheaper universe",
    body: "The scan list swapped its ~200 mega-caps for ~110 cheap, liquid stocks priced $5–65. The old names cost more per contract than the whole account, so almost nothing could be traded. Now Vega has setups it can actually afford.",
  },
  {
    title: "Confidence ranking",
    body: "Every setup now gets a 0–100 score. The Setups page lists the strongest first and marks the best one as the Top pick, so high-conviction ideas rise to the front.",
  },
  {
    title: "Weekly contracts",
    body: "Entries target weekly or next-week options priced $0.50–$1.00 — the cheap ones that can run 100%+ on a clean zone bounce. The price matters, not the strike.",
  },
  {
    title: "Smarter exits",
    body: "Profit is taken in steps as a trade climbs, and the stop tightens with it: it starts at −40%, moves to breakeven once you're up +75%, then locks +25% once you're up +100%. Everything is out by +150%.",
  },
  {
    title: "Clearer alerts",
    body: "Each alert now shows the exact date and time it fired, and names which edge of the zone was tapped and at what price — so you can judge its timing and accuracy.",
  },
  {
    title: "Hands-off auto mode",
    body: "In full-auto mode Vega decides everything itself. It no longer leaves trades on the homepage asking you to approve or skip.",
  },
  {
    title: "Always up to date",
    body: "Pull down on any page to refresh, and screens update on their own every 30 seconds. The Log shows whether the live monitor is running and counts down to the next scan.",
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
  }, []);

  const openModal = () => {
    setStep(0);
    setOpen(true);
  };
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
      <button
        onClick={openModal}
        aria-label="What's new"
        className="text-muted h-7 w-7 grid place-items-center rounded-full border border-border text-sm font-semibold leading-none"
      >
        ?
      </button>

      {open &&
        mounted &&
        createPortal(
          <div
            className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
            onClick={close}
          >
            <div
              className="bg-panel border border-border w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl overflow-hidden"
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
