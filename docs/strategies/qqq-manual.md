# QQQ Manual — Owner-Entered Levels, 0DTE Ladder (`qqq_manual`)

> **LIVING DOC — update on every strategy change** (same rule as WhatsNew/HANDOFF).
> This file states exactly how the strategy is configured IN CODE. Source of truth:
> `src/lib/profiles.ts` (QQQ_MANUAL), `src/lib/manual-levels.ts`,
> `src/app/api/manual-levels/route.ts`, `src/lib/monitor.ts` (level touch +
> `runLadder`), `src/lib/ev.ts`, `src/lib/execute.ts`, `src/app/api/remind-levels/`.
> _Last updated: 2026-07-21_

## Identity

| | |
|---|---|
| Profile id | `qqq_manual` (label **QQQ Manual**) |
| Status | ACTIVE (experimental); auto toggle lives in the level editor (Setups → QQQ Manual) |
| Account | QQQ paper account via `ALPACA_API_KEY_ID2` (PA3BS187DK8F) — `qqq_0dte` is shelved so they can never both trade it |
| Symbol | QQQ only |
| Timeframe | Same-day 0DTE off hand-drawn levels (statistics use the 15-min reaction bucket) |
| Baseline | QQQ |

## The idea (plain English)

Farrukh's level-to-level bounce play, with the OWNER supplying the levels. Every
morning the owner enters the day's QQQ levels from their own chart (ONE flat list,
used across all monitoring). When price TOUCHES a level, Vega buys ~10 cheap
same-day contracts in the bounce direction — but only if QQQ's own history says
that kind of touch actually bounces more than 60% of the time AND the option math
beats the round-trip cost. The exit is a laddered scale-out that rides the last
contract to the NEXT level in the list. All numbers (probability, targets,
expected hold) come from the historical reaction database — never the model.

## Levels (the owner's input — never scanned)

- Entered on Setups → QQQ Manual (or POST `/api/manual-levels` `{levels: number[]}`),
  e.g. `715.36, 707.13, 700.88, 719.3`. Deduped; re-saving replaces the day's list.
- Direction is assigned by side of live spot (level below spot = support = call;
  above = resistance = put); each level gets a ±0.15% synthetic zone; all rows map
  to the **15min** reaction bucket for statistics.
- **Carry-forward** (owner 2026-07-17): if no levels are entered by the first open
  tick, yesterday's list is cloned into today (fresh direction off live spot) with
  a "reusing your last levels" push.
- **8:45 ET reminder push** every trading day (skips holidays and already-set days).
- The scanner NEVER touches this profile (`manualLevels: true`, `zoneTimeframes: []`).

## Entry gates (live monitor, every minute — LEVEL TOUCH, no candle, in order)

1. **Level touch:** live price within **0.15%** (`LEVEL_TOUCH_BAND`) of a level;
   once per level per day (tap-activity dedup). "Checking…" push + audit row.
2. **NO confirmation candle, NO playbook-score gate, NO sniper engine** (the
   owner's newest instruction: enter on the touch; the sniper engine would
   auto-reject candle-less entries).
3. **60% probability floor** (`minProbability: 60`, HARD): the reaction DB's hit
   rate for this kind of touch (15-min bucket) must be ≥ 60%. A ~50% coin flip
   structurally loses to spread + same-day theta → correct action is NO trade.
4. **Reaction-DB target must exist** (`pred.targetMain != null`).
5. **Catalyst check** (cached, one Claude Haiku web-search per day, fails open).
6. **EV net of costs** (`netContractCosts: true`): the selected contract's
   expected value must stay positive AFTER subtracting the round-trip bid/ask
   spread AND theta over the expected hold. Nothing clears the cost → no trade.

## Contract selection (`selectByEV`, 0DTE)

- Expiry: **same-day** (`zeroDte`).
- Near-the-money: strike window 1.5% OTM / 1% ITM.
- Price band **$0.28–$0.38** (ideal $0.32) — "10 × ~$0.30-0.35 contracts".
- EV-ranked with greeks; requires a real two-sided market; the cost-netting
  reject (above) applies here.
- **Target override:** the persisted exit target is the NEXT level in the day's
  list in the trade direction (falls back to the DB `targetMain`);
  `expectedHoldMin` persisted alongside.

## Sizing + caps

- `perTradeBudget` **$350**, `maxContracts` **10** (10 × ~$0.32 ≈ $320);
  fewer fill if budget/liquidity is short — ladder tranches scale proportionally.
- `maxOpenPositions` **2** · **3 trades/day** · paper-only assertion.
- Auto-buy AND exits are HARD-GATED on the account keys (`ALPACA_*_2`) so two
  profiles can never manage each other's identical 0DTE contracts.

## Exit — Farrukh's ladder (`runLadder`, driven by the `position_state` table)

State is seeded from the buy fill (entry premium, qty). `ret` = live bid vs entry;
`peak` = high-water mark. **Ratchets key off PEAK and can never loosen.**

| Trigger | Action |
|---|---|
| Base | stop **−30%** (sell ALL remaining) |
| ret ≥ **+50%** | sell **3** contracts, stop ratchets to **−10%** |
| peak ≥ **+75%** | stop ratchets to **breakeven** |
| ret ≥ **+100%** | sell **6** more |
| Runner (last contract) | exits at the ratcheted stop · when QQQ comes within **$0.25** of the next-level target · no-bounce timeout (no trim yet AND age > 2 × expectedHoldMin) · end-of-day flatten |
| 0DTE flatten | everything still open sells ~25 min before the close |

One ladder rung per tick; tranches scale (min 1, always leave 1 runner) when
fewer than 10 filled; whole-trade P&L is summed from broker sell fills at final
close. 12/12 synthetic ladder assertions pass (`runLadder` is exported for tests).

## Measurement

- Own account/log/P&L/scorecard/shadow (QQQ baseline), tab on every page.
- **Backtesting: NOT possible honestly** — the owner's levels have no historical
  record, and substituting today's levels would be lookahead. The backtest CLI
  refuses this profile with that explanation (spec §Manual levels).

## Change log

- 2026-07-17: levels CARRY FORWARD day-to-day; 8:45 ET reminder push; collapsed home card; next-level target exit; 3-trades/day cap.
- 2026-07-16: rework to ONE flat level list + LEVEL TOUCH entry (confirmation candle dropped per owner's newest instruction) + the 10-contract ladder; contracts $0.28–0.38 × 10.
- 2026-07-15: profile created (experimental) on the freed QQQ account; kept the 60% floor + EV-net-of-costs coin-flip protections from qqq_0dte.
