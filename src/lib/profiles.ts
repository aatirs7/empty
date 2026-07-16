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

export type ProfileId = "sniper_swing" | "sbv2" | "sbv3" | "qqq_0dte" | "qqq_manual" | "zones_legacy";

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
}

export interface ProfileCaps {
  perTradeBudget: number;
  maxContracts: number;
  maxOpenPositions: number; // the real live-path cap (concurrent open positions)
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
  takeProfit: number; // intraday only: +1.0 => +100% of premium
  stopLoss: number; // intraday only: -0.35 => -35% of premium
  sameDayExit: boolean; // 0DTE: flatten before the close
  // Intraday LADDER (QQQ Manual, Farrukh 2026-07-16): trim tranches at premium
  // milestones with a ratcheting stop, leave a runner for the next-level target.
  // Driven by the position_state table; only active when `ladder` is set.
  ladder?: {
    trim1Pct: number; // +0.5 => at +50% sell trim1Qty and ratchet stop to stopAfterTrim1
    trim1Qty: number; // contracts to sell at trim1 (of the ORIGINAL qty)
    stopAfterTrim1: number; // -0.1 => stop moves to -10% once trim1 fires
    breakevenPct: number; // 0.75 => past +75% the stop ratchets to breakeven (0%)
    trim2Pct: number; // +1.0 => at +100% sell trim2Qty more
    trim2Qty: number; // contracts to sell at trim2
    // runner (whatever remains) exits at the ratcheted stop, the next-level
    // target proximity (targetProximity $), or the 0DTE flatten.
    targetProximity: number; // $ distance from the underlying target that closes the runner
  };
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
  // How the scanner builds setups: "tap" (default — stateless edge tap, SBv1) or
  // "flip" (SBv2 — a daily order-block that broke + accepted, awaiting first retest).
  setupKind?: "tap" | "flip";
  // How the live monitor triggers an entry: "tap" (default — a boundary crossing /
  // confirmation candle) or "flip_retest" (SBv2 — the FIRST live tap of the flipped
  // boundary, re-validated against the daily flip state at fire time).
  entryKind?: "tap" | "flip_retest";
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

// SBv2 — SniperBot v2 (Farrukh's LOGIC RESET, sniperbot-daily-swing-v2.md). A
// genuinely DIFFERENT setup from SBv1: daily order-block FLIP + FIRST retest, run in
// PARALLEL for a head-to-head comparison. A daily zone that price breaks AND accepts
// through (daily close / overnight gap+hold) flips (resistance→support, support→
// resistance); the FIRST live tap of the flipped boundary is the entry. Same universe
// as SBv1, its OWN paper account (ALPACA_*_3), its OWN log/P&L/shadow/scorecard track.
// Auto OFF until the owner enables it. PAPER-ONLY.
const SBV2: Profile = {
  id: "sbv2",
  label: "SBv2",
  description: "Daily order-block FLIP + first retest, 1-2 day swing. Parallel to SBv1 for comparison.",
  active: true,
  setupKind: "flip", // scanner builds flip setups (broke + accepted, awaiting first retest)
  entryKind: "flip_retest", // monitor fires on the FIRST live tap of the flipped boundary
  strategy: DEFAULT_STRATEGY_OPTIONS,
  zoneTimeframes: [DAILY_TF], // DAILY ONLY qualifies a flip (1D / ATR50 / disp 1.7)
  confirmation: { enabled: true, timeframe: "5Min", minRelVolume: 1.3 },
  requireClearRunway: false, // empty-space read is informational; flip validity + first-retest gate instead
  watchPerTimeframe: 3, // a symbol may carry more than one flipped zone awaiting a retest
  minScore: 75, // retained for display/shadow only — the live flip_retest entry is MECHANICAL (no score gate)
  contract: {
    // Farrukh 2026-07-16: "Enter a contract priced around $0.50-0.75, just get one.
    // Strike isn't important — looking for a fast hard move that causes a premium pump
    // across all contracts." One mid-priced contract; reachability gate dropped in
    // execute.ts (requireTargetReachable=false) so expensive names trade again.
    expiryKind: "friday", // nearest weekly ≥ the predicted 1-3 day hold (selectByEV horizon-matches)
    otmPct: 25, // wide strike window — strike choice is deliberately unimportant
    itmPct: 4,
    priceFloor: 0.45,
    priceIdeal: 0.6,
    priceCap: 0.8, // "around $0.50-0.75" with a little slack on expensive names
    liquiditySpread: 0.5, // (unused on the selectByEV path SBv2 takes; kept for consistency)
  },
  caps: { perTradeBudget: 100, maxContracts: 1, maxOpenPositions: 10 }, // "just get one"
  // Swing exit: sell when the UNDERLYING reaches the reaction-DB target (predict.targetMain,
  // persisted at entry) OR the premium drops 50% (Farrukh: "wait to sell at intended
  // target or 50% stop"). Safeties kept: swing-invalidation + catastrophe floor ($0.10)
  // within 2 days of expiry.
  exit: { style: "swing", swingStopLoss: -0.5, catastropheFloor: 0.1, catastropheDays: 2, takeProfit: 1.0, stopLoss: -0.3, sameDayExit: false },
  autoDefault: false, // OFF until the owner enables it in settings (shadow-measured first)
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

// QQQ Manual (EXPERIMENTAL) — QQQ-only 0DTE off levels the owner hand-enters each
// morning (ONE list, used across all charts — Farrukh 2026-07-16), NOT SniperBot
// zones. Entry = LEVEL TOUCH (owner's newest instruction supersedes the earlier
// confirmation-candle rule) gated by the coin-flip protections: 60% reaction-DB
// probability floor AND EV-net-of-spread+theta. Farrukh's LADDER drives the exit:
// 10 × ~$0.30-0.35 contracts, -30% base stop; at +50% trim 3 + stop→-10%; past
// +75% stop→breakeven; at +100% sell 6; 1 runner rides to the NEXT LEVEL (sell
// within ~$0.25 of it) or the ratcheted stop; 0DTE flatten before the close.
// Trades the QQQ paper account (ALPACA_*_2, PA3BS187DK8F) — qqq_0dte is shelved
// so the two can never trade the same account at once.
const QQQ_MANUAL: Profile = {
  id: "qqq_manual",
  label: "QQQ Manual",
  description: "QQQ 0DTE off owner-entered levels: level-touch entry, laddered exits to the next level. Experimental.",
  active: true,
  manualLevels: true, // candidates come ONLY from /api/manual-levels — never scanned
  strategy: DEFAULT_STRATEGY_OPTIONS,
  zoneTimeframes: [], // nothing to scan; also keeps refreshIntradayScans away
  // Entry is a LEVEL TOUCH (monitor branches on manualLevels); confirmation config is
  // kept only for the predict/EV plumbing shared with confirmation profiles.
  confirmation: { enabled: true, timeframe: "5Min", minRelVolume: 1.5 },
  requireClearRunway: false, // manual levels sit wherever the owner draws them
  minScore: 55, // same 0DTE playbook gate as qqq_0dte
  minProbability: 60, // HARD floor — keep the coin-flip fix on this variant too
  netContractCosts: true, // EV must clear round-trip spread + theta — keep it here too
  contract: {
    expiryKind: "zeroDte", // 0DTE ONLY
    otmPct: 1.5,
    itmPct: 1,
    priceFloor: 0.28, // "$0.30-0.35 priced contracts" with a little slack
    priceIdeal: 0.32,
    priceCap: 0.38,
    liquiditySpread: 0.7,
  },
  caps: { perTradeBudget: 350, maxContracts: 10, maxOpenPositions: 2 }, // 10 × ~$0.32 ≈ $320
  // Ladder exit per Farrukh; stopLoss -0.30 is the base stop (sell ALL remaining).
  exit: {
    style: "intraday",
    takeProfit: 0.6, // fallback TP only when no ladder/target was persisted
    stopLoss: -0.3,
    sameDayExit: true,
    ladder: { trim1Pct: 0.5, trim1Qty: 3, stopAfterTrim1: -0.1, breakevenPct: 0.75, trim2Pct: 1.0, trim2Qty: 6, targetProximity: 0.25 },
  },
  autoDefault: false, // experimental — owner enables via the level-editor toggle
  baselineSymbol: "QQQ",
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
};

export const PROFILE_IDS: ProfileId[] = ["sniper_swing", "sbv2", "sbv3", "qqq_0dte", "qqq_manual", "zones_legacy"];

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
