# SB 15M — 15-Minute Empty-Space Zone-Tap Day Trader (`sb15m`)

> **LIVING DOC — update on every strategy change** (same rule as WhatsNew/HANDOFF).
> This file states exactly how the strategy is configured IN CODE. Source of truth:
> `src/lib/profiles.ts` (SB15M), `src/lib/monitor.ts` (`emptySpaceTap`, the
> `empty_space_tap` entry branch, `ladderPlan`/`runLadder`), `src/lib/strategy.ts`
> (`buildZoneSetups`), `src/lib/scanner.ts`, `src/lib/resolve.ts`,
> `src/lib/execute.ts`, `src/lib/backtest/intraday.ts`.
> Owner/Farrukh spec: **`message (5).txt` (2026-07-21)** — this REPLACES the earlier
> confirmation-candle version (`message (3).txt`) on the same profile id.
> _Last updated: 2026-07-21_

## Identity

| | |
|---|---|
| Profile id | `sb15m` (label **SB 15M**) |
| Status | ACTIVE, auto-execute **OFF** (paper-measure + review before enabling) |
| Account | Own paper account via `ALPACA_API_KEY_ID4` / `ALPACA_API_SECRET_KEY4` — auto-buy AND exits HARD-GATED on these keys (until set: signals/shadow only, default account is read-only) |
| Universe | 18 high-cap liquid names: NVDA TSLA AAPL AMZN META MSFT GOOGL AMD AVGO NFLX PLTR ORCL CRM COIN MSTR BA QQQ SPY |
| Chart | **15-minute**, with the order-block indicator's **HTF set to 4 hours** |
| Baseline | SPY |

## The idea (plain English)

Find a stock travelling through **empty space** on the 15-minute chart — an area
with no order-block zone — with a zone above it or below it. Wait for price to
reach the **first boundary facing it**, and take the rejection:

- Price **falls** from empty space into the **TOP** of a zone below → **CALLS**.
- Price **rallies** from empty space into the **BOTTOM** of a zone above → **PUTS**.

The tap is the trigger. One weekly contract at ~$1.00–$2.00, stop 20% below the
fill, stop to breakeven at +40% (keep holding), sell the whole contract at +100%,
and never hold overnight.

## Chart + indicator configuration (spec-critical)

| Setting | Value |
|---|---|
| Chart timeframe | 15 minutes |
| HTF for order blocks | 4 hours |
| HTF ATR length | 50 |
| Displacement strength | 1.3 × ATR |

In code that is `zoneTimeframes: [FOURH_TF]` — order blocks are computed from
**4-hour bars** (the indicator's HTF input) and everything else (approach, tap,
entry, management) happens on 15-minute/live data. We never "switch to the 4-hour
chart": no zone comes from any other timeframe, and daily / weekly / 1h / 5m / 1m
zones and other profiles' zones are never mixed in.

## Setup detection (scan + hourly re-scan while the market is open)

`buildZoneSetups` over completed 4H bars implements the spec's first-facing-boundary
rule exactly:

- Price **above** a zone → watch the zone's **TOP** boundary → CALL setup.
- Price **below** a zone → watch the zone's **BOTTOM** boundary → PUT setup.
- Never the far side of the zone, never its centre.
- **Empty space is a hard gate** — twice over: at scan time `requireClearRunway: true`
  demands no other zone within 4% in the trade's direction (real room for the rejection
  to pay), and at tap time the last completed 15-minute candle must be entirely outside
  every active zone (see Entry).
- Up to 2 zones watched per name (`watchPerTimeframe`).
- This maps to the spec's PUT WATCH / CALL WATCH / NO SETUP: a candidate exists only
  when price is outside the zone with a facing boundary and clear runway.

## Entry (live monitor, every minute) — the complete list of gates

1. **Session window 9:45am–2:45pm ET** (`entryWindowEt`): let the open establish
   itself; no new entries late in the afternoon (not enough time for the target).
2. **Valid empty space** (owner 2026-07-21): the **last COMPLETED 15-minute candle
   must be ENTIRELY outside every active 4H zone** — its high *and* low clear of all
   of them. (The forming candle is the one doing the touching, so the candle before it
   is what proves price was travelling through empty space.) This is also what blocks
   **delayed entries**: if the previous candle had already reached the zone, the
   reaction has happened and entering now would be chasing.
3. **First boundary in the direction of travel only:** no other active zone may sit
   between price and this boundary. That boundary is then the ONLY valid entry level
   — never the far side, never the centre.
4. **The touch, within 0.1 ATR** (`TOUCH_ATR_TOLERANCE`, spec range 0.05–0.10): price
   must be within 0.1 × the HTF ATR-50 of the boundary, on either side. Still
   approaching → keep watching (silent); already further past it than the tolerance →
   skipped and logged as gapped through / deep inside / a late chase. On SPY that
   tolerance is ≈ $0.43 (ATR-50 ≈ $4.29 on the 4H) — about 0.06% of price.
5. **Feed freshness:** the newest 15-minute bar must be < 20 minutes old, else
   "data feed delayed" and no trade.
6. **A contract in band** (below). No acceptable contract → skip, with the reason.
7. **One shot per setup per day** (tap-activity + proposal dedup): no re-entry after a
   stop without a genuinely new setup.

The active-zone list and the ATR come from the scan (`buildZoneSetups` stores
`active_zones` + `htf_atr` on the setup). A candidate scanned before this change falls
back to its own zone and a 0.1%-of-price tolerance until the next scan overwrites it.

**Deliberately NOT present**, per spec: confirmation candle · second retest ·
5-minute or 1-minute confirmation · market-structure break · QQQ/SPY confirmation ·
model approval · setup-score minimum · reaction-DB probability or target gate ·
catalyst/news check. `confirmation.enabled = false` is what keeps the predict/EV
machinery out of the execute path.

## Contract selection (`resolveContract`, plain price band)

- **Weekly** expiry (nearest Friday ≥ 1 day out).
- Premium **$1.00–$2.00**, picked closest to **$1.40**. Nothing materially outside
  the band — out-of-band means no trade.
- **ATM / slightly ITM:** strike window 1.5% OTM / 5% ITM (deliberately reaches
  further ITM than OTM; far-OTM contracts are excluded by the spec).
- Real two-sided market, bid ≥ 0.75 × ask ("spread unreasonably wide" → no trade).
- **Exactly ONE contract** (`caps.exactContracts: 1`, budget $210). Never average
  down, never add to a losing trade.

> ⚠️ **Fillability risk, carried over from the previous version:** on $200+ mega-caps
> an ATM weekly costs $3–5, so a $1–2 ATM/slightly-ITM contract often does not exist.
> The first backtest of the old version (band $0.70–1.35) found a contract for only
> 14 of 184 signals. The band is wider now, but expect many "no contract in band"
> skips on the expensive names — that is the spec's own instruction ("do not force a
> trade when no acceptable contract is available"), not a bug. Widening the OTM window
> or accepting pricier contracts is an owner decision.

## Sizing + caps

- 1 contract ≤ $2.00 = **≤ $200** at risk per trade.
- `maxOpenPositions` 2 · 3 trades/day (standard per-profile cap) · paper-only
  assertion on every order.

## Exit (`ladderPlan`/`runLadder`, `position_state`) — the spec's full sequence

Everything is measured against the **actual average fill premium**; the stop
ratchets off the peak and can never loosen. At most one action per quote update.

| Trigger | Action |
|---|---|
| Base | stop **−20%** below the fill → sell the contract |
| **+40%** | **stop moves to breakeven — nothing is sold** (explicitly not a profit-take) |
| Reversal after that | exit at breakeven |
| **+100%** | sell the entire contract |
| End of day | anything still open flattens ~25 min before the close, EVERY session (`forceEodFlatten`) |

No overnight holds, no conversion to a swing, no target- or time-based exits, and the
old 15-minute close-through exit was REMOVED (it is not in this spec).
**34/34 assertions** in `npm run ladder:selftest` cover these rules plus QQQ Manual's.

## Alerts + logging

The push and the proposal's `zoneRead` follow the spec's ALERT FORMAT: profile,
ticker, direction, active chart, indicator settings, empty-space status, approach,
zone position, entry boundary, stock price, contract, quantity, original stop,
breakeven activation, final target, mandatory exit, and a one-line explanation.
Taps, skips (with the exact reason), fills, the ratcheted stop and realized P&L all
land in the activity log / order rows.

## Measurement

- Own account / log / P&L / scorecard / shadow track (SPY baseline), tab on every page.
- **Backtest:** `npm run backtest -- --profile SB15M --from … --to …` replays the
  intraday engine, which now mirrors THIS entry (per completed 15-minute candle: came
  from empty space → reached the boundary → not gapped/deep → not accepted through)
  and this ladder against real 15-minute historical option bars. The playbook score
  and reaction-DB prediction are still recorded, but only as report groupings — they
  gate nothing, exactly like the live path.
  Earlier SB 15M runs on `/backtest` measured the RETIRED confirmation-candle version.

## Known approximations / not implemented

- The backtest evaluates the tap at each completed 15-minute candle; live fires the
  instant price enters the 0.1-ATR band around the level (and fills there, not at the
  next bar's open, which is what the replay uses).
- "Active zones" are the UNTAPPED order blocks (what the indicator still draws) plus
  the setup's own zone — a zone consumed by an earlier first touch no longer blocks
  empty space.
- "Data feed delayed" is approximated by the age of the newest 15-minute bar.
- Option volume / open-interest minimums are enforced only through the price band and
  the two-sided-market + spread test; there is no explicit OI floor.
- The scanner does not rank by option-spread tightness or stock volume beyond the
  fixed high-cap universe.

## Change log

- 2026-07-21 (owner refinement): empty space now REQUIRES the last completed 15-min candle to be entirely outside every active 4H zone; the entry level must be the FIRST boundary in the direction of travel (a nearer zone blocks it); touch tolerance switched from a %-of-price penetration cap to **0.1 ATR** either side of the boundary (spec 0.05–0.10), which also rejects delayed/chase entries. `buildZoneSetups` now carries `active_zones` + `htf_atr`; the backtest engine mirrors all three rules.
- 2026-07-21 (**this rework**, `message (5).txt`): replaced the confirmation-candle strategy with the pure empty-space zone TAP. Removed the confirmation candle, 15-min structure filter, score ≥75 gate, sniper engine, reaction-DB gates and the catalyst check; added gap-through / deep-inside / accepted-through / stale-feed guards. Contracts $1.00–2.00 ATM-ish (was $0.70–1.35), ONE contract (was two). New exit: −20% → breakeven at +40% (no sell) → +100% (was: sell 1 at +50%, runner at +75%, plus a 15m close-through exit). Backtest intraday engine updated to match.
- 2026-07-21: profile created (`message (3).txt` version): 4H zones on the 15-min chart, completed-15m confirmation candle, structure filter, score ≥75, two ~$1.00 contracts, +50%/+75% ladder. Never traded live (auto OFF, zero orders/proposals). Its backtest (run #4): 184 signals, only 14 fillable, net −$81.
