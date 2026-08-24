# Zone Swing — Daily Empty-Space Zone-to-Zone Swing

Profile id: `zone_swing`. Owner spec: `Downloads/zone-zoneswing.txt` (2026-08-24). Auto **OFF** (shadow) until the owner enables it and adds `ALPACA_*_6`.

## Idea
Trade a large underlying move from one Daily zone, through clean **empty space**, to the **next opposing Daily zone**. The contract is chosen so it is **ITM at the target**, and the exit is driven by the **underlying's structure**, never an option-percentage stop. (This is the VegaMade insight — a real-delta contract + structural exit — applied to a zone-to-zone move.)

## Zones (exact, non-negotiable)
- SniperBot-by-Nitosphere **Daily (1D)** order blocks, **HTF ATR length 50**, **displacement 1.7× ATR** — the same `computeZones` math the rest of the app uses.
- `firstTouchOnly: false` for this profile only: every standing Daily zone is a level (a zone tapped once is still the wall the next move rides to), not just untouched ones.
- No 4H/1H/other-timeframe zones, no AI-invented support/resistance. Entry, target, and invalidation all reference these Daily zones.

## Setup (`buildZoneSwingSetups`, `src/lib/strategy.ts`)
Price must sit in clean empty space (not inside a zone), with a zone on the trade side and the next opposing zone as the target:
- **Bullish (CALL):** nearest zone **below** price = support. Entry = that zone's **TOP** edge (facing the empty space). Target = **bottom** edge of the nearest zone **above**.
- **Bearish (PUT):** nearest zone **above** price = resistance. Entry = that zone's **BOTTOM** edge. Target = **top** edge of the nearest zone **below**.
- **Minimum move filter:** `abs(target − entry) ≥ $10` of underlying, else NO TRADE.
- Empty space is guaranteed by construction (nearest-below/nearest-above neighbours with nothing between). `predictedTarget` = the next opposing zone edge, persisted on the candidate/proposal.

## Entry (`entryKind: "zone_swing_tap"`, `src/lib/monitor.ts`)
- Live intraday **tap** of the facing edge (a two-tick `tapCrossing`): CALL when price falls to touch the zone top from above; PUT when price rises to touch the zone bottom from below.
- No daily-close wait, no confirmation candle, no score/sniper engine (mechanical). Once per candidate per day (`tappedSet` dedup).
- execute's live wrong-way zone check still applies (skip a setup whose stock has since broken through the zone the wrong way).

## Contract (`resolveContract`, `src/lib/resolve.ts`)
- **Following week's Friday** (`expiryKind: "friday"` + `minDays: 7`).
- **Strike anchored to the target** (`contract.strikeFromTarget: 2.5` + execute passes `targetPrice`): call strike ≈ target − $2.5, put strike ≈ target + $2.5 — the nearest liquid strike, so the contract is **ITM at the target** (high delta, tracks the stock). NOT a spot-relative premium band, NOT a cheap OTM lottery.
- 1 contract, `perTradeBudget 900` (a comfortably-ITM mega-cap weekly can cost several dollars).

## Exit (swing, underlying-driven — `manageExits`)
- **Take profit:** the **underlying reaches the target** (next opposing zone edge, `predictedTarget`).
- **Invalidation** (`invalidateOnDailyReenter: true`): the entry-day daily candle **closes back inside** the entry zone (past the tapped edge — call below the top / put above the bottom), OR the **next session opens** back inside it.
- **No option-percentage stop.** Intraday movement back into the zone is held through. Only a near-expiry catastrophe floor / expiry salvage acts as a time backstop.

## Caps / account
- `maxOpenPositions 3`, `maxTradesPerDay 3`. Own paper account via `ALPACA_*_6` (auto-buy AND manageExits hard-gated on keys6; without them it's shadow/read-only and never trades another profile's account).

## Enable
1. Add `ALPACA_API_KEY_ID6` / `ALPACA_API_SECRET_KEY6` on Vercel prod (a fresh paper account).
2. `npx tsx scripts/profile-auto.ts zone_swing on`.
3. The daily `/api/scan` already scans it (setupKind `zone_swing`); the per-minute monitor trades the taps.

## Known limitation
The app's daily zone detection is **sparser** than Farrukh's TradingView (a pre-existing calibration gap, see I1 notes) — so some names (e.g. HOOD in the owner's screenshot) won't reproduce every zone the chart draws, and the profile is selective (≈36/129 names produce a both-sided ≥$10 setup on a given day). Retuning the zone math vs TradingView would widen coverage; the setup/entry/exit logic here is independent of that.

## NOT implemented from the spec / flagged
- Backtest engine coverage for `zone_swing` (the Stage-1/2 engines don't yet build this setup) — measure live via shadow/scorecard for now.
