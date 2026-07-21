/**
 * Strategy profiles. A profile is a self-contained config that drives the scanner,
 * monitor, contract selection, caps, exits, and measurement for one strategy track.
 * Profiles are a fixed CODE registry (not user-CRUD); per-profile runtime toggles
 * (auto on/off, cap overrides) live in the `profile_settings` DB table.
 *
 * GUARDRAIL: profiles change WHAT is traded (universe, caps, contract shape), never
 * HOW it reaches the broker — every order still funnels through getBroker() (paper).
 */
import { type StrategyOptions, DEFAULT_STRATEGY_OPTIONS } from "./strategy";
import { type ZoneOptions, DEFAULT_ZONE_OPTIONS } from "./zones";

export type ProfileId = "sniper_swing" | "sbv2" | "sbv3" | "qqq_0dte" | "qqq_manual" | "zones_legacy" | "sb15m";

/** friday = nearest weekly Friday; twoToFourWeeks = ~21d; zeroDte = same-day;
 *  oneDay = next trading day (the QQQ 1-day-swing leg). */
export type ExpiryKind = "friday" | "twoToFourWeeks" | "zeroDte" | "oneDay";

/** Zone timeframes a profile reads. QQQ reads 15Min + 1H (0DTE intraday) + 4H
 *  (next-day 1-day swing); the per-tf expiryKind picks the contract for each. */
export interface ZoneTimeframe {
  timeframe: "daily" | "4h" | "1h" | "15min";
  opts: ZoneOptions;
  expiryKind?: ExpiryKind; // contract expiry for setups off this tf (defaults to the profile's)
}
const DAILY_TF: ZoneTimeframe = { timeframe: "daily", opts: DEFAULT_ZONE_OPTIONS }; // ATR50, disp 1.7
const FOURH_TF: ZoneTimeframe = { timeframe: "4h", opts: { ...DEFAULT_ZONE_OPTIONS, displacement: 1.3 } };
// QQQ intraday timeframes — PURELY same-day 0DTE (15Min + 1H). 4H was dropped: its
// historical hold is ~3.7 trading days (a multi-day swing), which doesn't fit 0DTE.
// maxWidthAtr caps zone thickness (0.6×ATR) so big candles don't produce range-wide
// zones — the tap edge is preserved, only the far edge pulls in.
const Q_15M: ZoneTimeframe = { timeframe: "15min", opts: { ...DEFAULT_ZONE_OPTIONS, displacement: 1.2, maxWidthAtr: 0.6 }, expiryKind: "zeroDte" };
const Q_1H: ZoneTimeframe = { timeframe: "1h", opts: { ...DEFAULT_ZONE_OPTIONS, displacement: 1.25, maxWidthAtr: 0.6 }, expiryKind: "zeroDte" };

export interface ContractConfig {
  expiryKind: ExpiryKind;
  /** Strike window around spot, in %. otmPct is how far OTM the window may reach. */
  otmPct: number;
  itmPct: number;
  priceFloor: number; // min acceptable ask ($/share)
  priceIdeal: number; // target ask (picks the contract closest to this)
  priceCap: number; // max acceptable ask
  liquiditySpread: number; // require bid >= liquiditySpread * ask
  // Require the quoted ASK SIZE to cover this many contracts (QQQ Manual buys a fixed
  // 5-lot and must not take a 1-lot quote). Only enforced when the feed reports a
  // size — an absent size is not treated as zero (it would block every trade).
  minAskSize?: number;
}

export interface ProfileCaps {
  perTradeBudget: number;
  maxContracts: number;
  maxOpenPositions: number; // the real live-path cap (concurrent open positions)
  // Farrukh 2026-07-17: "Limit all profiles to 3 trades max per day. Be patient for
  // the top setups." Enforced in executeProposal (protects auto AND manual
  // identically). Defaults to 3 when unset.
  maxTradesPerDay?: number;
  // Buy EXACTLY this many contracts or nothing (QQQ Manual, owner 2026-07-21: "buy
  // exactly 5 contracts … do not enter fewer than 5"). When set, execute rejects the
  // trade if the budget/cap can't fund the full lot instead of buying a smaller one.
  exactContracts?: number;
}

export interface ExitConfig {
  // "swing" (SniperBot): HOLD toward the first target over the multi-day horizon.
  //   Close ONLY on swing invalidation (underlying DAILY-closes back through the
  //   zone), a first-target hit, a bonus premium take-profit (targetPremium = ride
  //   to $2), or an expiry-salvage safety. NO intraday premium hard stop — a cheap
  //   option dipping intraday is HELD while the swing thesis is intact.
  // "intraday" (QQQ 0DTE): % TP/SL on premium + a same-day flatten before close.
  style: "swing" | "intraday";
  targetPremium?: number; // swing: upside take-profit — sell when the bid reaches this ($)
  // swing catastrophe floor — cut a basically-dead option ONLY near expiry (bid <=
  // catastropheFloor AND <= catastropheDays to expiry). Does NOT fire mid-swing.
  catastropheFloor?: number;
  catastropheDays?: number;
  // Optional MID-SWING premium stop (Farrukh 2026-07-16: SBv2 "wait to sell at
  // intended target or 50% stop"). Only read when set — SBv1 leaves it unset and
  // keeps its deliberate no-mid-swing-stop behavior.
  swingStopLoss?: number; // e.g. -0.5 => sell if premium falls 50% below entry
  // Optional swing PREMIUM take-profit as a fraction of entry (SBv2 2026-07-21:
  // 1.0 = sell everything at +100%). When set, the underlying-target exit is
  // DISABLED for the profile — the option premium is the exit, per spec.
  swingTakeProfit?: number;
  // Swing invalidation timeframe override (SBv2 2026-07-21): exit when a COMPLETED
  // 4-HOUR candle closes back inside the zone (instead of the daily close).
  invalidateOn4hClose?: boolean;
  takeProfit: number; // intraday only: +1.0 => +100% of premium
  stopLoss: number; // intraday only: -0.35 => -35% of premium
  sameDayExit: boolean; // 0DTE: flatten before the close
  // Intraday LADDER (QQQ Manual, Farrukh 2026-07-16): trim tranches at premium
  // milestones with a ratcheting stop, leave a runner for the next-level target.
  // Driven by the position_state table; only active when `ladder` is set.
  ladder?: {
    // GENERALIZED rungs (QQQ Manual, owner 2026-07-21). When set, these drive both the
    // trims and the stop ratchet, and the legacy trim1/trim2/breakeven fields below are
    // ignored. Ascending by atPct; stopTo omitted = leave the stop where it is.
    rungs?: { atPct: number; sellQty: number; stopTo?: number }[];
    plannedQty?: number; // full intended lot (rungs mode) — tranches scale off this
    holdTimeout?: boolean; // false disables the "no bounce within 2x expected hold" exit
    trim1Pct: number; // +0.5 => at +50% sell trim1Qty and ratchet stop to stopAfterTrim1
    trim1Qty: number; // contracts to sell at trim1 (of the ORIGINAL qty)
    stopAfterTrim1: number; // -0.1 => stop moves to -10% once trim1 fires
    breakevenPct: number; // 0.75 => past +75% the stop ratchets to breakeven (0%)
    trim2Pct: number; // +1.0 => at +100% sell trim2Qty more
    trim2Qty: number; // contracts to sell at trim2
    // runner (whatever remains) exits at the ratcheted stop, the next-level
    // target proximity (targetProximity $), or the 0DTE flatten.
    targetProximity: number; // $ distance from the underlying target that closes the runner.
    // <= 0 disables the underlying-target runner exit (SB15M — premium targets only).
    // Runner premium take-profit: sell the LAST contract at this gain (SB15M +75%).
    runnerTakeProfit?: number;
  };
  // Day-trade profiles (SB15M) flatten near the close EVERY day, even on weekly
  // contracts whose expiry isn't today (the 0DTE flatten only fires on expiry day).
  forceEodFlatten?: boolean;
  // Structural early exit (SB15M spec §12): close when a COMPLETED 15-minute candle
  // closes through the zone against the position — before the % stop if needed.
  invalidateOn15mClose?: boolean;
}

export interface ConfirmationConfig {
  enabled: boolean; // require an intraday rejection before firing
  timeframe: "5Min";
  minRelVolume: number; // volume vs rolling average multiple to count as confirmed
}

export interface Profile {
  id: ProfileId;
  label: string;
  description: string;
  active: boolean; // scanner still produces candidates (e.g. for shadow measurement)
  shelved?: boolean; // quarantined: the live monitor ignores it (no proposals/signals)
  // and it's excluded from the daily report. Kept scanned only for shadow history.
  // How the scanner builds setups: "tap" (default — stateless edge tap, SBv1),
  // "flip" (RETIRED 2026-07-21 — the old SBv2 daily-flip logic; no active profile
  // uses it, code kept for reference), or "breakout" (SBv2 2026-07-21 — completed
  // 4H body-close outside a daily zone into empty space, awaiting first retest).
  setupKind?: "tap" | "flip" | "breakout";
  // How the live monitor triggers an entry: "tap" (default — a boundary crossing /
  // confirmation candle), "flip_retest" (SBv2 — the FIRST live tap of the stored
  // boundary, re-validated at fire time), or "empty_space_tap" (SB 15M — the first
  // live touch of the zone boundary FACING price after an approach through empty
  // space; rejects a gap-through, a deep-inside tap, or a stale feed).
  entryKind?: "tap" | "flip_retest" | "empty_space_tap";
  strategy: StrategyOptions;
  zoneTimeframes: ZoneTimeframe[]; // zone timeframes to scan (QQQ = Daily + 4H)
  confirmation: ConfirmationConfig;
  requireClearRunway?: boolean; // white-space gate (default true). Off for intraday
  // 0DTE where zones sit close together and the confirmation candle is the real gate.
  watchPerTimeframe?: number; // how many nearest zones to watch per symbol/timeframe
  // (default 1). Single-ticker profiles (QQQ) watch several levels above+below price.
  minScore: number; // playbook/confidence gate
  // HARD floor on the reaction-DB hit rate (%). Below this = no trade, full stop. Set
  // for 0DTE where a ~50% coin flip loses to spread+theta regardless of direction.
  // Undefined = no extra floor (SBv1/SBv2 unchanged).
  minProbability?: number;
  // Require the selected contract's EXPECTED VALUE to be net-positive AFTER the
  // round-trip spread (+ theta over the hold). If nothing clears the cost, no trade.
  // On for 0DTE (spread is a big fraction of a $0.40 contract); off elsewhere.
  netContractCosts?: boolean;
  contract: ContractConfig;
  caps: ProfileCaps;
  exit: ExitConfig;
  autoDefault: boolean; // default auto-execute (overridable in profile_settings)
  baselineSymbol: string; // scorecard benchmark for this track
  // Levels are hand-entered by the owner (POST /api/manual-levels) instead of scanned.
  // The scanner + intraday re-scan skip these profiles entirely; candidates come only
  // from the manual input (which would otherwise be wiped by a re-scan).
  manualLevels?: boolean;
  // Day-trade entry window in ET minutes-since-midnight (SB15M: 9:45am-2:45pm).
  // Outside the window the monitor takes NO new entries for this profile.
  entryWindowEt?: { startMin: number; endMin: number };
}

// SniperBot Master — large/mega-cap institutional order-block swings, weekly options,
// confirmation-gated, far-OTM cheap contracts sized for the $500 paper account.
const SNIPER_SWING: Profile = {
  id: "sniper_swing",
  label: "SBv1",
  description: "Large/mega-cap order-block swing setups, confirmed, weekly options.",
  active: true,
  strategy: DEFAULT_STRATEGY_OPTIONS,
  zoneTimeframes: [DAILY_TF],
  confirmation: { enabled: true, timeframe: "5Min", minRelVolume: 1.3 },
  minScore: 75,
  contract: {
    expiryKind: "friday",
    otmPct: 12, // mega-cap $0.50-$1 weeklies sit well OTM; confirmation-gated conviction plays
    itmPct: 3,
    priceFloor: 0.4,
    priceIdeal: 0.75,
    priceCap: 1.0,
    liquiditySpread: 0.6,
  },
  caps: { perTradeBudget: 100, maxContracts: 1, maxOpenPositions: 10 }, // owner raised 3 -> 10 (2026-07-09)
  // Swing: hold to the DB target / swing invalidation. Farrukh 2026-07-16: "sell at
  // intended target prices rather than 100%" — the $2 premium ride was REMOVED, so the
  // exit is purely target-price-driven. Still NO mid-swing stop ("keep the stop" =
  // keep the existing safeties: invalidation + catastrophe floor + expiry salvage).
  exit: { style: "swing", catastropheFloor: 0.15, catastropheDays: 2, takeProfit: 1.0, stopLoss: -0.3, sameDayExit: false },
  autoDefault: true, // owner chose to auto-trade SniperBot on the paper account
  baselineSymbol: "SPY",
};

// SBv2 — 4H EMPTY-SPACE BREAKOUT & RETEST (Farrukh spec "message (4).txt",
// 2026-07-21 — COMPLETELY REPLACES the daily-flip logic). DAILY order blocks are
// the zones; the 4-HOUR chart does everything else: a COMPLETED 4h candle whose
// BODY closes outside a daily zone into valid empty space qualifies a breakout;
// the FIRST touch of the broken boundary is the entry — immediately, with NO
// confirmation candle, NO news vet, NO reaction-DB target, NO market/sector
// bias, NO score gate (all removed per spec). Session-loss + position caps stay
// as pure account-risk protections. Own paper account (ALPACA_*_3). PAPER-ONLY.
const SBV2: Profile = {
  id: "sbv2",
  label: "SBv2",
  description: "4H empty-space breakout of a daily order block + first-retest entry. Premium exits: +100% target / -25% stop.",
  active: true,
  setupKind: "breakout", // scanner: daily zones + completed-4h qualification (breakout.ts)
  entryKind: "flip_retest", // monitor fires on the FIRST live touch of the stored boundary
  strategy: DEFAULT_STRATEGY_OPTIONS, // zone opts: daily ATR-50, displacement 1.7 (spec-fixed)
  zoneTimeframes: [DAILY_TF], // DAILY generates ALL zones; 4h bars are fetched by the breakout scan
  // FALSE keeps the predict/EV machinery entirely out of the execute path — the
  // spec removes the reaction-DB from this profile (contract = plain price band).
  confirmation: { enabled: false, timeframe: "5Min", minRelVolume: 1.3 },
  requireClearRunway: false, // empty space is validated INSIDE the breakout detector
  watchPerTimeframe: 3, // a symbol may carry more than one qualified breakout awaiting retest
  minScore: 75, // display/shadow only — the live entry is mechanical (no score gate)
  contract: {
    // Spec: weekly options, premium $1.00-$1.50, ATM preferred / slightly OTM
    // acceptable, NO far-OTM lottery fallback — out-of-band means SKIP.
    expiryKind: "friday",
    otmPct: 4, // "slightly OTM acceptable" — and the execute-side OTM assert enforces it
    itmPct: 3,
    priceFloor: 1.0,
    priceIdeal: 1.2,
    priceCap: 1.5,
    liquiditySpread: 0.7, // tight two-sided market required
  },
  // qty stays 1 ("use the configured SBv2 contract quantity"); budget covers a $1.50 ask.
  caps: { perTradeBudget: 160, maxContracts: 1, maxOpenPositions: 10 },
  // PREMIUM exits only (spec): +100% take-profit on the option, -25% stop from the
  // actual fill, and a completed 4H candle closing back inside the daily zone
  // invalidates immediately. No reaction-DB / underlying targets. Catastrophe floor
  // + expiry salvage stay as inert safeties (the -25% stop fires long before them).
  exit: {
    style: "swing",
    swingStopLoss: -0.25,
    swingTakeProfit: 1.0,
    invalidateOn4hClose: true,
    catastropheFloor: 0.1,
    catastropheDays: 2,
    takeProfit: 1.0,
    stopLoss: -0.3,
    sameDayExit: false,
  },
  autoDefault: false, // owner's runtime toggle decides (profile_settings)
  baselineSymbol: "SPY",
};

// SBv3 — a SCRATCH CLONE of SBv2 (owner/Farrukh request 2026-07-16): Farrukh has an
// update to the flip strategy coming and wants it applied on a copy so SBv2 keeps
// running untouched — "we can scratch this if it doesn't work out". Starts byte-
// identical to SBv2 (same flip detection, entry, contracts, exits, universe) with its
// own measurement track. Auto OFF; trades ALPACA_*_5 when configured — without keys5
// its broker falls back to SBv1's default account, so auto-buy/manage are HARD-GATED
// on keys5 in monitor.ts (shadow-only until then). Apply Farrukh's changes HERE.
const SBV3: Profile = {
  ...SBV2,
  id: "sbv3",
  label: "SBv3",
  description: "SBv2 clone. Disabled per Farrukh 2026-07-16 — his update landed on the existing profiles instead.",
  shelved: true, // Farrukh: "Close/disable for now." No signals, no orders, no tab. Trivial to revive.
  autoDefault: false,
};

// QQQ 0DTE — single-ticker, same-day-expiry, intraday horizon. High variance / fast
// decay: its OWN tight caps and its OWN scorecard track. Never shares swing sizing.
// PAUSED 2026-07-15 (owner): shelved + hidden from the UI; its paper account
// (PA3NPEDZA11B, ALPACA_*_2) was handed to qqq_manual. Still scanned + shadow-
// measured for the head-to-head. Unpausing requires unshelving here AND deciding
// the account split (both QQQ profiles on one account can't both trade).
const QQQ_0DTE: Profile = {
  id: "qqq_0dte",
  label: "QQQ 0DTE",
  description: "QQQ same-day-expiry intraday setups. High variance, tight caps.",
  active: true, // still scanned for shadow measurement
  shelved: true, // NO live signals/orders — paused, account handed to qqq_manual
  strategy: DEFAULT_STRATEGY_OPTIONS,
  // Purely same-day 0DTE off 15Min + 1H. Daily (~5-day holds) and 4H (~3.7-day
  // holds) were both dropped — they're multi-day swings, not same-day trades.
  zoneTimeframes: [Q_15M, Q_1H],
  confirmation: { enabled: true, timeframe: "5Min", minRelVolume: 1.5 },
  requireClearRunway: false, // intraday zones sit close; the confirmation candle gates instead
  watchPerTimeframe: 4, // single ticker — watch the nearest 4 levels per timeframe, not 1
  minScore: 55, // 0DTE playbook score gate — the 80 (weekly) gate blocked all QQQ setups
  // 0DTE bleeds on coin-flip setups: a ~50% DB hit rate can't overcome spread + same-day
  // theta. HARD-floor the DB probability at 60 and require the contract's EV to clear the
  // round-trip cost before trading. If the DB says ~50%, the correct action is NO trade.
  minProbability: 60,
  netContractCosts: true,
  contract: {
    expiryKind: "zeroDte", // default; the 4H swing tf overrides to oneDay
    otmPct: 1.5, // 0DTE wants near-the-money to have any delta
    itmPct: 1,
    priceFloor: 0.4,
    priceIdeal: 0.8,
    priceCap: 1.5,
    liquiditySpread: 0.7,
  },
  caps: { perTradeBudget: 160, maxContracts: 1, maxOpenPositions: 2 },
  // Same-day 0DTE: premium TP/SL + a forced flatten before the close.
  exit: { style: "intraday", takeProfit: 0.6, stopLoss: -0.35, sameDayExit: true },
  autoDefault: false, // off until measured
  baselineSymbol: "QQQ",
};

// QQQ Manual (EXPERIMENTAL) — QQQ-only 0DTE off levels the owner hand-enters, run
// PURELY MECHANICALLY (owner 2026-07-21 simplification: "follow the owner-entered
// levels mechanically"). The level list and the approach direction ARE the decision:
//   ENTRY: from the 9:30 open, the FIRST eligible level actually touched (price
//     reaches/crosses it — no wide proximity band) triggers ONE trade for the session.
//     Direction comes from the prior COMPLETED 15-minute bar at touch time: price
//     coming DOWN from above into the level => CALLS; coming UP from below => PUTS.
//     NO confirmation candle, NO sniper engine, NO probability floor, NO reaction-DB
//     target requirement, NO catalyst veto, NO EV filter (all removed 2026-07-21).
//   CONTRACT: exactly 5 same-day contracts with an ask of $0.30-$0.35, two-sided
//     market, ask size >= 5. No substitution outside the band, never fewer than 5.
//   EXIT LADDER: -25% base stop; +50% sell 2 + stop -> breakeven; +75% sell 1 + stop
//     -> +25%; +100% sell the final 2; plus the end-of-day flatten.
// Trades the QQQ paper account (ALPACA_*_2) — qqq_0dte is shelved so the two can
// never trade the same account at once.
const QQQ_MANUAL: Profile = {
  id: "qqq_manual",
  label: "QQQ Manual",
  description: "QQQ 0DTE off owner-entered levels: first level touched, direction from the 15-min approach, 5-contract ladder.",
  active: true,
  manualLevels: true, // candidates come ONLY from /api/manual-levels — never scanned
  strategy: DEFAULT_STRATEGY_OPTIONS,
  zoneTimeframes: [], // nothing to scan; also keeps refreshIntradayScans away
  // MECHANICAL: no confirmation candle. This also routes execute.ts down the plain
  // price-band resolve path (no predict / no selectByEV) — the EV-after-cost filter
  // and the reaction-DB target are deliberately out of this profile now.
  confirmation: { enabled: false, timeframe: "5Min", minRelVolume: 1.5 },
  requireClearRunway: false, // manual levels sit wherever the owner draws them
  minScore: 0, // no score gate — the owner's level is the setup
  contract: {
    expiryKind: "zeroDte", // 0DTE ONLY
    otmPct: 3, // strike window only — the $0.30-0.35 ask band is the real selector
    itmPct: 1,
    priceFloor: 0.3, // HARD band: "ask must be between $0.30 and $0.35"
    priceIdeal: 0.32,
    priceCap: 0.35,
    liquiditySpread: 0.7, // real two-sided market
    minAskSize: 5, // enough size quoted to fill the whole 5-lot
  },
  // Exactly 5 contracts (5 × $0.35 = $175 worst case); ONE trade per session.
  caps: { perTradeBudget: 200, maxContracts: 5, exactContracts: 5, maxOpenPositions: 1, maxTradesPerDay: 1 },
  exit: {
    style: "intraday",
    takeProfit: 1.0, // fallback TP only if the ladder state is somehow unavailable
    stopLoss: -0.25, // base stop, from the ACTUAL average fill premium
    sameDayExit: true, // end-of-day safety flatten stays
    ladder: {
      // +50%: sell 2, stop -> breakeven. +75%: sell 1, stop -> +25% (so a fade back
      // to +25% after that trim sells everything left). +100%: sell the final 2.
      rungs: [
        { atPct: 0.5, sellQty: 2, stopTo: 0 },
        { atPct: 0.75, sellQty: 1, stopTo: 0.25 },
      ],
      plannedQty: 5,
      holdTimeout: false, // no-bounce time-out REMOVED (owner 2026-07-21)
      targetProximity: 0, // next-level target exit REMOVED — 0 disables it
      runnerTakeProfit: 1.0, // +100%: sell everything still open (the final 2)
      // Legacy fields unused in rungs mode; kept to satisfy the shared shape.
      trim1Pct: 0.5,
      trim1Qty: 2,
      stopAfterTrim1: 0,
      breakevenPct: 0.5,
      trim2Pct: 0.75,
      trim2Qty: 1,
    },
  },
  autoDefault: false, // experimental — owner enables via the level-editor toggle
  baselineSymbol: "QQQ",
  // Monitoring starts at the 9:30 open. The upper bound keeps a fresh entry from
  // landing inside the end-of-day flatten window (which fires ~25 min before close).
  entryWindowEt: { startMin: 9 * 60 + 30, endMin: 15 * 60 + 25 },
};

// 15M EMPTY-SPACE ZONE-TAP DAY TRADER (Farrukh spec 2026-07-21, "message (5).txt")
// — REPLACES the previous SB15M confirmation-candle strategy on the same profile id.
//
// The chart is the 15-MINUTE chart; "4 hours" is ONLY the indicator's HTF-for-OBs
// input, which is exactly what zoneTimeframes: [FOURH_TF] means here (order blocks
// computed off 4H data, ATR 50, displacement 1.3) — we never "switch to the 4H
// chart", never read daily/weekly/5m/1m zones, and never mix another profile's zones.
//
// Setup: price trading in EMPTY SPACE (no zone covering it) with a zone above or
// below. Entry is the FIRST TOUCH of the boundary FACING price — price falling from
// empty space into the TOP of a zone below => CALLS; price rallying from empty space
// into the BOTTOM of a zone above => PUTS. The tap IS the trigger: no confirmation
// candle, no second retest, no 5m/1m confirmation, no market-structure break, no
// SPY/QQQ confirmation, no model approval, no score minimum. One weekly contract at
// ~$1.00-2.00, ATM/slightly ITM. Stop -20% off the ACTUAL fill; at +40% the stop
// moves to breakeven (NOT a profit-take — keep holding); sell the whole contract at
// +100%; flat before the close, every day. Own paper account via ALPACA_*_4
// (auto-buy + exits HARD-GATED on those keys). Auto OFF — paper-measure first.
const SB15M: Profile = {
  id: "sb15m",
  label: "SB 15M",
  description: "15-min empty-space zone-tap day trader: first touch of the facing 4H-OB boundary, one $1-2 contract, -20% / breakeven at +40% / +100%.",
  active: true,
  entryKind: "empty_space_tap", // monitor fires on the boundary TAP itself (no candle)
  strategy: DEFAULT_STRATEGY_OPTIONS,
  zoneTimeframes: [FOURH_TF], // HTF-for-OBs = 4 hours, ATR 50, displacement 1.3 (spec-fixed)
  // No confirmation candle (spec: "The level tap itself is the primary trigger").
  // This also keeps the predict/EV machinery out of the execute path — the contract
  // is chosen off the price band, not a model.
  confirmation: { enabled: false, timeframe: "5Min", minRelVolume: 1.3 },
  requireClearRunway: true, // "empty space" IS the setup
  watchPerTimeframe: 2,
  minScore: 0, // spec: no setup-score minimum
  contract: {
    // "Liquid WEEKLY contract, at-the-money or slightly in-the-money, responsive to
    // the stock; avoid far OTM, wide spreads, thin volume. Premium ~$1.00-$2.00."
    expiryKind: "friday",
    otmPct: 1.5, // at most a strike OTM — far-OTM is explicitly excluded
    itmPct: 5, // slightly ITM is PREFERRED, so the window reaches further ITM than OTM
    priceFloor: 1.0, // "minimum preferred price ~$1.00"
    priceIdeal: 1.4, // mid-band; ITM-ish contracts land here on liquid mega-caps
    priceCap: 2.0, // "maximum preferred price ~$2.00" — nothing materially above
    liquiditySpread: 0.75, // tight two-sided market ("spread unreasonably wide" => no trade)
  },
  // ONE contract (spec: "Enter one option contract", never average down, never add).
  caps: { perTradeBudget: 210, maxContracts: 1, exactContracts: 1, maxOpenPositions: 2 },
  // Spec's complete position-management sequence: stop -20% off the ACTUAL fill; at
  // +40% move the stop to breakeven and KEEP HOLDING (explicitly not a profit-take);
  // sell the whole contract at +100%; exit at breakeven if it reverses after that;
  // close before the session ends if neither fired. Nothing else exits this trade.
  exit: {
    style: "intraday",
    takeProfit: 1.0,
    stopLoss: -0.2, // original stop, 20% below the fill
    sameDayExit: true,
    forceEodFlatten: true, // day trades on WEEKLY contracts — flatten EVERY session
    ladder: {
      // sellQty 0 = a stop-ratchet-only rung: at +40% the stop goes to breakeven and
      // the contract is held. The +100% exit is runnerTakeProfit (sell everything).
      rungs: [{ atPct: 0.4, sellQty: 0, stopTo: 0 }],
      plannedQty: 1,
      holdTimeout: false, // no time-based exit in the spec
      targetProximity: 0, // no underlying-target exit in the spec
      runnerTakeProfit: 1.0, // "Sell the entire contract at a 100% gain"
      // Legacy fields unused in rungs mode; kept to satisfy the shared shape.
      trim1Pct: 0.4,
      trim1Qty: 0,
      stopAfterTrim1: 0,
      breakevenPct: 0.4,
      trim2Pct: 1.0,
      trim2Qty: 1,
    },
  },
  autoDefault: false, // paper-measure + review before enabling
  baselineSymbol: "SPY",
  // "Allow the opening price action to establish itself" … "avoid new entries late in
  // the afternoon when there is insufficient time to reach the target."
  entryWindowEt: { startMin: 9 * 60 + 45, endMin: 14 * 60 + 45 }, // 9:45am-2:45pm ET
};

// Zones legacy — the previous cheap-universe tap-only strategy. SHELVED: no new
// auto-trades. Kept for its shadow history + ongoing comparison only.
const ZONES_LEGACY: Profile = {
  id: "zones_legacy",
  label: "Zones (legacy)",
  description: "Previous cheap-universe zone strategy. Shelved — shadow-only.",
  active: true, // still scanned + shadowed for comparison
  shelved: true, // quarantined from the live monitor + daily report (no new signals)
  strategy: DEFAULT_STRATEGY_OPTIONS,
  zoneTimeframes: [DAILY_TF],
  confirmation: { enabled: false, timeframe: "5Min", minRelVolume: 1 },
  minScore: 70,
  contract: {
    expiryKind: "friday",
    otmPct: 8,
    itmPct: 3,
    priceFloor: 0.35,
    priceIdeal: 0.5,
    priceCap: 1.0,
    liquiditySpread: 0.7,
  },
  caps: { perTradeBudget: 100, maxContracts: 1, maxOpenPositions: 3 },
  exit: { style: "swing", targetPremium: 2.0, takeProfit: 1.0, stopLoss: -0.3, sameDayExit: false },
  autoDefault: false, // SHELVED — no new auto-trades
  baselineSymbol: "SPY",
};

export const PROFILES: Record<ProfileId, Profile> = {
  sniper_swing: SNIPER_SWING,
  sbv2: SBV2,
  sbv3: SBV3,
  qqq_0dte: QQQ_0DTE,
  qqq_manual: QQQ_MANUAL,
  zones_legacy: ZONES_LEGACY,
  sb15m: SB15M,
};

export const PROFILE_IDS: ProfileId[] = ["sniper_swing", "sbv2", "sbv3", "qqq_0dte", "qqq_manual", "zones_legacy", "sb15m"];

export function getProfile(id: string | null | undefined): Profile {
  return PROFILES[(id ?? "sniper_swing") as ProfileId] ?? SNIPER_SWING;
}

export function activeProfiles(): Profile[] {
  return PROFILE_IDS.map((id) => PROFILES[id]).filter((p) => p.active);
}

/** The contract config for a setup off a given timeframe — applies that
 *  timeframe's expiryKind override (QQQ: 15m/1h → 0DTE, 4h → next-day swing). */
export function contractForTimeframe(profile: Profile, timeframe: string | null | undefined): ContractConfig {
  const ztf = profile.zoneTimeframes.find((z) => z.timeframe === timeframe);
  return ztf?.expiryKind ? { ...profile.contract, expiryKind: ztf.expiryKind } : profile.contract;
}
