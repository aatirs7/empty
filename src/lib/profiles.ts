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

/** Zone timeframes a profile reads (QQQ reads Daily + 4H together). */
export interface ZoneTimeframe {
  timeframe: "daily" | "4h";
  opts: ZoneOptions;
}
const DAILY_TF: ZoneTimeframe = { timeframe: "daily", opts: DEFAULT_ZONE_OPTIONS }; // ATR50, disp 1.7
const FOURH_TF: ZoneTimeframe = { timeframe: "4h", opts: { ...DEFAULT_ZONE_OPTIONS, displacement: 1.3 } };

export interface ContractConfig {
  /** friday = nearest weekly Friday; twoToFourWeeks = ~21d; zeroDte = same-day. */
  expiryKind: "friday" | "twoToFourWeeks" | "zeroDte";
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
  maxOpenPositions: number;
  maxTradesPerDay: number;
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
  active: boolean; // scanner/monitor process this profile
  strategy: StrategyOptions;
  zoneTimeframes: ZoneTimeframe[]; // zone timeframes to scan (QQQ = Daily + 4H)
  confirmation: ConfirmationConfig;
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
  caps: { perTradeBudget: 100, maxContracts: 1, maxOpenPositions: 3, maxTradesPerDay: 3 },
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
  zoneTimeframes: [DAILY_TF, FOURH_TF],
  confirmation: { enabled: true, timeframe: "5Min", minRelVolume: 1.5 },
  minScore: 80, // stricter: 0DTE punishes marginal setups
  contract: {
    expiryKind: "zeroDte",
    otmPct: 1.5, // 0DTE wants near-the-money to have any delta
    itmPct: 1,
    priceFloor: 0.4,
    priceIdeal: 0.8,
    priceCap: 1.5,
    liquiditySpread: 0.7,
  },
  caps: { perTradeBudget: 60, maxContracts: 1, maxOpenPositions: 1, maxTradesPerDay: 2 },
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
  caps: { perTradeBudget: 100, maxContracts: 1, maxOpenPositions: 3, maxTradesPerDay: 3 },
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
