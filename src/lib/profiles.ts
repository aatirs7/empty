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
  takeProfit: number; // intraday only: +1.0 => +100% of premium
  stopLoss: number; // intraday only: -0.35 => -35% of premium
  sameDayExit: boolean; // 0DTE: flatten before the close
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
  // Swing: hold to first target / swing invalidation; ride to $2 as an upside TP.
  // NO mid-swing stop. Catastrophe floor ($0.15) only bites within 2 days of expiry.
  exit: { style: "swing", targetPremium: 2.0, catastropheFloor: 0.15, catastropheDays: 2, takeProfit: 1.0, stopLoss: -0.3, sameDayExit: false },
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
    // Cheap ~$0.30 far-OTM weeklies (owner: "$0.30 contracts set up to go to $3-5").
    // Cheap ⇒ further OTM, so widen the strike window; the ask band admits ~$0.18-0.45.
    expiryKind: "friday", // nearest weekly ≥ the predicted 1-2 day hold (selectByEV horizon-matches)
    otmPct: 25, // mega-cap ~$0.30 weeklies sit far OTM; reach far enough to find quoted strikes
    itmPct: 4,
    priceFloor: 0.15,
    priceIdeal: 0.3,
    priceCap: 0.6, // "around $0.30" with headroom for expensive names where the nearest cheap strike quotes higher
    liquiditySpread: 0.5, // (unused on the selectByEV path SBv2 takes; kept for consistency)
  },
  caps: { perTradeBudget: 100, maxContracts: 3, maxOpenPositions: 10 }, // 2-3 contracts at ~$0.30
  // Swing exit: sell when the UNDERLYING reaches the reaction-DB target (predict.targetMain,
  // persisted at entry). NO $2 premium ride — the DB target drives the exit. Safeties kept:
  // swing-invalidation (daily close back through the flipped zone) + a catastrophe floor
  // ($0.10) only within 2 days of expiry. No mid-swing hard stop.
  exit: { style: "swing", catastropheFloor: 0.1, catastropheDays: 2, takeProfit: 1.0, stopLoss: -0.3, sameDayExit: false },
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
  description: "SBv2 clone for Farrukh's next strategy update. Experimental — scratch if it doesn't work.",
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

// QQQ Manual (EXPERIMENTAL, owner request 2026-07-15) — QQQ-only 0DTE off levels the
// owner hand-enters each morning (5m/15m/1h charts), NOT SniperBot zones. Entry is a
// 5-MINUTE CONFIRMATION CANDLE at the level (never a bare touch). Everything else
// mirrors qqq_0dte — including the coin-flip protections: the 60% reaction-DB
// probability floor AND EV-net-of-spread+theta both apply (manual levels don't fix
// 0DTE losing on ~50% setups; these gates do). Trades the QQQ paper account
// (ALPACA_*_2, PA3NPEDZA11B) — handed over from qqq_0dte, which is PAUSED/shelved
// so the two can never trade the same account at once. qqq_0dte stays shadow-
// measured for the head-to-head.
const QQQ_MANUAL: Profile = {
  id: "qqq_manual",
  label: "QQQ Manual",
  description: "QQQ 0DTE off owner-entered 5m/15m/1h levels, 5-min confirmation candle entry. Experimental.",
  active: true,
  manualLevels: true, // candidates come ONLY from /api/manual-levels — never scanned
  strategy: DEFAULT_STRATEGY_OPTIONS,
  zoneTimeframes: [], // nothing to scan; also keeps refreshIntradayScans away
  confirmation: { enabled: true, timeframe: "5Min", minRelVolume: 1.5 }, // 5-min candle REQUIRED
  requireClearRunway: false, // manual levels sit wherever the owner draws them
  minScore: 55, // same 0DTE playbook gate as qqq_0dte
  minProbability: 60, // HARD floor — keep the coin-flip fix on this variant too
  netContractCosts: true, // EV must clear round-trip spread + theta — keep it here too
  contract: {
    expiryKind: "zeroDte", // 0DTE ONLY
    otmPct: 1.5,
    itmPct: 1,
    priceFloor: 0.4,
    priceIdeal: 0.8,
    priceCap: 1.5,
    liquiditySpread: 0.7,
  },
  caps: { perTradeBudget: 160, maxContracts: 1, maxOpenPositions: 2 },
  exit: { style: "intraday", takeProfit: 0.6, stopLoss: -0.35, sameDayExit: true },
  autoDefault: false, // experimental — owner enables via profile-auto when ready
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
