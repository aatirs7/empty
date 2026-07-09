/**
 * SniperBot confidence engine. Turns a confirmed setup into three independent,
 * CODE-COMPUTED scores (Probability / Weekly-Options-Potential / Execution-Quality)
 * plus a historical-similarity read, an empty-space-continuation flag, and an
 * adversarial review. Every number here comes from real bars — never the model.
 *
 * A setup is promoted ONLY if all three scores clear their thresholds AND it
 * survives every adversarial rejection test (SniperBot: try to DISPROVE it).
 */
import type { Bar } from "./alpaca";
import type { classifyAndScore } from "./playbook";

type Playbook = ReturnType<typeof classifyAndScore>;

export interface MarketContext {
  spy: number; // -1..1 trend (up positive)
  qqq: number;
}

export interface SniperEval {
  probability: number; // 0-100
  weeklyPotential: number; // 0-100
  executionQuality: number; // 0-100 (from the confirmation candle)
  overall: number; // display blend
  similarityPct: number; // % of prior reactions that respected the zone
  reactions: number;
  emptySpace: boolean; // empty-space continuation pattern present
  expectedMovePct: number;
  expectedHoldDays: number;
  rejections: string[]; // adversarial failures; empty = survived
  passed: boolean;
  summary: string;
}

const THRESH = { probability: 55, weeklyPotential: 50, executionQuality: 45 };

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const clamp01 = (n: number) => clamp(n, 0, 1);

/** Trend of the recent closes vs their 20-bar mean, scaled to roughly -1..1. */
function trendScore(bars: Bar[]): number {
  const closes = bars.slice(-20).map((b) => b.c);
  if (closes.length < 5) return 0;
  const sma = closes.reduce((s, c) => s + c, 0) / closes.length;
  const last = closes[closes.length - 1];
  return clamp(((last - sma) / sma) * 5, -1, 1);
}

/** Average true-range as a % of price over the last ~14 bars. */
export function atrPct(bars: Bar[]): number {
  const w = bars.slice(-14);
  if (w.length === 0) return 0;
  const avgRange = w.reduce((s, b) => s + (b.h - b.l), 0) / w.length;
  const price = w[w.length - 1].c || 1;
  return avgRange / price;
}

/** A strong displacement candle in the last n bars = broke into "empty space". */
function recentDisplacement(bars: Bar[], n: number): boolean {
  const atr = atrPct(bars) * (bars[bars.length - 1]?.c ?? 0);
  if (atr <= 0) return false;
  return bars.slice(-n).some((b) => Math.abs(b.c - b.o) > 1.5 * atr);
}

/** Compute a market-trend score from an index's daily bars (for MarketContext). */
export function indexTrend(bars: Bar[]): number {
  return trendScore(bars);
}

export function evaluateSniper(
  pb: Playbook,
  bars: Bar[],
  direction: "call" | "put",
  execScore: number,
  clearRunway: boolean,
  market: MarketContext,
): SniperEval {
  const h = pb.historical;
  const respectedRate = h.reactions > 0 ? h.respected / h.reactions : 0;
  const stockTrend = trendScore(bars);
  const marketTrend = (market.spy + market.qqq) / 2;
  const dirSign = direction === "call" ? 1 : -1;
  // A fade in the direction of the higher trend is aligned (buy the dip in an
  // uptrend / sell the rip in a downtrend).
  const trendAlign = clamp01(((stockTrend * dirSign + 1) / 2) * 0.6 + ((marketTrend * dirSign + 1) / 2) * 0.4);
  const emptySpace = clearRunway && recentDisplacement(bars, 15);
  const atrp = atrPct(bars);
  const rr = pb.riskReward ?? 0;

  // Probability — likelihood the setup follows through.
  const probability = Math.round(
    clamp(respectedRate * 45 + Math.min(h.reactions, 8) * 2 + trendAlign * 25 + (emptySpace ? 10 : 0), 0, 100),
  );

  // Weekly-Options-Potential — if right, how much room/speed for a big % move.
  const moveScore = clamp(h.avgMovePct * 4, 0, 40);
  const rrScore = clamp(rr * 8, 0, 30);
  const speedScore = h.avgDays > 0 ? clamp((6 - h.avgDays) * 5, 0, 20) : 10;
  const volScore = clamp(atrp * 100 * 3, 0, 10);
  const weeklyPotential = Math.round(clamp(moveScore + rrScore + speedScore + volScore, 0, 100));

  const executionQuality = Math.round(clamp(execScore, 0, 100));

  // Adversarial review — actively try to DISPROVE the trade.
  const rejections: string[] = [];
  if (h.reactions < 3) rejections.push("thin history (<3 prior reactions at this level)");
  if (respectedRate < 0.4) rejections.push("zone rarely respected historically");
  if (rr < 1) rejections.push("poor risk/reward");
  if (h.avgMovePct < 2) rejections.push("historical moves too small for weekly options");
  if (marketTrend * dirSign < -0.3) rejections.push("fighting a strong opposing market trend");
  if (probability < THRESH.probability) rejections.push(`probability ${probability} < ${THRESH.probability}`);
  if (weeklyPotential < THRESH.weeklyPotential) rejections.push(`weekly-options potential ${weeklyPotential} < ${THRESH.weeklyPotential}`);
  if (executionQuality < THRESH.executionQuality) rejections.push(`execution quality ${executionQuality} < ${THRESH.executionQuality}`);

  const passed = rejections.length === 0;
  const similarityPct = Math.round(respectedRate * 100);
  const overall = Math.round((probability + weeklyPotential + executionQuality) / 3);
  const summary = `Prob ${probability} · Weekly-potential ${weeklyPotential} · Exec ${executionQuality}. Matches ${similarityPct}% of ${h.reactions} prior reactions; avg move +${h.avgMovePct}% in ~${h.avgDays}d${emptySpace ? "; empty-space continuation" : ""}.`;

  return {
    probability,
    weeklyPotential,
    executionQuality,
    overall,
    similarityPct,
    reactions: h.reactions,
    emptySpace,
    expectedMovePct: h.avgMovePct,
    expectedHoldDays: h.avgDays,
    rejections,
    passed,
    summary,
  };
}
