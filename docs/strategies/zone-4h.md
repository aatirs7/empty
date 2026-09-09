# Zone 4H — 4H Empty-Space Zone-to-Zone Swing

Profile id: `zone_4h`. Owner spec: `Downloads/message (9).txt` (2026-09-09). **Replaces `sb_d1`** and inherits its paper account (`ALPACA_*_3`). Trades the owner's 26-name watchlist ONLY.

## Idea
Trade a move from a **confirmed** 1D zone, through clean empty space, to the next opposing zone — but only after a **two-touch confirmation** on the 4-hour chart. This is the selective answer to "the bot enters everything it sees": no first-touch entries, only a re-tap of a zone that has already proven it reacts.

## Watchlist (the only names scanned/traded)
NVDA, TSLA, META, HOOD, MSTR, AMD, PLTR, AMZN, AAPL, MSFT, GOOGL, COIN, AVGO, MU, ORCL, SOFI, RIVN, RKLB, ASTS, IONQ, DKNG, HIMS, CRCL, RBLX, DELL, UBER. Seeded in `seed-universe.ts` (`ZONE4H`), `zone_4h` profileId only.

## Zones
Same SniperBot 1D / ATR-50 / 1.7× zones as `zone_swing` (`firstTouchOnly:false` so all standing levels count). Confirmation is read off completed **4-hour** candles.

## Setup (`buildZoneSwing4hSetups`, `src/lib/strategy.ts`)
Price in clean empty space between the nearest zone below and above:
- **CALL:** nearest **demand** zone below = entry (tap its **top**); target = **bottom** of the nearest supply zone above.
- **PUT:** nearest **supply** zone above = entry (tap its **bottom**); target = **top** of the nearest demand zone below.
- **Min move:** `|target − entry| ≥ max($2, 2% of price)` (scales across the $16–$1000 watchlist).
- **Empty space** guaranteed by construction (nearest-below / nearest-above neighbours, nothing between).

## Two-touch confirmation (`confirmed4hRejection`)
The entry zone must have been **rejected on a completed 4H candle within the last 2 trading days**:
- **CALL/demand:** a 4H candle dipped to tap the zone top (`low ≤ top`) and **closed back above** it (`close > top`).
- **PUT/supply:** a 4H candle rose to tap the zone bottom (`high ≥ bottom`) and **closed back below** it (`close < bottom`).
- Older than the last 2 trading days ⇒ expired, no entry until a fresh rejection. The confirming candle time is stored on the setup (`accepted_at`).

## Entry (`entryKind: "zone_swing_tap"`, reused)
The **live re-tap** of that same confirmed zone edge after the open is the trigger (two-tick `tapCrossing`). No premarket entries — the monitor is market-hours gated. The prior 4H rejection is the confirmation; the second tap is the trigger (no waiting for another 4H close).

## Contract (`resolveContract`, strike anchored to target)
- **Following week's Friday** weekly (`expiryKind:"friday"` + `minDays:7`) — enough time for the underlying to travel zone-to-zone.
- **Strike ≈ $2 ITM past the target** (`contract.strikeFromTarget:2.0` + execute's `targetPrice`): call strike ≈ target − $2, put strike ≈ target + $2 — ITM at the target, high delta, real liquidity. 1 contract, `perTradeBudget 900`.
- **Entry price = MID** between bid and ask (the universal mid-price rule in `execute.ts`), not the ask.

## Exit (underlying-driven swing)
- **Take profit:** the **underlying reaches the target zone** (`predictedTarget`). Do not hold for a move through the opposing zone.
- **Invalidation** (`invalidateOnDailyReenter`): daily close/open back **inside the entry zone**. **No option-% stop.** Near-expiry catastrophe floor / salvage only.

## Caps / account / scheduling
- `maxOpenPositions 4`, `maxTradesPerDay 4`. Account `ALPACA_*_3` (auto-buy + manageExits hard-gated on keys3).
- Scanned by the daily `/api/scan` cron (setupKind `zone_swing_4h` fetches 4H bars per symbol). Premarket-prep intent (spec's 8am ET) is covered by the pre-open scan + the market-gated monitor.

## Known limitation
Coverage is **sparse** — the app's daily zone engine finds fewer zones than Farrukh's TradingView (pre-existing I1 gap), and the two-touch + both-sided + empty-space requirement is strict, so most days most names produce nothing. That is by design (selective), but retuning the zone math vs TradingView would widen how often a valid confirmed setup appears.

## NOT implemented from the spec / flagged
- Dedicated 8:00am-ET premarket scan cron (relies on the existing pre-open `/api/scan`; add a premarket cron if earlier candidate prep is wanted).
- Backtest engine coverage for `zone_4h` (measure live via shadow/scorecard).
