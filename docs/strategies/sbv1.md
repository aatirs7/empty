# SBv1 — SniperBot Master (`sniper_swing`)

> **LIVING DOC — update on every strategy change** (same rule as WhatsNew/HANDOFF).
> This file states exactly how the strategy is configured IN CODE. Source of truth:
> `src/lib/profiles.ts` (SNIPER_SWING), `src/lib/monitor.ts`, `src/lib/sniper.ts`,
> `src/lib/playbook.ts`, `src/lib/confirm.ts`, `src/lib/ev.ts`, `src/lib/execute.ts`.
> _Last updated: 2026-07-21_

## Identity

| | |
|---|---|
| Profile id | `sniper_swing` (label **SBv1**) |
| Status | ACTIVE, auto-execute **ON** by default |
| Account | Default Alpaca paper account (`ALPACA_API_KEY_ID`) — PA33FAVNIVA2 |
| Universe | ~129 large/mega-cap optionable names (`universe` table, `profileId = sniper_swing`) |
| Timeframe | Daily zones, multi-day swing (typical hold 1–10 trading days) |
| Baseline | SPY (shadow + scorecard) |

## The idea (plain English)

Institutional order-block swing trading. A "zone" is the footprint of a large
displacement move on the daily chart. When price comes back and taps that zone,
SBv1 waits for live 5-minute proof that buyers/sellers are actually defending it,
scores the setup against real history, tries to disprove it, and only then buys a
cheap weekly option in the bounce direction. Sell at the historically-derived
target. Everything numeric is code-computed from real bars — the model never
invents a price, probability, or target.

## Setup detection (nightly scan, 00:00 ET `/api/scan`)

- Zone math (`zones.ts`, Pine port, Farrukh's settings): **Wilder ATR-50**,
  displacement candle body > **1.7 × ATR** following an opposite-color candle;
  demand zone = prior candle open→low, supply = prior open→high. First-touch
  tracking; zones persist for all time (full ~4000-day daily history, split-adjusted).
- Setup building (`strategy.ts buildZoneSetups`, **stateless direction**): price
  above the zone → falls to tap the TOP → **call**; below → rises to tap the
  BOTTOM → **put**. The demand/supply label never drives direction.
- **White-space hard gate** (`clear_runway`): no other zone within 4% of price in
  the trade direction. Candidates without clear runway are dropped.
- One nearest zone per symbol (`watchPerTimeframe` default 1) → `candidates` table.

## Entry gates (live monitor, every minute during market hours — ALL must pass, in order)

1. **At the zone:** live price within `[zone.bottom × 0.99, zone.top × 1.01]`.
2. **5-min confirmation candle** (`confirm.ts`, SIP feed): the candle reached
   into the zone AND printed a rejection wick (wick ≥ body and ≥ 40% of range),
   a strong directional close (≥ 60% of range), or an engulfing — with relative
   volume ≥ **1.3×** the prior ~20-bar average. A bare touch is never a signal.
3. **Playbook score ≥ 75** (`playbook.ts classifyAndScore` on 400 days of bars):
   classifies the playbook (Support Bounce / Support Reclaim / Support Retest /
   Breakout Rejection / Resistance Retest / Resistance Rejection), computes safe +
   extended targets from daily swing highs/lows, historical reactions at the level,
   and R/R vs zone height.
4. **Reaction-DB prediction** (`predict.ts` → `queryReactions`): empirical hit
   rate / expected move / targets / hold from prior daily taps (tiered widening:
   symbol+pattern → symbol → all-symbols; min-sample honesty N=20). No
   `minProbability` floor for SBv1 (unset).
5. **Sniper engine** (`sniper.ts evaluateSniper`) — adversarial review; ANY
   rejection kills the trade: < 3 prior reactions · low sample (< 20) · level
   respected < 40% historically · R/R < 1 · historical move < 2% (too small for
   weekly options) · fighting a strong opposing market trend (SPY/QQQ blend ×
   direction < −0.3) · Probability < 55 · Weekly-Options-Potential < 50 ·
   Execution-Quality < 45 (from the confirmation candle).
6. **Catalyst check** (`catalyst.ts`, the ONLY model use): one Claude Haiku
   web-search per symbol/day (cached as an activity row) asking "earnings/Fed
   event within the hold window?" — blocks on a scheduled catalyst, **fails open**
   on error/timeout.
7. **Live wrong-way check** (`execute.ts`): rejects if spot has already crossed
   through the zone the wrong way since the scan.

## Contract selection (`ev.ts selectByEV` — expected-value ranked)

- Expiry: nearest weekly **Friday**, horizon-matched — must be ≥ the predicted
  hold (expectedHoldBars → days).
- Strike window: up to **12% OTM** / 3% ITM; ask price band **$0.40–$1.00**
  (ideal $0.75).
- Ranks by **EV = P×gain − (1−P)×loss − theta·hold** using live greeks
  (`getOptionSnapshots`); `netContractCosts` OFF for SBv1 (no round-trip-spread
  netting). Picks the Primary EV contract; requires a real two-sided quote.

## Sizing + caps (enforced server-side in `executeProposal`)

- `perTradeBudget` **$100**, `maxContracts` **1** → always 1 contract.
- `maxOpenPositions` **10** (and the `MAX_OPEN_POSITIONS` env ceiling).
- **3 trades/day** (`maxTradesPerDay` default, all profiles — Farrukh 2026-07-17).
- Paper-only assertion on every order (`getBroker()`).

## Exit rules (swing style, per-minute `manageExits`, in priority order)

1. ~~Bonus premium ride to $2~~ — **REMOVED 2026-07-16** (Farrukh: sell at the
   intended target, not a % rule).
2. **No mid-swing premium stop** — deliberate. A cheap option dipping intraday is
   held while the swing thesis is intact (`swingStopLoss` unset).
3. **Swing invalidation:** last COMPLETED daily close through the zone
   (call: close < zone.bottom; put: close > zone.top) → sell.
4. **Target hit:** underlying reaches the persisted reaction-DB target
   (`predict.targetMain` stored on the proposal at entry; falls back to the
   playbook `safeTarget`) → sell.
5. **Catastrophe floor:** bid ≤ **$0.15** AND ≤ **2 days** to expiry → sell.
6. **Expiry salvage:** ≤ 1 day to expiry → sell whatever's left.

## Measurement

- Shadow track (`shadow.ts`): every valid setup shadowed (enter ask, mark bid) +
  a daily SPY ATM-call baseline. Scorecard (`/scorecard`) = real-account P&L only,
  never blended with other profiles. Daily report at 16:10 ET.
- Backtest: Stage 1 + Stage 2 supported (`npm run backtest -- --profile SBv1 ...`).
  Apr–Jul 2026: Stage 1 — 65 signals, 43.1% hit, calibration weak (80+ bucket
  realized 40.7%). Stage 2 (real chains + modeled spread; EV picker approximated
  by the price band) — 38 fillable trades, **net −$845 all-signals / −$752 under
  live caps**, win 21%; with NO mid-swing stop, 18/38 trades lost 75–100% before
  catastrophe/salvage. See `/backtest`.

## Change log

- 2026-07-16: `targetPremium` $2 ride removed — exits are purely target/invalidation/safeties (2-week test).
- 2026-07-17: 3-trades/day cap added (all profiles). Strike-selection tweak PENDING Farrukh's concrete rule.
- 2026-07-09: `maxOpenPositions` raised 3 → 10 by owner.
