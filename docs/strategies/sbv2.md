# SBv2 — 4H Empty-Space Breakout & Retest (`sbv2`)

> **LIVING DOC — update on every strategy change** (same rule as WhatsNew/HANDOFF).
> This file states exactly how the strategy is configured IN CODE. Source of truth:
> `src/lib/profiles.ts` (SBV2), `src/lib/breakout.ts` (detectBreakouts),
> `src/lib/strategy.ts` (buildBreakoutSetups), `src/lib/scanner.ts`,
> `src/lib/monitor.ts` (touch entry + swing exits), `src/lib/intel.ts` (risk-only),
> `src/lib/resolve.ts`, `src/lib/execute.ts`. Spec: `message (4).txt` (2026-07-21).
> **This COMPLETELY REPLACES the daily-flip logic** (retired 2026-07-21; its code
> stays in `flips.ts` for reference, unused by any active profile).
> _Last updated: 2026-07-21_

## Identity

| | |
|---|---|
| Profile id | `sbv2` (label **SBv2**) |
| Status | ACTIVE; auto per the owner's runtime toggle (`npm run profile-auto`) |
| Account | Own paper account via `ALPACA_API_KEY_ID3` / `ALPACA_API_SECRET_KEY3` |
| Universe | Same ~129 large/mega-cap names as SBv1 |
| Timeframes | DAILY generates the order-block zones; the 4-HOUR chart does everything else |
| Baseline | SPY; daily report head-to-head vs SBv1 |

## The idea (plain English)

A stock breaks OUT of a major daily order block on the 4-hour chart, into clean
empty space (the black area before the next zone). The broken boundary should now
act as the springboard: when price pulls back and touches it the first time, buy
immediately — no confirmation candle, no news check, no model, no probability.
The option premium is the whole trade plan: sell everything at +100%, stop at
−25%, and get out early if a 4-hour candle closes back inside the zone (the
breakout failed).

## Setup detection (nightly scan + hourly re-scan while the market is open)

- **Zones: DAILY only** (ATR-50, displacement 1.7× — spec-fixed). Projected onto
  the 4h chart; they stay fixed until new daily zones form. No 4h/weekly/intraday
  zones, no other zone engine.
- **Breakout qualification** (`breakout.ts`, COMPLETED 4h candles only — the
  forming candle is always excluded):
  - A completed 4h candle **closes beyond the zone boundary** (above the top ⇒
    call side; below the bottom ⇒ put side). A wick poke without an outside close
    is rejected (`wick_only`).
  - The qualifying candle is the FIRST bar of the current outside run — later
    outside candles age the same breakout, they don't restart it.
  - **Cancelled/retired when** (funnel counts logged per scan): a completed 4h
    candle closed back inside (`closed_back_inside`) · the first retest already
    touched the boundary (`already_retested` — one trade per breakout, then it's
    spent) · older than **6 completed 4h bars** ≈ 2 sessions with no retest
    (`stale`) · another daily zone within **2%** ahead (`no_empty_space`) · price
    already traveled **> 60%** of the space to the next zone (`space_consumed`) ·
    unobstructed but price ran **> 12%** from the boundary (`too_far`).
  - Stored per candidate: the retest **boundary**, breakout candle time, bars
    since, empty-space %, consumed %.
- Verified on real data 2026-07-21: 129 names → 18 valid setups, funnel
  1102 stale / 411 already-retested / 26 closed-back-inside / 11 no-space /
  5 consumed / 2 wick-only.

## Entry (live monitor, every minute — MECHANICAL, in order)

1. **First actual TOUCH of the stored boundary** — call: price at/under the
   broken top; put: price at/over the broken bottom. NOT a proximity band ("do
   not trigger simply because price is near the level"). Once per candidate per
   day (tap-activity dedup); "checking…" push + audit row on the touch.
2. **Scan freshness:** candidate ≤ 3 days old.
3. **Live cancel check:** completed 4h candles since the breakout are re-checked
   at touch time — a close back inside the zone cancels the setup (a 4h candle
   CAN complete mid-session, unlike the old daily-flip logic).
4. **Risk layer ONLY** (`evaluateSbv2Intel(..., { riskOnly: true })`, kill switch
   `SBV2_INTEL=off`): 3 losses today → done for the session · max 2 open
   same-direction · max 2 per sector. **The market/structure/relative-strength
   gates are REMOVED from qualification** per spec ("keep account-level
   protections but do not use them to determine chart direction or trade
   qualification").
5. **Then buy immediately.** Removed entirely per spec: confirmation candle ·
   sniper engine · setup-score gate · QQQ/SPY/sector bias · RS filter · 15-min
   structure filter · reaction-DB target requirement · nightly news vet /
   model approval (vet-flips no longer covers sbv2). Execute's live wrong-way
   check still rejects an entry whose price already crossed through the zone.

## Contract selection (`resolveContract`, plain price band — no predict/EV anywhere)

- **Weekly** expiry, nearest Friday **≥ 2 days out** (a Thursday retest buys next
  Friday, never a 1-DTE).
- Premium **$1.00–$1.50** (ideal $1.20). **No fallback to cheaper lottery
  contracts** — out-of-band means SKIP, logged and pushed.
- ATM preferred / slightly OTM acceptable: strike window **4% OTM** / 3% ITM,
  plus the execute-side OTM assert (no fallback pick can slip a deeper strike).
- Real two-sided market: bid > 0, bid ≥ 0.7 × ask.

## Sizing + caps

- **1 contract** (unchanged — "use the configured SBv2 contract quantity");
  `perTradeBudget` $160 covers a $1.50 ask.
- `maxOpenPositions` 10 · 3 trades/day (account protections, kept per spec).

## Exit rules (swing style, per-minute, in priority order — PREMIUM rules only)

1. **+100% take-profit** (`swingTakeProfit: 1.0`): sell the ENTIRE position when
   the premium doubles. "The option premium target is the exit."
2. **−25% stop** (`swingStopLoss: -0.25`) off the actual average fill. Never
   widened, never averaged down.
3. **4H invalidation** (`invalidateOn4hClose`): a COMPLETED 4-hour candle closing
   back inside the daily zone exits immediately — before the stop if needed.
4. Safeties kept (inert in practice — the −25% stop fires first): catastrophe
   floor $0.10 within 2 days of expiry, expiry salvage.
- **No reaction-DB targets, no predicted underlying targets** — removed per spec
  (the underlying-target exit is disabled whenever `swingTakeProfit` is set).

## Logging (per spec)

Setup: zone values + boundary + breakout candle + bars-since + empty-space /
consumed % (candidate `setup` jsonb) · scan funnel in the scan log & daily
report · touch rows with price/time · proposal carries the full setup + plain
explanation · order rows carry contract/expiry/strike/fill/exit/P&L · every
skip is an activity row with the exact reason (+push when auto is on).

## Measurement

- Own account / log / P&L / scorecard / shadow track; daily report vs SBv1 + SPY.
- **Backtesting:** runs #1/#3/#6 on `/backtest` measure the RETIRED flip logic
  (valid history, wrong strategy) — the CLI refuses new "SBv2" runs so the old
  engine can't masquerade as the new logic. A 4h-granularity breakout replay is
  the follow-up if wanted.

## Change log

- 2026-07-21 (**this rework**): daily-flip logic fully replaced by the 4H empty-space breakout & retest per `message (4).txt`. Entry = first actual touch (band removed); confirmation/news-vet/DB-target/bias/structure/RS/score all removed; intel reduced to risk-only (session losses + exposure caps); contracts $1.00–$1.50 weekly ≥2d, ATM-ish (4% OTM window + execute assert); exits = +100% TP / −25% stop / 4h close-back-inside; scanner fetches daily+4h and logs the breakout funnel; hourly intraday re-scan.
- 2026-07-21 (earlier): ≤8% OTM cap (superseded by 4% above); backtests of the flip logic: Stage 1 flat calibration ≈ random; Stage 2 −$1,122 (25% window) / −$1,069 (8% cap) under live caps.
- 2026-07-20: intel layer added (now risk-only). 2026-07-17: 3-trades/day cap; price-first $0.45-0.80 pick (retired). 2026-07-16: 1-contract re-size, −50% stop (retired). 2026-07-13: original flip launch (retired).
