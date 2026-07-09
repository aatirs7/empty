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

export type ProfileId = "sniper_swing" | "qqq_0dte" | "zones_legacy";

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
// QQQ intraday timeframes: finer bars use a lower displacement to surface enough
// zones. 15Min/1H drive same-day 0DTE; 4H drives the next-day 1-day swing.
// maxWidthAtr caps zone thickness (0.6×ATR) so big HTF candles don't produce
// range-wide zones — the tap edge is preserved, only the far edge pulls in.
const Q_15M: ZoneTimeframe = { timeframe: "15min", opts: { ...DEFAULT_ZONE_OPTIONS, displacement: 1.2, maxWidthAtr: 0.6 }, expiryKind: "zeroDte" };
const Q_1H: ZoneTimeframe = { timeframe: "1h", opts: { ...DEFAULT_ZONE_OPTIONS, displacement: 1.25, maxWidthAtr: 0.6 }, expiryKind: "zeroDte" };
const Q_4H_SWING: ZoneTimeframe = { timeframe: "4h", opts: { ...DEFAULT_ZONE_OPTIONS, displacement: 1.3, maxWidthAtr: 0.6 }, expiryKind: "oneDay" };

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
  takeProfit: number; // +1.0 => +100%
  stopLoss: number; // -0.3 => -30%
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
  strategy: StrategyOptions;
  zoneTimeframes: ZoneTimeframe[]; // zone timeframes to scan (QQQ = Daily + 4H)
  confirmation: ConfirmationConfig;
  requireClearRunway?: boolean; // white-space gate (default true). Off for intraday
  // 0DTE where zones sit close together and the confirmation candle is the real gate.
  watchPerTimeframe?: number; // how many nearest zones to watch per symbol/timeframe
  // (default 1). Single-ticker profiles (QQQ) watch several levels above+below price.
  minScore: number; // playbook/confidence gate
  contract: ContractConfig;
  caps: ProfileCaps;
  exit: ExitConfig;
  autoDefault: boolean; // default auto-execute (overridable in profile_settings)
  baselineSymbol: string; // scorecard benchmark for this track
}

// SniperBot Master — large/mega-cap institutional order-block swings, weekly options,
// confirmation-gated, far-OTM cheap contracts sized for the $500 paper account.
const SNIPER_SWING: Profile = {
  id: "sniper_swing",
  label: "SniperBot",
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
  exit: { takeProfit: 1.0, stopLoss: -0.3, sameDayExit: false },
  autoDefault: true, // owner chose to auto-trade SniperBot on the paper account
  baselineSymbol: "SPY",
};

// QQQ 0DTE — single-ticker, same-day-expiry, intraday horizon. High variance / fast
// decay: its OWN tight caps and its OWN scorecard track. Never shares swing sizing.
const QQQ_0DTE: Profile = {
  id: "qqq_0dte",
  label: "QQQ 0DTE",
  description: "QQQ same-day-expiry intraday setups. High variance, tight caps.",
  active: true,
  strategy: DEFAULT_STRATEGY_OPTIONS,
  // Intraday only — same-day 0DTE off 15Min/1H, next-day 1-day swing off 4H.
  // Daily was dropped: it produced multi-day (~5-day) holds that made no sense
  // against a same-day option.
  zoneTimeframes: [Q_15M, Q_1H, Q_4H_SWING],
  confirmation: { enabled: true, timeframe: "5Min", minRelVolume: 1.5 },
  requireClearRunway: false, // intraday zones sit close; the confirmation candle gates instead
  watchPerTimeframe: 4, // single ticker — watch the nearest 4 levels per timeframe, not 1
  minScore: 80, // stricter: 0DTE punishes marginal setups
  contract: {
    expiryKind: "zeroDte", // default; the 4H swing tf overrides to oneDay
    otmPct: 1.5, // 0DTE wants near-the-money to have any delta
    itmPct: 1,
    priceFloor: 0.4,
    priceIdeal: 0.8,
    priceCap: 1.5,
    liquiditySpread: 0.7,
  },
  // Budget covers a next-day swing contract (up to priceCap); 2 open lets a 0DTE
  // day-trade and a 1-day swing coexist. sameDayExit only flattens contracts that
  // expire TODAY (manageExits checks expiry===today), so the next-day swing rides.
  caps: { perTradeBudget: 160, maxContracts: 1, maxOpenPositions: 2 },
  exit: { takeProfit: 0.6, stopLoss: -0.35, sameDayExit: true },
  autoDefault: false, // off until measured
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
  exit: { takeProfit: 1.0, stopLoss: -0.3, sameDayExit: false },
  autoDefault: false, // SHELVED — no new auto-trades
  baselineSymbol: "SPY",
};

export const PROFILES: Record<ProfileId, Profile> = {
  sniper_swing: SNIPER_SWING,
  qqq_0dte: QQQ_0DTE,
  zones_legacy: ZONES_LEGACY,
};

export const PROFILE_IDS: ProfileId[] = ["sniper_swing", "qqq_0dte", "zones_legacy"];

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
