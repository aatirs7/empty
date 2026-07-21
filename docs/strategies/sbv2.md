# SBv2 — Order-Block Flip + First Retest (`sbv2`)

> **LIVING DOC — update on every strategy change** (same rule as WhatsNew/HANDOFF).
> This file states exactly how the strategy is configured IN CODE. Source of truth:
> `src/lib/profiles.ts` (SBV2), `src/lib/flips.ts`, `src/lib/strategy.ts`
> (buildFlipSetups), `src/lib/monitor.ts`, `src/lib/intel.ts`, `src/lib/vet-flips.ts`,
> `src/lib/resolve.ts`, `src/lib/execute.ts`. Spec: `sniperbot-daily-swing-v2.md`.
> _Last updated: 2026-07-21_

## Identity

| | |
|---|---|
| Profile id | `sbv2` (label **SBv2**) |
| Status | ACTIVE, auto-execute **ON** (owner enabled 2026-07-13) |
| Account | Own paper account via `ALPACA_API_KEY_ID3` / `ALPACA_API_SECRET_KEY3` |
| Universe | Same ~129 large/mega-cap names as SBv1 (`profileId = sbv2` rows) |
| Timeframe | Daily flips, 1–2 day swing |
| Baseline | SPY; daily report runs an SBv1-vs-SBv2 head-to-head |

## The idea (plain English)

Farrukh's logic reset, run in PARALLEL with SBv1 (never replacing it). Instead of
fading a zone tap, SBv2 trades the **role flip**: when price BREAKS a daily order
block and ACCEPTS through it (a real daily close beyond the whole zone — the
overnight-gap case counts), the zone flips role. Broke ABOVE ⇒ the zone's TOP
becomes support ⇒ the FIRST pullback that taps that top is a **call** entry.
Broke BELOW ⇒ the BOTTOM becomes resistance ⇒ first tap = **put**. Zone bounce =
liquidity = a fast hard move = premium pump across all contracts — so the entry
is mechanical and the contract is picked by price, not strike.

## Setup detection (nightly scan, 00:00 ET; flips re-derived fresh from settled daily bars — no state table)

- Zones: same daily math as SBv1 (ATR-50, displacement 1.7×, full history).
- **Flip qualification** (`flips.ts detectFlips`): a daily close beyond the ENTIRE
  zone (acceptance), within the last **2 sessions** (`sessionsSinceFlip ≤ 2`).
  Dropped (with funnel counts logged): wick-through only (no closing acceptance) ·
  closed back inside after accepting · **first retest already happened** ·
  stale (> 2 sessions) · price already ran > **12%** from the boundary.
- Daily timeframe ONLY qualifies a flip; up to 3 flips watched per symbol.
- White space is informational for SBv2 (`requireClearRunway: false`) — flip
  validity + first-retest is the gate.
- **Nightly news vet** (`/api/vet-flips`, 00:30 ET): ONE Claude Haiku web-search
  per symbol+direction (shared across flip profiles) — scheduled catalyst AND
  "fresh material news against/supporting this accepted breakout?" Verdict stored
  on the candidate (`setup.news`); un-vetted flips **fail open**.

## Entry gates (live monitor, every minute — MECHANICAL by design, in order)

1. **Tap of the flipped boundary:** live price within **0.4%** (`FLIP_TAP_BAND`)
   of the flipped edge — a real touch, not a two-tick crossing. Once per
   candidate per day (tap activity dedup). Fires a "checking…" push + audit row.
2. **Scan freshness:** candidate ≤ 3 days old (flip validity can't change
   intraday — no re-derivation at fire time; that caused false invalidations).
3. **Chart readable:** `classifyAndScore` must compute (playbook recorded for
   display; **NO minimum-score gate** — the reset spec enters on the clean retest).
4. **NO sniper engine, NO confirmation candle** — deliberately skipped (mechanical).
5. **News veto** (from the nightly vet): block on `catalyst` (earnings/Fed) or
   `newsAgainst` (fresh news contradicting the breakout). Fail-open if un-vetted.
6. **Reaction-DB target must exist** (`predict.targetMain != null`, daily bucket):
   no historical target = move too small / thin history = no trade.
7. **Market-intelligence + portfolio-risk layer** (`intel.ts`, 2026-07-20, after
   the 7/17 −$402 correlated-calls day; REVERT: env `SBV2_INTEL=off`). All bar
   math + live positions, zero model calls, fails OPEN on data errors. In order:
   - **Session loss response:** 3 losses today → done for the session; 2 straight
     losses → only continue if the market is clearly aligned with the trade.
   - **Market bias filter:** QQQ + SPY classified into 5 levels (day % + VWAP side
     + 75-min momentum + SMA20 side + 5-day drift). STRONGLY opposed market blocks
     outright; ordinarily opposed requires relative strength ≥ 1% vs QQQ AND
     aligned stock structure.
   - **Stock structure:** 15-min strict fractal swings (HH/HL vs LH/LL with a
     protected-swing check) must not oppose the trade.
   - **Exposure caps:** max 2 open same-direction (unless market strongly aligned),
     max 2 per sector (static universe sector map).
   Every accept/veto logs a plain-English verdict.
8. Confidence = the DB hit rate (`pred.probability`). Outcome push follows
   ("Bought …" or "not entered — why").

## Contract selection (price-first — Farrukh: "don't focus on strike")

`resolveContract` (`resolve.ts`), NOT the EV picker:
- Expiry: nearest weekly **Friday ≥ 2 days out** (`minDays: 2` — a Thursday tap
  buys NEXT Friday, never a 1-DTE).
- Strike window: up to **8% OTM** / 4% ITM. Owner 2026-07-21: *"only take the setup
  if the contract is no more than 8% OTM."* This is a HARD gate, not a preference —
  if no liquid $0.45–0.80 contract sits within 8% OTM, the setup is **skipped**
  (no deeper-OTM fallback). Enforced twice: the `resolveContract` strike window, and
  an explicit assert in `execute.ts` on the `flip_retest` path. (Was 25% — strike
  treated as unimportant; expensive names will now skip more often.)
- Pick the contract whose **ask is closest to $0.60** within **$0.45–$0.80**,
  requiring a real two-sided market (bid > 0, bid ≥ 0.5 × ask, ask > $0.05).
- **No reachability requirement** (dropped 2026-07-16) and no horizon-match gate —
  the bet is the premium pump, not intrinsic value at target.

## Sizing + caps

- **ONE contract** (`maxContracts: 1`), `perTradeBudget` $100.
- `maxOpenPositions` 10 · **3 trades/day** (added 2026-07-17 after 20 morning
  entries; "be patient for the top setups").
- Paper-only assertion on every order.

## Exit rules (swing style, per-minute, in priority order)

1. **Premium stop −50%** (`swingStopLoss: -0.5`) — Farrukh: "sell at intended
   target or 50% stop".
2. **Swing invalidation:** last completed daily close back through the zone.
3. **Target:** underlying reaches the persisted reaction-DB target
   (`predictedTarget` stored in the proposal at entry).
4. **Catastrophe floor:** bid ≤ **$0.10** AND ≤ 2 days to expiry.
5. **Expiry salvage:** ≤ 1 day to expiry.
(No $2 premium ride — SBv2 never had one.)

## Measurement

- Own account / log / P&L / scorecard / shadow track; daily report head-to-head
  vs SBv1 + SPY benchmark; scan funnel (why flips weren't promoted) in the report.
- Backtest Stage 1 (Apr–Jul 2026, variant #1): 490 signals, 53.1% hit,
  **calibration flat** (~52% realized at every stated probability), ≈ random-entry
  baseline — no timing edge in that (strong-uptrend) window. See `/backtest`.
- Backtest Stage 2 (same window, real historical option chains + modeled spread):
  273 fillable trades → **net −$2,009 all-signals / −$1,122 under live caps on a
  $1,000 account** (win rate ~14%; 202 of 273 trades died at the −50% stop; the
  58 target hits made +$3,971 but couldn't cover the stops). Edge worsens under
  wider-spread sensitivity. 217 signals found no $0.45–0.80 contract.

## Change log

- 2026-07-21: contract must be **≤ 8% OTM** (owner) — strike window 25% → 8%, plus an execute-side assert; setups with no in-band contract that close are skipped.
- 2026-07-20: intel layer added (session-loss response, market bias, structure, exposure caps). Revert: `SBV2_INTEL=off`.
- 2026-07-17: 3 trades/day cap; price-first contract pick ($0.45–0.80 closest to $0.60, weekly ≥ 2d via `minDays`); pushes name the profile.
- 2026-07-16: re-size to ONE $0.45–0.80 contract; `requireTargetReachable` dropped; −50% swing stop added.
- 2026-07-13: launch; entry = tap band (not crossing); news vet moved to nightly scan; catalyst removed from the hot path; false-flip-invalidation + tick-timeout bugs fixed; auto ON.
