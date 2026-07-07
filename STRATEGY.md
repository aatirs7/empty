# Vega — Strategy Reference (STRATEGY.md)

FINAL LOCKED VERSION for the paper month. This consolidates every confirmed rule from the strategy owner (Farrukh) and supersedes all earlier scattered rule notes. Do not change any rule in this file during the paper month without deliberately un-freezing the config and restarting the measurement. If code and this doc disagree, stop and flag it.

## One-line

Compute daily order-block zones across a stock's full history. Every zone's top and bottom are permanent support/resistance levels. When price taps a zone edge, trade the bounce: coming down into an edge means calls, rising up into an edge means puts. Enter at whichever edge is touched first.

## Zone detection (confirmed correct, unchanged)

Ported from the Pine indicator "HTF OB Tap Signals". Settings: daily timeframe, ATR(50) with Wilder/RMA smoothing (matches TradingView ta.atr), displacement 1.7x.

- Compute per daily bar: upImpulse = C>O and |C-O| > 1.7*ATR50; downImpulse = C<O and |C-O| > 1.7*ATR50.
- Zone forms when a displacement candle follows an opposite-color candle:
  - Bullish displacement after a bearish candle: zone = prior bearish candle's [low, open].
  - Bearish displacement after a bullish candle: zone = prior bullish candle's [open, high].
- Detection math and levels are verified against the owner's TradingView (bounds within ~50 cents, which is the IEX vs full-exchange data-feed difference, harmless for the paper month).
- Pull FULL available daily history per symbol (not a trailing window). Keep all zones for all time; mark tapped ones as used but never drop historical zones. Old untapped zones persist and remain tradeable.

## Zones are just support/resistance (no demand/supply distinction)

Do not label zones demand or supply. The top and bottom of every zone are both major support/resistance levels, full stop. Zone type does not drive anything. Direction is set entirely by which side price approaches the tapped edge from.

## Direction and trigger

- Direction is a function of approach side at the moment of the tap:
  - Price coming DOWN into a zone edge (approaching from above) => CALLS (expect a bounce up).
  - Price rising UP into a zone edge (approaching from below) => PUTS (expect a rejection down).
- Trigger: each session, fire at whichever zone edge (top or bottom) price touches FIRST. Do not pre-compute the approach. The first edge touched, plus which side price came from, fully determines the trade.

## The flip (falls out of the approach-side rule)

If a setup's expected rejection fails, meaning a daily candle closes THROUGH the zone instead of rejecting off it, the next session's trade flips to the opposite direction. This does not need special-case state: once price closes through, it is now on the other side of the zone, so the same approach-side rule automatically produces the flipped direction on the next tap.

Owner's example, worked through the rule: price tapped up into a zone from below (puts), but the day closed ABOVE the zone rather than rejecting. Price is now above the zone. Next session, price coming back down taps the top edge from above, which by the approach-side rule is CALLS. The flip is automatic.

Implementation note: prefer the stateless approach (direction = which side price is on relative to the tapped edge) over tracking a normal/flipped flag. Both must produce identical trades; the stateless version is simpler and less error-prone. Still expose trigger_edge: 'first_touch' and the resolved direction in the setup for auditability.

## White-space filter (hard gate)

Only take a setup when price approaches the zone through open space, with no opposing zone sitting between recent price and the tapped zone in the direction of travel, so the tapped zone is the first real barrier price meets. No clear runway, no setup. This remains a hard gate as last confirmed.

## Entry and exit

- Entry: the first zone edge touched that session, direction per the approach-side rule.
- Exit (structural, for auto-manage later; not built for the paper month): close when a daily candle closes back THROUGH the zone against the position. No fixed profit target. Note this is the same event as the flip trigger: a close-through both exits the current position and sets up the opposite trade next session.

## Daily-scan approximation

Vega scans once pre-market off daily bars, not live intraday. A setup is valid when the prior daily candle wicked the zone or current pre-market price sits in the zone. The owner confirmed that entering "a couple cents before" the exact tap is acceptable, so this approximation is fine for the paper month. Tag every setup tap_granularity='daily_scan'. Live intraday tap detection is a later, gated phase (I6).

## Universe

Nightly scanner runs across ~200 high-cap US names. Must include HOOD, TSLA, NVDA, AMZN. Owner's floor was 50 to 100 high-cap names; 200 satisfies it.

## Guardrails (unchanged)

Paper only for the paper month; no live path. Human approves every trade by default; no auto-execute off zone setups. All numbers (zone bounds, edges, distances, ATR, risk) are code-computed, never model-generated. Zones are computed in zones.ts, never read from a chart image or TradingView.

## Frozen for the paper month

This rule set is complete and confirmed by the owner. For the paper month: freeze this config and the universe, keep auto-buy and auto-manage OFF, approvals ON, and log every proposal (taken or skipped) plus its shadow outcome. The scorecard measures whether the strategy beats the SPY baseline and whether it has any real edge. Any new rule that surfaces mid-month gets parked, not merged, until the month completes, because changing rules mid-measurement invalidates the data.
