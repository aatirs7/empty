# QQQ Manual — Owner-Entered Levels, Mechanical 0DTE (`qqq_manual`)

> **LIVING DOC — update on every strategy change** (same rule as WhatsNew/HANDOFF).
> This file states exactly how the strategy is configured IN CODE. Source of truth:
> `src/lib/profiles.ts` (QQQ_MANUAL), `src/lib/manual-levels.ts`,
> `src/app/api/manual-levels/route.ts`, `src/lib/monitor.ts` (`manualApproach`,
> `enteredToday`, `ladderPlan`/`runLadder`), `src/lib/resolve.ts`,
> `src/lib/execute.ts`, `src/app/api/remind-levels/`.
> _Last updated: 2026-07-21_

## Identity

| | |
|---|---|
| Profile id | `qqq_manual` (label **QQQ Manual**) |
| Status | ACTIVE (experimental); auto toggle lives in the level editor (Setups → QQQ Manual) |
| Account | QQQ paper account via `ALPACA_API_KEY_ID2` — `qqq_0dte` is shelved so they can never both trade it |
| Symbol | QQQ only |
| Timeframe | Same-day 0DTE off hand-drawn levels; the approach direction is read off the 15-minute chart |
| Baseline | QQQ |

## The idea (plain English)

**Follow the owner's levels mechanically.** The owner enters the day's QQQ levels;
from the 9:30 open Vega watches them, and the FIRST level price actually touches
takes the session's ONE trade. Which way it trades is decided at that moment by how
price arrived: falling into the level → CALLs, rising into it → PUTs. There is no
model, no probability estimate, no news check and no scoring anywhere in this
profile — the level and the approach ARE the decision (owner, 2026-07-21).

## Levels (the owner's input — never scanned)

- Entered on Setups → QQQ Manual (or POST `/api/manual-levels` `{levels: number[]}`),
  e.g. `715.36, 707.13, 700.88, 719.3`. Deduped; re-saving replaces the day's list.
- Each level gets a ±0.15% synthetic zone and maps to the 15-min bucket for display.
  The `direction` stored at save time is only a **provisional label** — the live
  15-minute approach decides the real one at touch time (see below), and the UI says so.
- **Carry-forward** (owner 2026-07-17): if no levels are entered by the first open
  tick, yesterday's list is cloned into today with a "reusing your last levels" push.
- **8:45 ET reminder push** every trading day (skips holidays and already-set days).
- The scanner NEVER touches this profile (`manualLevels: true`, `zoneTimeframes: []`).

## Entry (live monitor, every minute) — the complete list of gates

1. **Session window:** 9:30 ET open → 15:25 ET (`entryWindowEt`). The upper bound
   only exists so a fresh entry can't land inside the end-of-day flatten window.
2. **A real touch:** price REACHES or CROSSES the level, judged against the prior
   COMPLETED 15-minute bar (`manualApproach`) — not a proximity band. The 0.5%
   `LEVEL_PRECHECK_BAND` (plus a last-tick crossing test) is only a cheap superset
   that decides whether the full check runs; it can never trigger a trade on its own.
3. **Direction, at touch time:** prior completed 15-min bar closed ABOVE the level and
   price is now at/through it ⇒ approaching from above ⇒ **CALL**. Closed BELOW and
   price is now at/through it ⇒ from below ⇒ **PUT**. Nothing else can set it.
4. **One trade per session:** if this profile has already PLACED an order today
   (`enteredToday`, canceled/rejected excluded), every other level is ignored for the
   rest of the day. A level that fails to enter does NOT consume the session, and each
   level can only fire once per day anyway (tap-activity dedup).
5. **A valid contract** (below). If none exists, the trade is SKIPPED and the exact
   reason is logged + pushed.

**Deliberately NOT present** (all removed 2026-07-21, this profile only): confirmation
candle, playbook/score gate, sniper engine, 60% probability floor, reaction-DB target
requirement, catalyst/news veto, EV-after-cost filter, next-level target exit,
no-bounce timeout. `confirmation.enabled = false` is what keeps the predict/EV
machinery out of the execute path.

## Contract selection (`resolveContract`, price-first)

- Expiry **same-day** (`zeroDte`); strike window 3% OTM / 1% ITM (a window only —
  price is the selector).
- Ask **between $0.30 and $0.35** (`priceFloor`/`priceCap`), closest to $0.32.
  **No substitution outside the band** — out-of-band means no trade.
- Real two-sided market: bid > 0 and bid ≥ 0.7 × ask.
- **Ask size ≥ 5** (`minAskSize`) so the whole lot can fill. *Caveat: enforced only
  when the quote feed reports a size; an absent size is treated as unknown, not zero
  (failing closed on it would block every trade).*
- **Exactly 5 contracts** (`caps.exactContracts: 5`, budget $200). If the full lot
  can't be funded/capped, execute throws `lot_size` and the trade is skipped — never
  a partial lot. Partial-fill handling is not implemented (a fill of fewer than 5
  would still be laddered, with tranches scaled proportionally).

## Sizing + caps

- 5 contracts × ≤$0.35 = **≤$175** at risk per trade; `perTradeBudget` $200.
- `maxOpenPositions` **1** · `maxTradesPerDay` **1** · paper-only assertion on every order.
- Auto-buy AND exits are HARD-GATED on the account keys (`ALPACA_*_2`).

## Exit ladder (`ladderPlan`/`runLadder`, `position_state` table)

State is seeded from the buy fill (**actual average fill premium**, qty). `ret` = live
bid vs that fill; `peak` = high-water mark. **The stop ratchets off PEAK and can never
loosen.** At most ONE action per quote update; the next update re-evaluates immediately.

| Trigger | Action |
|---|---|
| Base | stop **−25%** → sell all 5 |
| ret ≥ **+50%** | sell **2**, stop ratchets to **breakeven** |
| ret ≥ **+75%** | sell **1**, stop ratchets to **+25%** |
| fade back to **+25%** after that trim | sell all remaining (it's the ratcheted stop) |
| ret ≥ **+100%** | sell everything still open (the final 2) |
| End of day | anything still open flattens ~25 min before the close |

Whole-trade P&L is summed from broker sell fills at the final close.
**28/28 assertions** in `npm run ladder:selftest` cover every rung above plus SB15M's
untouched legacy ladder.

## Logging (audit trail for every decision)

- **Touch** → `activity_log` `kind: "tap"` with the level, the prior completed 15-min
  bar (timestamp + close), the approach, the resulting direction and the touch price,
  duplicated into `meta` for querying; plus a "checking…" push when auto is on.
- **Entry** → proposal `zoneRead`/`rationale` (level, bar, approach, direction, the
  ladder in words) + the order row (contract, qty, limit, fill).
- **Every trim** → activity row + push: contracts sold, gain at the trim, and the
  stop the next tick will enforce.
- **Final close** → exit price, exit reason, realized P&L on the order row.
- **Every skip** → activity row with the exact reason (no contract in band / lot can't
  be funded / session trade already taken / outside the window), pushed when auto is on.

## Measurement

- Own account/log/P&L/scorecard/shadow (QQQ baseline), tab on every page.
- **Backtesting: NOT possible honestly** — the owner's levels have no historical
  record, and substituting today's levels would be lookahead. The backtest CLI
  refuses this profile with that explanation.

## Change log

- 2026-07-21: **mechanical rework (owner).** 9:30-open window; first touched level only, one trade/session; direction from the prior completed 15-min bar at touch time; real touch instead of a proximity band; probability floor, DB target, catalyst, EV filter, score gate, next-level target exit and no-bounce timeout all REMOVED; exactly 5 contracts at $0.30-0.35 with an ask-size floor; new ladder (−25% / +50% sell 2 → breakeven / +75% sell 1 → +25% / +100% sell the rest).
- 2026-07-17: levels CARRY FORWARD day-to-day; 8:45 ET reminder push; collapsed home card; next-level target exit; 3-trades/day cap.
- 2026-07-16: rework to ONE flat level list + LEVEL TOUCH entry + the 10-contract ladder; contracts $0.28–0.38 × 10.
- 2026-07-15: profile created (experimental) on the freed QQQ account; kept the 60% floor + EV-net-of-costs coin-flip protections from qqq_0dte.
