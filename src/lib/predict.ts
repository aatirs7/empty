/**
 * Underlying prediction engine. Answers "where is this symbol likely to move next,
 * how far, how fast, and how sure am I?" — entirely from the historical-reaction
 * database (queryReactions), never the model. Every number carries a sample size
 * and an honesty gate. The option engine (ev.ts) capitalizes on this prediction.
 */
import { queryReactions } from "./reactions";
import { formatHold } from "./timeframes";

export interface Prediction {
  bias: "reverse_up" | "reverse_down" | "chop";
  direction: "call" | "put" | null;
  probability: number; // empirical hit rate, 0-100
  confidence: number; // probability adjusted for sample + trend agreement, 0-100
  expectedMovePct: number;
  expectedMovePts: number;
  targetSafe: number | null;
  targetMain: number | null;
  targetStretch: number | null;
  expectedHoldBars: number;
  expectedHoldLabel: string; // human hold: minutes for intraday, days for daily
  sampleSize: number;
  lowConfidence: boolean;
  reason: string;
}

const CHOP: Prediction = {
  bias: "chop",
  direction: null,
  probability: 0,
  confidence: 0,
  expectedMovePct: 0,
  expectedMovePts: 0,
  targetSafe: null,
  targetMain: null,
  targetStretch: null,
  expectedHoldBars: 0,
  expectedHoldLabel: "—",
  sampleSize: 0,
  lowConfidence: true,
  reason: "no historical reactions to match",
};

/**
 * Predict the underlying's next move at a zone, from the reaction DB.
 * @param marketAlign  -1..1 how well the broad market agrees with the trade direction.
 */
export async function predict(
  symbol: string,
  spot: number,
  timeframe: string,
  direction: "call" | "put",
  approach: string,
  marketAlign = 0,
): Promise<Prediction> {
  const stats = await queryReactions({ symbol, timeframe, direction, approach, spot });
  if (stats.n === 0) return CHOP;

  const probability = Math.round(stats.hitRate * 100);
  const sampleAdequacy = Math.min(1, stats.n / 40); // full weight at 40+ samples
  const marketFactor = 0.85 + 0.15 * Math.max(0, marketAlign); // small nudge, never a veto
  const confidence = Math.round(probability * (0.55 + 0.45 * sampleAdequacy) * marketFactor);

  return {
    bias: direction === "call" ? "reverse_up" : "reverse_down",
    direction,
    probability,
    confidence,
    expectedMovePct: stats.avgMovePct,
    expectedMovePts: stats.avgMovePts,
    targetSafe: stats.safeTarget,
    targetMain: stats.mainTarget,
    targetStretch: stats.stretchTarget,
    expectedHoldBars: stats.expectedHold,
    expectedHoldLabel: formatHold(stats.expectedHold, timeframe),
    sampleSize: stats.n,
    lowConfidence: stats.lowConfidence,
    reason: `${probability}% over ${stats.n} ${timeframe} reactions (${stats.bucket}); expected +${stats.avgMovePct}% (${stats.avgMovePts}pts) in ${formatHold(stats.expectedHold, timeframe)}${stats.lowConfidence ? "; LOW SAMPLE" : ""}.`,
  };
}
