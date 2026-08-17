/**
 * SB-D1 OPTION-PRICE sim (the "real dollars" stage). Takes the SB-D1 daily-zone-tap
 * signals (any variant: precision / simple / vegamade), buys a $0.50-1.00 contract
 * from the REAL historical option chain, and simulates the spec's premium exit
 * (+100% take-profit / -25% stop, ~1-2 day hold). Reuses the shared pricing layer
 * (real option bars + modeled spread) — the same machinery SBv2's Stage 2 uses.
 *
 * Honest limits (same as every option backtest here): historical NBBO is unavailable
 * so the spread is MODELED (DEFAULT_SPREAD in pricing.ts); within-day ordering is
 * unknowable at daily granularity, so the stop is checked before the target
 * (conservative). In-sample, one window.
 */
import { loadUniverse } from "../scanner";
import { PointInTimeData } from "./data";
import { tradingDaysFromBars, barDate } from "./clock";
import { evaluateSbd1, evaluateSbd1Simple, classifyTrend } from "../sbd1";
import { selectContractPriceFirst, askOf, bidOf, DEFAULT_SPREAD, type SpreadConfig } from "./pricing";
import { type OptionBar } from "../alpaca";

export interface Sbd1Stage2Config {
  from: string;
  to: string;
  universe?: string[];
  variant?: "precision" | "simple" | "vegamade";
}

// Nitosphere's SB-D1 contract + exit spec (§6-9).
const BAND = { priceFloor: 0.5, priceIdeal: 0.75, priceCap: 1.0 };
const OTM_PCT = 6; // ATM-ish window so a $0.50-1.00 strike exists on liquid names
const ITM_PCT = 6;
const TP = 1.0; // +100% option take-profit
const SL = -0.25; // -25% option stop
const HOLD_SESSIONS = 2; // ~1-day swing, allow up to 2 sessions

interface Trade {
  symbol: string;
  day: string;
  direction: "call" | "put";
  entryAsk: number;
  exitBid: number;
  plUsd: number; // net of fees, qty 1
  reason: string;
}

/** Premium exit against REAL option bars: +100% TP / -25% SL / time exit. Skips the
 *  entry day (its high/low can predate the fill); stop checked before target. */
function simulatePremiumExit(entryAsk: number, optionBars: OptionBar[], entryDay: string, spread: SpreadConfig): { exitBid: number; reason: string } {
  const tpBid = entryAsk * (1 + TP);
  const slBid = entryAsk * (1 + SL);
  const after = optionBars.filter((b) => barDate(b.t) > entryDay).slice(0, HOLD_SESSIONS);
  let lastBid = bidOf(entryAsk, spread);
  for (const ob of after) {
    lastBid = bidOf(ob.c, spread);
    if (bidOf(ob.l, spread) <= slBid) return { exitBid: Math.max(0.01, slBid * (1 - spread.stopSlippagePct)), reason: "stop_-25%" };
    if (bidOf(ob.h, spread) >= tpBid) return { exitBid: tpBid, reason: "target_+100%" };
  }
  return { exitBid: lastBid, reason: "time_exit" }; // held out the window
}

export async function runSbd1Stage2(cfg: Sbd1Stage2Config): Promise<string> {
  const variant = cfg.variant ?? "vegamade";
  const evaluate = variant === "precision" ? evaluateSbd1 : evaluateSbd1Simple;
  const universe = (cfg.universe?.length ? cfg.universe : await loadUniverse("sniper_swing")).slice().sort();
  if (universe.length === 0) throw new Error("SB-D1 Stage 2: empty universe.");

  const data = await PointInTimeData.load({ symbols: [...universe, "SPY", "QQQ"], from: cfg.from, to: cfg.to });
  const days = tradingDaysFromBars(data.allBars("SPY"), cfg.from, cfg.to);
  const spread = DEFAULT_SPREAD;
  const trades: Trade[] = [];
  const skips: Record<string, number> = {};
  const skip = (k: string) => (skips[k] = (skips[k] ?? 0) + 1);
  const seen = new Set<string>();

  for (const day of days) {
    data.advanceTo(day);
    const view = data.view();
    const spyTrend = variant === "vegamade" ? classifyTrend(view.bars("SPY")) : null;
    for (const sym of universe) {
      const today = data.todayBar(sym);
      if (!today) continue;
      let evald;
      try {
        evald = evaluate([...view.bars(sym), today]);
      } catch {
        continue;
      }
      for (const s of evald.setups) {
        if (variant === "vegamade") {
          const aligned = (s.direction === "call" && spyTrend === "bullish") || (s.direction === "put" && spyTrend === "bearish");
          if (!aligned) continue;
        }
        const key = `${sym}|${s.zone.bottom}|${s.zone.top}|${s.type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Select a $0.50-1.00 contract from the real chain (short weekly, >=1 day out).
        let sel = null;
        try {
          sel = await selectContractPriceFirst({
            symbol: sym,
            direction: s.direction,
            entryDay: day,
            spot: s.entry,
            otmPct: OTM_PCT,
            itmPct: ITM_PCT,
            priceFloor: BAND.priceFloor,
            priceIdeal: BAND.priceIdeal,
            priceCap: BAND.priceCap,
            minDays: 1,
            spread,
          });
        } catch {
          sel = null;
        }
        if (!sel) {
          skip("no_contract_in_$0.50-1.00_band");
          continue;
        }
        const entryAsk = round2(askOf(sel.entryBar.vw, spread));
        const exit = simulatePremiumExit(entryAsk, sel.bars, day, spread);
        const fees = spread.feePerContractRoundTrip;
        trades.push({
          symbol: sym,
          day,
          direction: s.direction,
          entryAsk,
          exitBid: round2(exit.exitBid),
          plUsd: round2((exit.exitBid - entryAsk) * 100 - fees),
          reason: exit.reason,
        });
      }
    }
  }
  return render(cfg, variant, universe.length, days.length, trades, skips);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function render(cfg: Sbd1Stage2Config, variant: string, symbols: number, days: number, trades: Trade[], skips: Record<string, number>): string {
  const L: string[] = [];
  const wins = trades.filter((t) => t.plUsd > 0);
  const losses = trades.filter((t) => t.plUsd <= 0);
  const net = round2(trades.reduce((s, t) => s + t.plUsd, 0));
  const grossWin = wins.reduce((s, t) => s + t.plUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.plUsd, 0));
  const pf = grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : null;
  const byReason: Record<string, number> = {};
  for (const t of trades) byReason[t.reason] = (byReason[t.reason] ?? 0) + 1;
  const dir = (d: "call" | "put") => {
    const g = trades.filter((t) => t.direction === d);
    const w = g.filter((t) => t.plUsd > 0).length;
    const n = round2(g.reduce((s, t) => s + t.plUsd, 0));
    return `${d}s: ${g.length} trades · win ${g.length ? Math.round((w / g.length) * 100) : 0}% · net ${money(n)}`;
  };

  L.push("=".repeat(72));
  L.push(`SB-D1 ${variant.toUpperCase()} — OPTION-PRICE SIM (real chain, +100%/-25% premium exit, 1 contract)`);
  L.push(`  window: ${cfg.from} .. ${cfg.to}  ·  ${days} days  ·  ${symbols} symbols  ·  contract $0.50-1.00`);
  L.push("=".repeat(72));
  L.push("");
  L.push(`Trades: ${trades.length}   ·   win rate ${trades.length ? Math.round((wins.length / trades.length) * 100) : 0}%   ·   profit factor ${pf ?? "—"}`);
  L.push(`NET (1 contract/trade): ${money(net)}   ·   avg win ${money(wins.length ? grossWin / wins.length : 0)}  vs  avg loss ${money(losses.length ? -grossLoss / losses.length : 0)}`);
  L.push(`Exits: ${Object.entries(byReason).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  L.push("");
  L.push(dir("call"));
  L.push(dir("put"));
  L.push("");
  L.push(`Contract skips (no $0.50-1.00 strike on the real chain): ${skips["no_contract_in_$0.50-1.00_band"] ?? 0}`);
  L.push("");
  L.push("NOTES: real historical option bars; spread MODELED (no historical NBBO); stop");
  L.push("checked before target within a day (conservative); entry-day range skipped; 1");
  L.push("contract/trade for a clean per-unit read. In-sample, one window. Not advice.");
  return L.join("\n");
}

const money = (x: number) => `${x < 0 ? "-" : "+"}$${Math.abs(Math.round(x * 100) / 100)}`;
