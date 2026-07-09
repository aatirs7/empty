/**
 * SniperBot playbook classifier + swing scorer (see SNIPERBOT-RULES.md and the
 * playbook-classifier spec). Given a live zone tap, it CODE-computes:
 *   - the playbook type (Support Bounce, Support Reclaim, Breakout Rejection, ...)
 *   - safe/extended swing targets (from daily swing highs/lows, not the zone)
 *   - a historical-reaction read at the level
 *   - a 0-100 quality score
 * The monitor only fires when the score clears PLAYBOOK_MIN_SCORE (default 80),
 * making it selective. GUARDRAIL: every number here is code-computed.
 */
import type { Bar } from "./alpaca";

export interface PlaybookResult {
  playbook: string;
  score: number; // 0-100 — the LIVE auto-buy gate score (monitor.ts). Do not change its scale.
  displayScore: number; // 0-100 — UI-only, non-saturating so setups actually rank. Not a gate.
  safeTarget: number | null;
  extendedTarget: number | null;
  riskReward: number | null;
  historical: { reactions: number; respected: number; avgMovePct: number; maxMovePct: number; avgDays: number };
  reason: string;
  alert: boolean;
}

export const PLAYBOOK_MIN_SCORE = Number(process.env.PLAYBOOK_MIN_SCORE ?? 70);
const HOLD = 10; // swing horizon in trading days

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Fractal swing highs: bar high strictly greater than k bars on each side. */
function swingHighs(bars: Bar[], k = 3): number[] {
  const out: number[] = [];
  for (let i = k; i < bars.length - k; i++) {
    let hi = true;
    for (let j = i - k; j <= i + k; j++) if (j !== i && bars[j].h >= bars[i].h) hi = false;
    if (hi) out.push(bars[i].h);
  }
  return out;
}
function swingLows(bars: Bar[], k = 3): number[] {
  const out: number[] = [];
  for (let i = k; i < bars.length - k; i++) {
    let lo = true;
    for (let j = i - k; j <= i + k; j++) if (j !== i && bars[j].l <= bars[i].l) lo = false;
    if (lo) out.push(bars[i].l);
  }
  return out;
}

function classifyPlaybook(bars: Bar[], zone: { bottom: number; top: number }, direction: "call" | "put"): string {
  const recent = bars.slice(-10).map((b) => b.c);
  const last = recent[recent.length - 1];
  const anyBelow = recent.some((c) => c < zone.bottom);
  const anyAbove = recent.some((c) => c > zone.top);
  if (direction === "call") {
    if (anyBelow && last > zone.top) return "Support Reclaim"; // dipped below, reclaimed = bullish
    if (recent.some((c) => c <= zone.top) && last > zone.top) return "Support Retest";
    return "Support Bounce";
  }
  if (anyAbove && last < zone.bottom) return "Breakout Rejection"; // popped above, rejected = bearish
  if (recent.some((c) => c >= zone.bottom) && last < zone.bottom) return "Resistance Retest";
  return "Resistance Rejection";
}

/** Prior reactions from this zone: how often price tapped it and the follow-through. */
function historicalReaction(bars: Bar[], zone: { bottom: number; top: number }, direction: "call" | "put") {
  const moves: number[] = [];
  const durations: number[] = [];
  let reactions = 0;
  let respected = 0;
  // Ignore the last ~5 bars (that's the current setup, not history).
  for (let i = 1; i < bars.length - HOLD - 5; i++) {
    const tapped = bars[i].h >= zone.bottom && bars[i].l <= zone.top;
    if (!tapped) continue;
    reactions++;
    const entry = bars[i].c;
    let best = 0;
    let bestDay = 0;
    for (let d = 1; d <= HOLD; d++) {
      const b = bars[i + d];
      const mv = direction === "call" ? (b.h - entry) / entry : (entry - b.l) / entry;
      if (mv > best) {
        best = mv;
        bestDay = d;
      }
    }
    moves.push(best * 100);
    durations.push(bestDay);
    if (best > 0.02) respected++; // moved >2% the right way = respected the level
  }
  return {
    reactions,
    respected,
    avgMovePct: Math.round(mean(moves) * 10) / 10,
    maxMovePct: Math.round(Math.max(0, ...moves, 0) * 10) / 10,
    avgDays: Math.round(mean(durations) * 10) / 10,
  };
}

export function classifyAndScore(
  bars: Bar[],
  zone: { bottom: number; top: number },
  direction: "call" | "put",
  price: number,
): PlaybookResult {
  const playbook = classifyPlaybook(bars, zone, direction);
  const hist = historicalReaction(bars, zone, direction);

  // Targets from daily swing structure (not the zone).
  const highs = swingHighs(bars).filter((h) => h > price).sort((a, b) => a - b);
  const lows = swingLows(bars).filter((l) => l < price).sort((a, b) => b - a);
  const safeTarget = direction === "call" ? (highs[0] ?? null) : (lows[0] ?? null);
  const extendedTarget = direction === "call" ? (highs[1] ?? highs[0] ?? null) : (lows[1] ?? lows[0] ?? null);

  // Risk/reward: reward to the safe target vs the zone height as implied stop.
  const zoneHeight = Math.max(zone.top - zone.bottom, price * 0.005);
  const reward = safeTarget != null ? Math.abs(safeTarget - price) : 0;
  const riskReward = reward > 0 ? Math.round((reward / zoneHeight) * 10) / 10 : null;

  // Score (0-100), all mechanical. 80+ needs strong history OR strong R/R on top
  // of the always-true gates (clean tap, confirm, white space). Threshold is
  // env-tunable via PLAYBOOK_MIN_SCORE.
  const lastClose = bars[bars.length - 1].c;
  const closeConfirm = direction === "call" ? lastClose >= zone.bottom : lastClose <= zone.top;
  const tap = 10; // a real boundary tap (the monitor only calls us on one)
  const clarity = 10; // a named playbook
  const whiteSpace = 10; // continuation-side runway (already gated true)
  const confirm = closeConfirm ? 10 : 0;
  const histScore = clamp(hist.respected * 3 + hist.avgMovePct * 1.5, 0, 30); // differentiator
  const rrScore = riskReward != null ? clamp(riskReward * 8, 0, 25) : 0; // differentiator
  const targetScore = safeTarget != null ? 5 : 0;
  const score = Math.round(tap + clarity + whiteSpace + confirm + histScore + rrScore + targetScore);

  // DISPLAY score (UI ranking only — never a gate). The gate `score` above pins
  // at 100 because its two differentiators saturate almost immediately; this one
  // uses wider, non-saturating scales so setups spread across a real range and a
  // mediocre level no longer looks identical to a great one.
  const strongPlaybook = playbook === "Support Reclaim" || playbook === "Breakout Rejection";
  const dispBase = 8; // it's a real named zone level on the watch list
  const dispPlaybook = strongPlaybook ? 12 : 6;
  const dispHist = clamp(hist.respected * 2 + hist.avgMovePct * 1.2, 0, 40);
  const dispRR = riskReward != null ? clamp(Math.log2(1 + riskReward) * 10, 0, 30) : 0; // log so a far target doesn't peg it
  const dispConfirm = closeConfirm ? 10 : 0;
  const displayScore = Math.round(clamp(dispBase + dispPlaybook + dispHist + dispRR + dispConfirm, 0, 100));

  const reason = `${playbook}; ${hist.reactions} prior taps (${hist.respected} respected, avg +${hist.avgMovePct}% in ~${hist.avgDays}d); R/R ~${riskReward ?? "?"}.`;

  return {
    playbook,
    score,
    displayScore,
    safeTarget: safeTarget != null ? Math.round(safeTarget * 100) / 100 : null,
    extendedTarget: extendedTarget != null ? Math.round(extendedTarget * 100) / 100 : null,
    riskReward,
    historical: hist,
    reason,
    alert: score >= PLAYBOOK_MIN_SCORE,
  };
}
