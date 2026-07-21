# SB 15M — Empty-Space Day Trader (`sb15m`)

> **LIVING DOC — update on every strategy change** (same rule as WhatsNew/HANDOFF).
> This file states exactly how the strategy is configured IN CODE. Source of truth:
> `src/lib/profiles.ts` (SB15M), `src/lib/monitor.ts` (sb15m entry branch +
> `runLadder`), `src/lib/confirm.ts` (`evaluateConfirmation`), `src/lib/intel.ts`
> (`classifyStructure`), `src/lib/ev.ts`, `src/lib/execute.ts`.
> Owner/Farrukh spec: `message (3).txt` (2026-07-21). _Last updated: 2026-07-21_

## Identity

| | |
|---|---|
| Profile id | `sb15m` (label **SB 15M**) |
| Status | ACTIVE, auto-execute **OFF** (spec: paper-trade + review before enabling) |
| Account | Own paper account via `ALPACA_API_KEY_ID4` / `ALPACA_API_SECRET_KEY4` — auto-buy AND exits HARD-GATED on these keys (until set: signals/shadow only, default account is read-only) |
| Universe | 18 high-cap liquid names: NVDA TSLA AAPL AMZN META MSFT GOOGL AMD AVGO NFLX PLTR ORCL CRM COIN MSTR BA QQQ SPY |
| Timeframe | 4-hour zones evaluated on the 15-minute chart; DAY TRADES ONLY |
| Baseline | SPY |

## The idea (plain English)

Intraday-only: find a stock trading in clean **empty space** (no nearby obstacle)
relative to its **4-hour order-block zones**, wait for price to come back and
retest the zone boundary that faces it, demand a **completed 15-minute candle**
proving the level is being defended, then trade a quick options move to fixed
premium targets. Everything is flat before the close, every single day.

## Setup detection

- **Zones: 4-hour ONLY** (spec-fixed): ATR-50, displacement **1.3×** (`FOURH_TF`),
  ~1 year of 4H bars. No daily/weekly/5m/1m zones, no other zone system.
- **Boundary logic** (`buildZoneSetups`, stateless — exactly spec §5): price ABOVE
  a zone → its TOP boundary is the call-side support level; price BELOW → the
  BOTTOM boundary is the put-side resistance. Never the zone middle.
- **Empty space is a HARD gate** (`requireClearRunway: true`): no other zone
  within 4% of price in the trade direction; up to 2 setups watched per symbol.
- Scanned nightly with all profiles; intraday the zones re-scan **hourly** while
  the market is open (a 4H zone can only change when a 4H bar completes).

## Entry gates (live monitor, every minute — ALL must pass, in order)

1. **Entry window:** 9:45am–2:45pm ET ONLY (`entryWindowEt`). No entries in the
   first 15 minutes (gap rule §16 — the first 15-min candle must complete first)
   and none late in the day.
2. **At the boundary:** live price within `[zone.bottom×0.99, zone.top×1.01]`.
3. **Completed 15-minute confirmation candle** (`evaluateConfirmation` over
   15-min bars with the forming candle EXCLUDED): rejection wick / engulfing /
   strong close into the level, with relative volume ≥ **1.3×**. A bare touch is
   never an entry (spec: "do not enter simply because price touched the line").
4. **15-minute market structure filter** (`classifyStructure`, strict fractal
   HH/HL vs LH/LL): an OPPOSED structure (bearish for a call / bullish for a put)
   blocks the entry unless the rejection candle is strong (execution score ≥ 60)
   — spec §8's "unless the zone reaction produces a confirmed reversal".
5. **Setup score ≥ 75** (`classifyAndScore` — spec §20's quality bar).
6. **Reaction-DB read** (`predict`, 4h bucket) + **sniper engine in intraday
   mode** (`evaluateSniper`): ≥3 prior reactions, level respected ≥35%, move
   ≥0.15%, probability ≥45, execution ≥40, not fighting a strong opposing
   SPY/QQQ trend (spec §19's market-alignment filter).
7. **Catalyst check** (cached, one Claude web-search per symbol/day, fails open)
   — spec §21 "major earnings release imminent" no-trade rule.
8. **Live wrong-way check** in execute (price already through the zone → reject).

## Contract selection (`selectByEV`, EV-ranked with cost netting)

- Nearest liquid **weekly Friday** expiry.
- **ATM / slightly ITM / at most ~one strike OTM**: strike window 2% OTM / 4% ITM.
- Price band **$0.70–$1.35**, ideal **$1.00** ("target contract price near $1.00").
- Real two-sided market required (bid ≥ 0.75 × ask); `netContractCosts: true` —
  the expected value must clear the round-trip spread + theta or it's NO trade
  (spec §11 "wide spreads / stale pricing" + §21 "spread too wide").

## Sizing + caps

- **TWO contracts** (`maxContracts: 2`), `perTradeBudget` **$220** (~$200 exposure).
  If two contracts near $1.00 aren't available with proper liquidity → skip.
- `maxOpenPositions` **2** · 3 trades/day (global default) · paper-only assertion.

## Exit — two-contract ladder (`runLadder` + `position_state`)

| Trigger | Action |
|---|---|
| Base | stop **−20%** on the option premium (both contracts) |
| **Completed 15-min close through the zone** | sell EVERYTHING immediately (structural invalidation beats the % stop — spec §12) |
| ret ≥ **+50%** | sell **1** contract; stop ratchets **straight to breakeven** (spec §14 — never exposed to −20% again) |
| ret ≥ **+75%** | sell the last contract (`runnerTakeProfit`) |
| Otherwise | last contract exits at breakeven or the EOD flatten |
| **~25 min before close** | flatten EVERYTHING (`forceEodFlatten` — fires every day even though the contract is a weekly). No overnights, no swing conversion. |

Ratchets key off the PEAK gain and never loosen. Targets are computed from the
actual fill price (broker fill, not mid).

## Measurement

- Own account/log/P&L/scorecard/shadow track (SB 15M tab on every page).
- **Backtesting:** requires the intraday-granularity replay engine (Stage 1 is
  daily-only today) — the backtest CLI refuses this profile until that's built.
  Spec §25's backtest requirements are noted there as the follow-up.

## Deliberately NOT implemented (from the spec) — flag before relying on them

- §19 sector-ETF comparison (SPY/QQQ market trend only; no per-sector ETF feed).
- §17 zone-freshness / times-tested weighting (the reaction DB supplies history
  quality, but "repeated tests weaken a level" isn't scored explicitly).
- §20's exact point-weighting (approximated by the playbook score + sniper
  engine + structure/volume gates, same thresholds: enter ≥75).
- §9 "aggressive entry" variant (only the standard completed-candle sequence).
- §22's full alert template (pushes carry profile/symbol/direction/zone/score;
  not every field).

## Change log

- 2026-07-21: profile created per Farrukh's SB 15M spec. Auto OFF; universe seeded (18 names); UI tab added; account = keys4 (unset → shadow only).
