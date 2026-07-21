"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

// Bump when there are new updates to announce; the modal auto-opens once per
// version. Keep this list current — add an entry whenever a feature ships.
const VERSION = "2026-07-21-v17";

const UPDATES: { title: string; body: string }[] = [
  {
    title: "The full backtesting suite",
    body: "Backtesting now covers every strategy that can honestly be tested. SB 15M gets a dedicated intraday engine: it replays history one completed 15-minute candle at a time through the exact live entry gates, then simulates the two-contract ladder (+50% trim → breakeven stop → +75% runner → end-of-day flatten) against REAL 15-minute historical option prices — reporting profit factor, both target hit rates, stop rate, and results by ticker, time of day, score, and market alignment. SBv1 also gained the Stage 2 options simulation (its EV contract picker is approximated by its price band, and the report says so). All results land on the Backtest page. QQQ Manual remains honestly untestable — your hand-drawn levels have no historical record, and inventing them would be lookahead.",
  },
  {
    title: "New profile: SB 15M Empty-Space Day Trader",
    body: "Farrukh's new intraday strategy, as its own separate profile (SB 15M tab). It watches 18 high-cap liquid names for 4-hour order-block zones on the 15-minute chart, and only acts when price retests the zone boundary facing it — with clean empty space beyond, a COMPLETED 15-minute rejection candle, supportive 15-minute market structure, and a setup score ≥75 — between 9:45am and 2:45pm ET only. It buys TWO ~$1.00 weekly contracts: stop −20%, sell one at +50% (stop instantly moves to breakeven), the last exits at +75%, breakeven, or a 15-minute close through the zone — and everything is flat before the close, every day. No overnights, ever. Auto is OFF per the spec: it paper-measures first; enable it after adding its account keys (ALPACA_*_4) and reviewing results.",
  },
  {
    title: "SBv2: no contract more than 8% out of the money",
    body: "SBv2 will now only take a setup if it can buy a contract within 8% of the stock's price (it used to reach as far as 25% OTM in exchange for a cheap premium). Strikes that far away need an unrealistic move to be worth anything, which is part of why so many trades died at the stop. If no $0.45-0.80 contract sits within 8% OTM, the setup is SKIPPED rather than traded on a deeper strike — expect fewer SBv2 entries, especially on expensive names.",
  },
  {
    title: "Backtesting: replay a strategy against history",
    body: "Vega can now replay SBv1 or SBv2 against months of real historical bars and show what WOULD have happened — hit rate, whether the stated probabilities were honest (an 85% setup should win more than a 55% one), how far trades went against you before working, and whether the signals beat random entries on the same stocks. Zero lookahead: at every simulated moment the strategy only sees data that existed then, and every report prints its own limitations so a good-looking number can't oversell itself. Results live on the new Backtest page (P&L → Backtest results, or Settings). Runs are started from the terminal; a strategy change can now be sanity-checked in an afternoon instead of waiting weeks of live paper trading.",
  },
  {
    title: "Sell at the target, not at a percentage",
    body: "Every strategy now exits at the projected TARGET PRICE instead of a percent rule. SBv1 sells when the stock reaches its historical-database target (the old 'ride to $2' bonus rule is gone; its safeties stay). SBv2 now buys ONE contract around $0.50-0.75 — strike doesn't matter, it's betting on a fast hard move pumping every contract — and sells at the target or a 50% stop; this also unlocks the expensive names it used to skip. Position pages now show the real sell target, and every position and log entry shows the exact contract traded (strike + expiry + fill).",
  },
  {
    title: "QQQ Manual: one level list + the ladder",
    body: "Enter ALL your morning levels in one box — no more per-chart fields. Vega enters 10 same-day contracts (~$0.30) the moment a level is TOUCHED (if its historical hit rate clears 60% and the math beats spread + time decay), then works the ladder: trim 3 at +50% and move the stop to -10%, stop to breakeven past +75%, sell 6 at +100%, and ride the last contract to the NEXT level (selling within ~$0.25 of it). Base stop -30%; everything flattens before the close. SBv3 is shelved for now per Farrukh.",
  },
  {
    title: "SBv2 enters on the tap + honest notifications",
    body: "SBv2 now buys the moment price actually TOUCHES its flipped level (within 0.4%) instead of waiting for a clean two-tick crossing that could miss a fast move between checks — once per setup per day. Notifications got honest too: the tap alert now says \"checking…\", then a second push tells you the outcome — \"Bought\" or exactly why it was blocked (no cheap contract that reaches the target, position cap, news against the breakout). Two launch bugs that silently blocked EVERY SBv2 entry were also found and fixed, and the overnight news-vet now runs after each scan so taps trade instantly with zero API cost.",
  },
  {
    title: "QQQ 0DTE: no more coin flips",
    body: "QQQ lost money taking setups its own history rated ~50/50 — on a same-day option, a coin flip structurally loses to the spread plus time decay. It now refuses anything below a 60% historical hit rate, and the contract picker subtracts the full round-trip cost (spread + theta) from every candidate — if the expected move doesn't clear the cost, it's no trade. Expect far fewer QQQ trades; that's the point.",
  },
  {
    title: "Today vs all-time P&L",
    body: "Positions → Closed now has a Today / All time toggle, so you can see today's realized profit or loss on its own — or the full history — per strategy account. Late-filling buy orders also now sync their real fill price back into the log automatically.",
  },
  {
    title: "SBv2 tuned: tap alerts, mechanical entry, cheap contracts",
    body: "Four SBv2 upgrades from the strategy owner. (1) Zone-tap alerts: the moment ANY SBv2 watchlist stock retests its flipped level, you get a push — \"NVDA zone tap 134.32 — enter PUT now\" — so alert timing and accuracy can be audited after the fact. (2) Mechanical entry: SBv2 now enters on that first clean retest tap directly (no extra score gate), matching the reset spec — it still skips on a news headline that contradicts the breakout. (3) Cheap contracts: it buys 2-3 far-OTM ~$0.30 contracts, sized and strike-picked so a move to the historical-database target can multiply them, and sells when the underlying reaches that target (not a fixed ratio). Names too expensive for a cheap contract that can actually reach the target are skipped. (4) The Today and Setups screens now show the same funnel — checked names → valid setups → tapped today — instead of two different \"ready\" numbers. The scan also logs why zones weren't promoted to flips (wick-only, closed back inside, already retested, too old).",
  },
  {
    title: "SBv2: a second SniperBot, running in parallel",
    body: "Farrukh reset SniperBot's entry logic, so instead of replacing the current one we're running BOTH side by side to see which wins. SBv1 is exactly today's SniperBot (unchanged). SBv2 is the new idea: it waits for a daily order block to be BROKEN and ACCEPTED through (the zone flips from resistance to support, or vice-versa), then buys the FIRST pullback that retests the flipped level — a 1-2 day swing. Same watchlist, its own separate $1000 paper account, its own log / P&L / scorecard, never blended. Every page's tab bar now shows SBv1 · SBv2 · QQQ, and the daily report compares SBv1 vs SBv2 head-to-head each day (plus a plain SPY benchmark). SBv2 starts in shadow-measurement mode — it's tracked but not auto-trading until it's switched on.",
  },
  {
    title: "QQQ is now truly intraday",
    body: "QQQ was reading multi-day (daily) levels and pricing same-day options against them — so it looked like a 5-day swing on a contract that expires today. It's been rebuilt around intraday zones: 15-minute and 1-hour levels drive same-day 0DTE day-trades, and 4-hour levels drive a next-day 1-day swing (a contract that expires tomorrow). Expected hold now reads in minutes/hours, not bars, and QQQ's zones refresh every few minutes while the market is open instead of once overnight. All numbers still come from the reaction database — now backed by 124,000 intraday reactions.",
  },
  {
    title: "Per-account cost tracking",
    body: "API spend is now tracked per strategy account, not lumped together. Each account's P&L subtracts only its own Claude cost — and since SniperBot's catalyst check is the only thing that uses Claude, QQQ 0DTE shows essentially zero. Tracking was reset to start fresh from today, so the numbers you see are real spend from here forward.",
  },
  {
    title: "History-backed numbers + QQQ 0DTE",
    body: "Every probability, expected move, and target now comes from a database of 236,000 real historical zone reactions — with the sample size shown, so a stat backed by 6 examples never looks like one backed by 400. The QQQ 0DTE strategy (Setups → QQQ tab) predicts where QQQ moves next from Daily + 4H history, then picks the highest expected-value contract, and trades its own separate $1000 paper account. Every page now has a SniperBot / QQQ toggle at the top so you can see each strategy's setups, positions, and P&L on its own account.",
  },
  {
    title: "SniperBot is live",
    body: "A new main strategy: institutional order-block setups on large/mega-cap stocks. It only buys when a zone tap is CONFIRMED on the live 5-min tape (rejection + volume), passes three code-computed scores + a historical-similarity read + an adversarial review, and clears a news/earnings catalyst check. Find it under the SniperBot tab. Now auto-trading your account.",
  },
  {
    title: "Per-strategy scorecards",
    body: "Each strategy (SniperBot swing, QQQ 0DTE, legacy Zones) is now measured on its own track against its own baseline — never blended — on the Scorecard page.",
  },
  {
    title: "Trade notifications",
    body: "Vega can now push a notification to your phone the moment it places or sells a trade — even when the app is closed. Turn it on in Settings → Trade notifications (on iPhone, add Vega to your home screen first).",
  },
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
    body: "Positions now has an Open / Closed toggle. Closed trades show what you sold for, the profit or loss, why it closed, and a realized-P&L total. Each open position also shows a hold-time estimate — how long the move usually takes and how many days are left.",
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
              <div key={step} className="wn-slide px-6 pt-3 pb-5 min-h-[188px] flex flex-col justify-center items-center text-center">
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
