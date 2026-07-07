# Vega — Strategy Reference (STRATEGY.md)

Persistent strategy context for Claude Code. Read alongside `CLAUDE.md` every session. This describes the zone-based trading strategy Vega implements. If code and this doc disagree, stop and flag it.

## The one-line version

Find a stock approaching a daily order-block zone through open space, and buy the rejection off it: falling into a zone means calls (expect a bounce up), rising into a zone means puts (expect a rejection down).

## Where the strategy came from

Ported from a TradingView indicator ("HTF OB Tap Signals — Real-Time", Pine v6) plus the discretionary entry rules of the person who trades it (Farrukh). The indicator is a supply/demand order-block detector. Vega replicates its zone math in code (no TradingView, no chart-image reading) and adds the entry/exit rules below.

## The zones (order blocks)

Computed in code from daily bars (`src/lib/zones.ts`). Settings to match his: daily timeframe, ATR length 50, displacement 1.7x.

- Demand zone (bullish, "green"): a bearish daily candle immediately followed by a bullish candle whose body `abs(close - open)` exceeds `1.7 x ATR50`. Zone bounds = the prior bearish candle's low (bottom) to its open (top). Demand zones sit below price and act as support.
- Supply zone (bearish, "red"): a bullish daily candle followed by a bearish displacement candle over the same threshold. Zone bounds = the prior bullish candle's open (bottom) to its high (top). Supply zones sit above price and act as resistance.
- Keep up to 30 zones per side, FIFO. First-touch-only per zone.

## The trade (rejection / fade the approach)

The zone is a barrier price is expected to bounce off. You trade the OPPOSITE of the approach:

- Price moving DOWN into a zone and tapping it => CALLS (expecting a bounce up off the zone).
- Price moving UP into a zone and tapping it => PUTS (expecting a rejection down off the zone).

This normally coincides with demand zones (below) giving calls and supply zones (above) giving puts. The approach direction is the determinant.

## Required filter: white space

Only take a setup when the stock approaches the zone through open space, meaning no opposing zones sit in the immediate path, so the tapped zone is the first real barrier price meets. This is a hard filter, not a preference. No clear runway, no trade.

## Entry and exit

- Entry: the tap into the zone edge, in the direction set by the rejection rule above.
- Exit (for later auto-manage, not built yet): ride the rejection wave; exit when a daily candle closes back through the zone against the position (the rejection failed). Structural exit, no fixed profit target.

## The critical architecture caveat

The original indicator alerts LIVE the moment price taps a zone intraday. Vega scans ONCE pre-market off daily bars. These do not line up. Vega approximates the tap in daily terms: a setup is valid when the prior daily candle wicked into the zone, or when the current pre-market price sits inside the zone at scan time. This is a once-a-day approximation of a live intraday trigger, not the same thing. Whether the daily-granularity version is good enough is an open question the paper month is meant to answer. Do not silently pretend it is equivalent.

## How it fits Vega

- The zone engine is the highest-weight signal fed to the Brain, alongside news and computed indicators.
- Proposals from this path are tagged `variant='news_plus_zones'` so the scorecard can compare them against news-only.
- All guardrails still apply: paper only, human approves every trade by default, no auto-execute off this signal, and every number (zone bounds, distances, risk) is code-computed, never model-generated.

## Discipline note

This is an unproven hypothesis until the paper scorecard says otherwise. A live winning trade in progress is not proof. The whole reason to port it into code and paper trade it is to learn whether the mechanical rules have an edge, or whether the edge lived in human judgment about which setups to skip. Prove it on paper before any real money.
