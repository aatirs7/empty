/**
 * Per-profile scorecard. SHADOW-ONLY: reads ONLY `shadow_outcomes`, split by
 * profileId so each strategy track (sniper_swing, qqq_0dte, zones_legacy) is
 * measured against ITS OWN baseline and never blended with the others. Does not
 * read proposals/orders. All code-computed.
 */
import { db } from "../db";
import { shadowOutcomes } from "../db/schema";
import { getProfile, PROFILE_IDS } from "./profiles";
import { getAllApiCost } from "./cost";

export interface Bucket {
  n: number;
  winRate: number; // 0..1
  avgReturnPct: number; // percent
  netPnl: number; // dollars, 1 contract
}

export interface ProfileScore {
  profileId: string;
  label: string;
  strategy: Bucket & { avgWinnerPct: number; avgLoserPct: number };
  baseline: Bucket;
  beatsBaseline: boolean | null;
  openShadows: number;
}

export interface Scorecard {
  profiles: ProfileScore[];
  apiCost: number;
}

interface Row {
  ret: number;
  pnl: number;
  win: boolean;
  kind: string;
  profileId: string;
  status: string;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function bucket(rows: Row[]): Bucket {
  return {
    n: rows.length,
    winRate: rows.length ? rows.filter((r) => r.win).length / rows.length : 0,
    avgReturnPct: mean(rows.map((r) => r.ret)) * 100,
    netPnl: Math.round(rows.reduce((a, r) => a + r.pnl, 0) * 100) / 100,
  };
}

export async function computeScorecard(): Promise<Scorecard> {
  const all = await db.select().from(shadowOutcomes);
  const rows: Row[] = all.map((s) => {
    const entry = Number(s.entryPremium);
    const exit = Number(s.exitPremium);
    return {
      ret: entry > 0 && s.status === "closed" ? (exit - entry) / entry : 0,
      pnl: s.status === "closed" ? (exit - entry) * 100 : 0,
      win: !!s.win,
      kind: s.kind,
      profileId: s.profileId,
      status: s.status,
    };
  });

  const profiles: ProfileScore[] = PROFILE_IDS.map((id) => {
    const mine = rows.filter((r) => r.profileId === id);
    const setups = mine.filter((r) => r.kind === "setup" && r.status === "closed");
    const bases = mine.filter((r) => r.kind === "baseline" && r.status === "closed");
    const strat = bucket(setups);
    const base = bucket(bases);
    const winners = setups.filter((r) => r.win).map((r) => r.ret);
    const losers = setups.filter((r) => !r.win).map((r) => r.ret);
    return {
      profileId: id,
      label: getProfile(id).label,
      strategy: { ...strat, avgWinnerPct: mean(winners) * 100, avgLoserPct: mean(losers) * 100 },
      baseline: base,
      beatsBaseline: setups.length && bases.length ? strat.avgReturnPct > base.avgReturnPct : null,
      openShadows: mine.filter((r) => r.kind === "setup" && r.status === "open").length,
    };
  });

  const cost = await getAllApiCost();
  return { profiles, apiCost: cost.total };
}
