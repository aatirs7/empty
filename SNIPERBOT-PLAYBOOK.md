# SniperBot AI Playbook Classifier + Swing Alert Logic

## Goal

The AI should classify each SniperBot setup into a repeatable playbook, then decide whether to alert based on the quality of the setup and 1–2 week swing potential.

## Time horizon

This is NOT a same-day scalp system.
Each alert should be analyzed as a 5–10 trading day swing idea.

## Core rule

SniperBot zones are mainly for entries.
Targets should come from daily/weekly highs, lows, structure, and historical reactions.

## Playbook Types

**1. Breakout Retest — CALLS**
Price closed above a SniperBot zone on the daily chart.
Next session, wait for price to pull back and tap the top/inside of that zone from above.
If price holds/rejects upward, alert CALLS.

**2. Breakdown Retest — PUTS**
Price closed below a SniperBot zone on the daily chart.
Next session, wait for price to push back up and tap the bottom/inside of that zone from below.
If price rejects downward, alert PUTS.

**3. Resistance Rejection — PUTS**
Price is below a SniperBot zone.
Price moves up into the zone from underneath.
If price taps/wicks the zone and rejects, alert PUTS.

**4. Support Bounce — CALLS**
Price is above a SniperBot zone.
Price pulls down into the zone from above.
If price taps/wicks the zone and bounces, alert CALLS.

**5. Open Inside Zone**
If price opens inside a zone, do not alert immediately.
Wait for the first boundary tap:
- Tap top boundary first = PUTS
- Tap bottom boundary first = CALLS

**6. Failed Breakout — PUTS**
Price previously closed above a zone but then loses it and closes back below.
If price retests the lost zone from below and rejects, alert PUTS.

**7. Failed Breakdown — CALLS**
Price previously closed below a zone but then reclaims it and closes back above.
If price retests the reclaimed zone from above and holds, alert CALLS.

## Alert Requirements

Only alert when:
- Price actually taps or wicks into the active zone/level.
- The setup matches one of the playbook types.
- There is enough white space in the trade direction.
- The setup has 1–2 week swing potential.
- Risk/reward is acceptable based on daily structure.

Do NOT alert when:
- Price is only near a zone.
- Price is stuck in the middle of a zone.
- Price is trapped between two nearby levels.
- No clear playbook is present.
- There is no reasonable 5–10 trading day target.

## Target Logic

For CALLS:
Use daily/weekly swing highs, prior breakout highs, and historical reaction distance.

For PUTS:
Use daily/weekly swing lows, prior breakdown lows, and historical reaction distance.

Safe target:
High-probability target expected within 5–10 trading days.

Extended target:
Larger swing target possible within 1–2 weeks if momentum continues.

Do not use SniperBot zones as the main target tool.
Zones are mainly for entry confirmation.

## Historical Reaction Check

Before alerting, analyze prior reactions from the same or similar zone:

- How many times did price react from this level?
- Did the reaction respect the level or chop through it?
- Average move after reaction
- Maximum move after reaction
- Average duration in trading days
- Whether the move aligned with the same playbook type

Example:
If this is a Breakout Retest, compare it to prior breakout retests, not random taps.

## Scoring

Score each setup from 0–100.

Main factors:
- Playbook clarity
- Clean zone tap
- Daily close confirmation
- White space
- Historical reaction strength
- 1–2 week target potential
- Market structure
- Risk/reward

Suggested minimum alert threshold:
Only alert if score is 80+.

## Output Format

```
CALLS: [TICKER] — [Playbook Name]
Entry: Price tapped SniperBot support zone from above.
Safe target: [price], based on nearest daily swing high.
Extended target: [price], based on larger daily/weekly swing high.
Timeframe: 5–10 trading days.
Confidence: [score]/100.
Reason: [short explanation].
```

```
PUTS: [TICKER] — [Playbook Name]
Entry: Price tapped SniperBot resistance zone from below.
Safe target: [price], based on nearest daily swing low.
Extended target: [price], based on larger daily/weekly swing low.
Timeframe: 5–10 trading days.
Confidence: [score]/100.
Reason: [short explanation].
```
