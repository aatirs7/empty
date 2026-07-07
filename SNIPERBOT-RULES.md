# SniperBot Chart-Reading + Alert Rules

## Definitions

- **Zone** = SniperBot order block area.
- **Top of zone** = upper boundary.
- **Bottom of zone** = lower boundary.
- **White space** = area with no SniperBot zone.
- A valid alert happens only when price taps/wicks into a zone boundary or zone level.
- Do not alert just because price is near a zone.

## Main Rule

Read the daily chart first.

The daily close tells you the active setup:

1. **If price closed BELOW a zone:**
   - Treat that zone as resistance.
   - During market hours, wait for price to push upward into/toward that zone.
   - If price wicks/taps the bottom of the zone or enters the zone from below, alert PUTS.
   - Alert message: `PUTS: [TICKER] tapped resistance zone.`

2. **If price closed ABOVE a zone:**
   - Treat that zone as support.
   - During market hours, wait for price to pull back downward into/toward that zone.
   - If price wicks/taps the top of the zone or enters the zone from above, alert CALLS.
   - Alert message: `CALLS: [TICKER] tapped support zone.`

3. **If price opened INSIDE a zone:**
   - Do not choose direction immediately.
   - Wait for price to hit a zone boundary first.
   - If price moves up first and taps the top boundary of the zone, alert PUTS.
   - If price moves down first and taps the bottom boundary of the zone, alert CALLS.
   - The first boundary tapped after open decides the alert direction.

4. **If price is below a zone and taps upward into it:**
   - This is bearish rejection logic.
   - Alert PUTS.

5. **If price is above a zone and taps downward into it:**
   - This is bullish support logic.
   - Alert CALLS.

## Alert Conditions

**For PUTS:**
- Price must approach the zone from below OR open inside the zone and tap the upper boundary.
- The zone must be acting as resistance.
- Price must wick/tap into the level.
- Prefer rejection, meaning price fails to stay above the zone or pulls back after tap.
- There should be white space below for downside continuation.

**For CALLS:**
- Price must approach the zone from above OR open inside the zone and tap the lower boundary.
- The zone must be acting as support.
- Price must wick/tap into the level.
- Prefer rejection/hold, meaning price fails to break below the zone or bounces after tap.
- There should be white space above for upside continuation.

## Do Not Alert When

- Price is only near a zone but has not tapped/wicked into it.
- Price is in the middle of a zone and has not touched top or bottom boundary.
- Price is trapped between two close zones with no white space.
- The direction is unclear.
- The candle only chops inside the zone without touching a meaningful boundary.
- Price already tapped the same level and the alert was already sent.

## Open Inside Zone Logic

If market opens inside a zone:
- Mark the zone top and zone bottom.
- Watch which side gets tapped first.
- Tap top first = PUTS alert.
- Tap bottom first = CALLS alert.
- Do not alert both unless price later fully leaves the zone and creates a new setup.

## Daily Break/Close Logic

If the prior daily candle closed above a zone:
- Bias is CALLS.
- Wait for a retest/tap of the broken zone from above.
- Alert calls only when price taps that zone.

If the prior daily candle closed below a zone:
- Bias is PUTS.
- Wait for a retest/tap of the broken zone from below.
- Alert puts only when price taps that zone.

If the prior daily candle rejected a zone from below:
- Bias is PUTS.
- Next session, if price taps that zone again from below, alert puts.

If the prior daily candle rejected a zone from above:
- Bias is CALLS.
- Next session, if price taps that zone again from above, alert calls.

## White Space Rule

Before sending an alert:
- For calls, check that there is no nearby zone directly above.
- For puts, check that there is no nearby zone directly below.
- The cleaner the white space, the better the alert.

## Alert Output Format

Use simple alerts:

```
CALLS: [TICKER] tapped support zone
PUTS: [TICKER] tapped resistance zone
```

Optional extra info:
- Zone price
- Direction
- White space target
- Reason

Example:

```
PUTS: ON tapped resistance zone. Price approached from below and wicked into SniperBot zone.
CALLS: NVDA tapped support zone. Price pulled back from above into broken zone and held.
```
