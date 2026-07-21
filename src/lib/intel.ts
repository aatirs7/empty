/**
 * SBv2 market-intelligence + portfolio-risk layer (owner spec 2026-07-18, after the
 * 7/17 correlated-calls drawdown). Wraps AROUND the zone/flip entry — the zone tap
 * still creates the signal; this layer decides whether the tap is worth taking given
 * market direction, the stock's own structure, relative strength, existing exposure,
 * and the session's loss record.
 *
 * REVERT SWITCH: set env SBV2_INTEL=off (Vercel + redeploy) to restore pure
 * mechanical entries — the single call site in monitor.ts checks `intelEnabled()`.
 * All logic lives in this file; nothing else depends on it.
 *
 * GUARDRAIL: every number here is code-computed from real OHLCV bars and live
 * positions. No model-generated values anywhere.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import { orders, proposals } from "../db/schema";
import { getIntradayBars, getStockBars, type Bar } from "./alpaca";
import { getBroker } from "./broker";
import { parseOcc } from "./format";

export type Bias = "strong_bear" | "bear" | "neutral" | "bull" | "strong_bull";
export type Grade = "A" | "B" | "C";

export interface IntelVerdict {
  allowed: boolean;
  grade: Grade;
  summary: string; // plain-English, logged on the skip/proposal
  marketBias: Bias;
  stockStructure: "bullish" | "bearish" | "neutral";
  relStrengthPct: number; // stock day% minus QQQ day%
}

export function intelEnabled(profileId: string): boolean {
  return profileId === "sbv2" && process.env.SBV2_INTEL !== "off";
}

// ---- Sector map (universe groupings from seed-universe.ts) ------------------------
const SECTORS: Record<string, string[]> = {
  tech: ["AAPL","MSFT","NVDA","AMZN","GOOGL","GOOG","META","AVGO","TSLA","NFLX","ORCL","CRM","ADBE","AMD","CSCO","INTC","QCOM","TXN","IBM","NOW","INTU","AMAT","MU","LRCX","KLAC","ADI","PANW","CRWD","SNOW","PLTR","UBER","ABNB","SHOP","ANET","DELL","SMCI","ARM","MSTR","MRVL","APP"],
  consumer: ["DIS","CMCSA","T","VZ","TMUS","WBD","SPOT","NKE","SBUX","MCD","BKNG","MAR","HD","LOW","TGT","COST","WMT","TJX","F","GM","RIVN"],
  staples: ["PG","KO","PEP","PM","MO","MDLZ","CL","KHC"],
  financials: ["JPM","BAC","WFC","C","GS","MS","SCHW","AXP","V","MA","BX","KKR","COIN","HOOD","SOFI","PYPL"],
  healthcare: ["UNH","JNJ","LLY","PFE","MRK","ABBV","TMO","ABT","BMY","AMGN","GILD","CVS","ISRG","MRNA"],
  industrials: ["CAT","DE","BA","GE","HON","UNP","UPS","FDX","LMT","RTX","GEV"],
  energy: ["XOM","CVX","COP","SLB","EOG","OXY","MPC","KMI"],
  materials_util_reit: ["LIN","FCX","NEM","NUE","NEE","DUK","SO","AMT","PLD","SPG","O"],
};
export function sectorOf(symbol: string): string {
  for (const [sector, syms] of Object.entries(SECTORS)) if (syms.includes(symbol)) return sector;
  return "other";
}

// ---- Bias + structure (pure bar math) ---------------------------------------------

function dayBars(bars5m: Bar[]): Bar[] {
  if (!bars5m.length) return [];
  const lastDay = bars5m[bars5m.length - 1].t.slice(0, 10);
  return bars5m.filter((b) => b.t.slice(0, 10) === lastDay);
}

function vwapOf(bars: Bar[]): number | null {
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    const typical = (b.h + b.l + b.c) / 3;
    pv += typical * b.v;
    vol += b.v;
  }
  return vol > 0 ? pv / vol : null;
}

/** 5-level bias from today's 5-min tape + daily context. Heuristic weights, but
 *  every input is a real price/volume fact: day change, position vs VWAP, the last
 *  ~75 min slope, and where price sits vs the 20-day average. */
export function classifyBias(daily: Bar[], intraday5: Bar[]): Bias {
  let score = 0;
  const today = dayBars(intraday5);
  if (today.length >= 3) {
    const open = today[0].o;
    const last = today[today.length - 1].c;
    const dayPct = open > 0 ? ((last - open) / open) * 100 : 0;
    score += Math.max(-2, Math.min(2, dayPct)); // day direction, capped ±2
    const vwap = vwapOf(today);
    if (vwap != null) score += last > vwap ? 0.5 : -0.5;
    const back = today[Math.max(0, today.length - 16)].c; // ~75 min ago
    const slopePct = back > 0 ? ((last - back) / back) * 100 : 0;
    score += Math.max(-1, Math.min(1, slopePct * 2)); // recent momentum
  }
  if (daily.length >= 21) {
    const closes = daily.map((b) => b.c);
    const last = closes[closes.length - 1];
    const sma20 = closes.slice(-21, -1).reduce((s, c) => s + c, 0) / 20;
    score += last > sma20 ? 0.5 : -0.5; // higher-timeframe carries steady weight
    const wk = closes[closes.length - 6] ?? closes[0];
    score += last > wk ? 0.25 : -0.25;
  }
  if (score >= 2) return "strong_bull";
  if (score >= 0.75) return "bull";
  if (score <= -2) return "strong_bear";
  if (score <= -0.75) return "bear";
  return "neutral";
}

/** Swing structure off 15-min bars: fractal pivots (k=2), then HH/HL vs LL/LH from
 *  the last two swing highs + lows. The "protected" swing check: a bullish read is
 *  demoted to neutral when price has closed below the most recent higher low. */
export function classifyStructure(bars15: Bar[]): "bullish" | "bearish" | "neutral" {
  if (bars15.length < 20) return "neutral";
  const k = 2;
  const highs: { i: number; p: number }[] = [];
  const lows: { i: number; p: number }[] = [];
  for (let i = k; i < bars15.length - k; i++) {
    // STRICT fractals: plateaus of equal highs/lows are not pivots (ties would mark
    // every bar of a flat stretch as both a high and a low).
    const isHigh = bars15.slice(i - k, i + k + 1).every((b, j) => j === k || b.h < bars15[i].h);
    const isLow = bars15.slice(i - k, i + k + 1).every((b, j) => j === k || b.l > bars15[i].l);
    if (isHigh) highs.push({ i, p: bars15[i].h });
    if (isLow) lows.push({ i, p: bars15[i].l });
  }
  if (highs.length < 2 || lows.length < 2) return "neutral";
  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);
  const last = bars15[bars15.length - 1].c;
  const higherHighs = h2.p > h1.p;
  const higherLows = l2.p > l1.p;
  const lowerHighs = h2.p < h1.p;
  const lowerLows = l2.p < l1.p;
  if (higherHighs && higherLows) {
    // Protected higher low: still intact? A close below it weakens the trend.
    return last >= l2.p ? "bullish" : "neutral";
  }
  if (lowerHighs && lowerLows) {
    return last <= h2.p ? "bearish" : "neutral";
  }
  return "neutral";
}

function dayChangePct(intraday5: Bar[]): number {
  const today = dayBars(intraday5);
  if (today.length < 2) return 0;
  const open = today[0].o;
  return open > 0 ? ((today[today.length - 1].c - open) / open) * 100 : 0;
}

// ---- Market snapshot (cached ~60s — one set of index fetches per tap burst) ------
let marketSnap: { at: number; bias: Bias; qqqDayPct: number } | null = null;
async function marketSnapshot(): Promise<{ bias: Bias; qqqDayPct: number }> {
  if (marketSnap && marketSnap.at > Date.now() - 60_000) return marketSnap;
  const [qqq5, spy5, qqqD, spyD] = await Promise.all([
    getIntradayBars("QQQ", "5Min", 390),
    getIntradayBars("SPY", "5Min", 390),
    getStockBars("QQQ", 40),
    getStockBars("SPY", 40),
  ]);
  const qqqBias = classifyBias(qqqD, qqq5);
  const spyBias = classifyBias(spyD, spy5);
  // Combine: take the more cautious of the two when they disagree by direction.
  const order: Bias[] = ["strong_bear", "bear", "neutral", "bull", "strong_bull"];
  const bias = order[Math.round((order.indexOf(qqqBias) + order.indexOf(spyBias)) / 2)];
  marketSnap = { at: Date.now(), bias, qqqDayPct: dayChangePct(qqq5) };
  return marketSnap;
}

// ---- Session loss record ----------------------------------------------------------
async function sessionLosses(profileId: string): Promise<{ lossesToday: number; lastTwoWereLosses: boolean }> {
  const rows = await db
    .select({ pl: orders.realizedPl, exitAt: orders.exitAt })
    .from(orders)
    .innerJoin(proposals, eq(orders.proposalId, proposals.id))
    .where(
      and(
        eq(proposals.profileId, profileId),
        isNotNull(orders.exitAt),
        sql`(${orders.exitAt} AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date`,
      ),
    )
    .orderBy(orders.exitAt);
  const pls = rows.map((r) => (r.pl != null ? Number(r.pl) : 0));
  const lossesToday = pls.filter((p) => p < 0).length;
  const lastTwo = pls.slice(-2);
  return { lossesToday, lastTwoWereLosses: lastTwo.length === 2 && lastTwo.every((p) => p < 0) };
}

// ---- The verdict ------------------------------------------------------------------
const BULLISH_SIDE: Bias[] = ["bull", "strong_bull"];
const BEARISH_SIDE: Bias[] = ["bear", "strong_bear"];

/** Evaluate an SBv2 tap. Returns allowed=false with a plain-English summary when the
 *  intelligence layer vetoes the entry. All facts are bar-math + live positions.
 *
 *  `riskOnly` (SBv2 2026-07-21 breakout spec): the spec REMOVED all market/structure/
 *  relative-strength gates from trade qualification but explicitly keeps
 *  "session-loss limits and portfolio position limits ... strictly as account-risk
 *  protections" — so risk-only mode runs ONLY the loss-response + exposure caps
 *  (and skips the market/stock bar fetches entirely). */
export async function evaluateSbv2Intel(
  symbol: string,
  direction: "call" | "put",
  opts?: { riskOnly?: boolean },
): Promise<IntelVerdict> {
  const riskOnly = opts?.riskOnly === true;
  if (riskOnly) {
    const [losses, positions] = await Promise.all([sessionLosses("sbv2"), getBroker("sbv2").listPositions()]);
    const openSameDir = positions.filter((p) => parseOcc(p.symbol)?.type === direction).length;
    const sector = sectorOf(symbol);
    const openSameSector = positions.filter((p) => {
      const occ = parseOcc(p.symbol);
      return occ != null && sectorOf(occ.underlying) === sector;
    }).length;
    const rblock = (why: string): IntelVerdict => ({
      allowed: false,
      grade: "C",
      summary: `Risk veto: ${why}`,
      marketBias: "neutral",
      stockStructure: "neutral",
      relStrengthPct: 0,
    });
    if (losses.lossesToday >= 3) return rblock("3 losses already today — done adding risk for the session.");
    if (openSameDir >= 2) return rblock(`already holding ${openSameDir} ${direction}s — same-direction exposure cap.`);
    if (openSameSector >= 2) return rblock(`already holding ${openSameSector} positions in ${sector} — sector concentration cap.`);
    return {
      allowed: true,
      grade: "A",
      summary: `Risk OK: ${losses.lossesToday} losses today, ${openSameDir} open ${direction}s, sector ${sector} x${openSameSector}.`,
      marketBias: "neutral",
      stockStructure: "neutral",
      relStrengthPct: 0,
    };
  }

  const [{ bias: marketBias, qqqDayPct }, stock15, stock5, losses, positions] = await Promise.all([
    marketSnapshot(),
    getIntradayBars(symbol, "15Min", 5 * 390), // ~5 sessions of 15-min structure
    getIntradayBars(symbol, "5Min", 390),
    sessionLosses("sbv2"),
    getBroker("sbv2").listPositions(),
  ]);

  const stockStructure = classifyStructure(stock15);
  const relStrengthPct = Math.round((dayChangePct(stock5) - qqqDayPct) * 100) / 100;

  const withTrade = direction === "call" ? BULLISH_SIDE : BEARISH_SIDE;
  const againstTrade = direction === "call" ? BEARISH_SIDE : BULLISH_SIDE;
  const extremeAgainst = direction === "call" ? "strong_bear" : "strong_bull";
  const alignedStructure = direction === "call" ? "bullish" : "bearish";
  const opposedStructure = direction === "call" ? "bearish" : "bullish";
  const strongRs = direction === "call" ? relStrengthPct >= 1 : relStrengthPct <= -1;

  const openSameDir = positions.filter((p) => parseOcc(p.symbol)?.type === direction).length;
  const sector = sectorOf(symbol);
  const openSameSector = positions.filter((p) => {
    const occ = parseOcc(p.symbol);
    return occ != null && sectorOf(occ.underlying) === sector;
  }).length;

  const block = (why: string, extra?: string): IntelVerdict => ({
    allowed: false,
    grade: "C",
    summary: `Intel veto: ${why}${extra ? ` ${extra}` : ""} [market ${marketBias}, stock ${stockStructure}, RS ${relStrengthPct >= 0 ? "+" : ""}${relStrengthPct}%]`,
    marketBias,
    stockStructure,
    relStrengthPct,
  });

  // 1) Session loss response — stand down after a bad day, cool off after 2 straight.
  if (losses.lossesToday >= 3) return block(`3 losses already today — done adding risk for the session.`);
  if (losses.lastTwoWereLosses && !withTrade.includes(marketBias)) {
    return block(`last 2 trades were losses and the market isn't clearly ${direction === "call" ? "bullish" : "bearish"} — cooling off.`);
  }

  // 2) Market-direction filter. An extreme market-wide move overrides everything;
  //    an ordinary opposing market needs strong relative strength + aligned structure.
  if (marketBias === extremeAgainst) {
    return block(`market is ${marketBias.replace("_", " ")} — no ${direction}s into an extreme market-wide move.`);
  }
  if (againstTrade.includes(marketBias) && !(strongRs && stockStructure === alignedStructure)) {
    return block(
      `market is ${marketBias} against a ${direction}`,
      `and ${symbol} lacks the relative strength + aligned structure to fight it.`,
    );
  }

  // 3) The stock's own structure must not oppose the trade.
  if (stockStructure === opposedStructure) {
    return block(`${symbol}'s 15-min structure is ${stockStructure} against a ${direction} — the tap is more likely a break than a bounce.`);
  }

  // 4) Correlated-exposure caps: same-direction stack + sector concentration.
  const strongWith = direction === "call" ? "strong_bull" : "strong_bear";
  if (openSameDir >= 2 && marketBias !== strongWith) {
    return block(`already holding ${openSameDir} ${direction}s — that's one market bet stacked, not new trades.`);
  }
  if (openSameSector >= 2) {
    return block(`already holding ${openSameSector} positions in ${sector} — sector concentration cap.`);
  }

  // Passed. Grade: A when everything aligns, B with one soft conflict.
  const conflicts =
    (withTrade.includes(marketBias) ? 0 : 1) + (stockStructure === alignedStructure ? 0 : 1) + (strongRs ? 0 : 0);
  const grade: Grade = conflicts === 0 ? "A" : "B";
  return {
    allowed: true,
    grade,
    summary: `Intel ${grade}: market ${marketBias}, ${symbol} structure ${stockStructure}, RS ${relStrengthPct >= 0 ? "+" : ""}${relStrengthPct}%, ${openSameDir} open ${direction}s, sector ${sector} x${openSameSector}.`,
    marketBias,
    stockStructure,
    relStrengthPct,
  };
}
