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
import { simulateSwingExit } from "./stage2";
import { type OptionBar, type Bar } from "../alpaca";

export interface Sbd1Stage2Config {
  from: string;
  to: string;
  universe?: string[];
  variant?: "precision" | "simple" | "vegamade";
  callsOnly?: boolean; // VegaMade v2 experiment: drop the losing put side
  marketAlign?: boolean; // default true; false = trade both sides regardless of SPY trend (more sample; the underlying exit caps losers)
  shares?: boolean; // VegaMade v3: trade the STOCK (long calls / short puts), NOT options — no theta/spread erosion
  universeProfile?: string; // which seeded universe to load (default sniper_swing = mega-caps; zones_legacy = cheap $5-65)
}

// Nitosphere's SB-D1 contract + exit spec (§6-9).
const BAND = { priceFloor: 0.5, priceIdeal: 0.75, priceCap: 1.0 };
const OTM_PCT = 6; // ATM-ish window so a $0.50-1.00 strike exists on liquid names
const ITM_PCT = 6;
const TP = 1.0; // +100% option take-profit
const SL = -0.25; // -25% option stop
const HOLD_SESSIONS = 2; // ~1-day swing, allow up to 2 sessions

// VegaMade v1's swing contract: a REAL ATM / slightly-ITM option ~2 weeks out (high
// delta, gentle theta) so it actually tracks the ~3-day underlying move. On mega-caps
// that costs whatever it costs (a wide cap so one is always found) — this tests the
// SIGNAL + underlying-exit edge PER CONTRACT, independent of account sizing.
const VEGA_CONTRACT = { priceFloor: 0.5, priceIdeal: 2.5, priceCap: 25.0, otmPct: 2, itmPct: 5, minDays: 10 };

interface Trade {
  symbol: string;
  day: string;
  direction: "call" | "put";
  entryAsk: number;
  exitBid: number;
  plUsd: number; // net of fees, qty 1
  reason: string;
  exitDay?: string; // shares mode: for the account/concurrency sim
  plPct?: number; // shares mode: return on the position (for compounding)
}

/** Account sim for the SHARES strategy: a real $startEquity account holding at most
 *  `maxOpen` positions at once (each sized at 1/maxOpen of current equity), compounding.
 *  Overlapping signals beyond the cap are skipped. Returns the equity curve summary. */
function accountSimShares(trades: Trade[], maxOpen: number, startEquity: number) {
  const evs: { day: string; type: "entry" | "exit"; i: number }[] = [];
  trades.forEach((t, i) => {
    if (t.exitDay == null || t.plPct == null) return;
    evs.push({ day: t.day, type: "entry", i });
    evs.push({ day: t.exitDay, type: "exit", i });
  });
  // Exits before entries on the same day (free the slot first); then by date.
  evs.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.type === "exit" ? -1 : 1));
  let equity = startEquity;
  let peak = startEquity;
  let maxDD = 0;
  const open = new Map<number, number>(); // i -> allocated $
  let taken = 0;
  let skipped = 0;
  for (const e of evs) {
    if (e.type === "entry") {
      if (open.size >= maxOpen) {
        skipped++;
        continue;
      }
      open.set(e.i, equity / maxOpen);
      taken++;
    } else {
      const alloc = open.get(e.i);
      if (alloc == null) continue; // was skipped
      equity += alloc * (trades[e.i].plPct ?? 0);
      open.delete(e.i);
      peak = Math.max(peak, equity);
      maxDD = Math.min(maxDD, (equity - peak) / peak);
    }
  }
  return { endEquity: Math.round(equity), retPct: Math.round(((equity - startEquity) / startEquity) * 1000) / 10, maxDDpct: Math.round(maxDD * 1000) / 10, taken, skipped };
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
  const universe = (cfg.universe?.length ? cfg.universe : await loadUniverse(cfg.universeProfile ?? "sniper_swing")).slice().sort();
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
        if (cfg.callsOnly && s.direction === "put") continue; // VegaMade v2: calls only
        if (variant === "vegamade" && cfg.marketAlign !== false) {
          const aligned = (s.direction === "call" && spyTrend === "bullish") || (s.direction === "put" && spyTrend === "bearish");
          if (!aligned) continue;
        }
        const key = `${sym}|${s.zone.bottom}|${s.zone.top}|${s.type}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // VegaMade v3 (SHARES): trade the underlying, not options — no theta/spread
        // erosion. Long on a call setup, short on a put setup. Exit at the 2R target
        // (limit) or when the stock CLOSES back through the zone (stop); ~3-week swing
        // horizon; small round-trip cost. Fixed $1000 notional for comparable $.
        if (cfg.shares) {
          const bars: Bar[] = [today, ...data.futureBars(sym, 20)];
          const isLong = s.direction === "call";
          const entry = s.entry,
            target = s.safeTarget,
            stop = s.invalidation;
          const riskPct = Math.abs(entry - stop) / entry;
          const lastBar = bars[bars.length - 1];
          let exitPx = lastBar?.c ?? entry;
          let reason = "time_exit";
          let exitDay = lastBar ? barDate(lastBar.t) : day;
          for (let i = 1; i < bars.length; i++) {
            const b = bars[i];
            if (isLong) {
              if (b.c <= stop) { exitPx = b.c; reason = "stop"; exitDay = barDate(b.t); break; } // conservative: close-through stop first
              if (b.h >= target) { exitPx = target; reason = "target"; exitDay = barDate(b.t); break; }
            } else {
              if (b.c >= stop) { exitPx = b.c; reason = "stop"; exitDay = barDate(b.t); break; }
              if (b.l <= target) { exitPx = target; reason = "target"; exitDay = barDate(b.t); break; }
            }
            if (i >= 15) { exitPx = b.c; reason = "time_exit"; exitDay = barDate(b.t); break; }
          }
          const gross = isLong ? (exitPx - entry) / entry : (entry - exitPx) / entry;
          const net = gross - 0.0006; // ~6bps round-trip stock cost (spread + slippage)
          trades.push({ symbol: sym, day, exitDay, plPct: net, direction: s.direction, entryAsk: round2(entry), exitBid: round2(exitPx), plUsd: round2(net * 1000), reason: `${reason}_${(net / (riskPct || 1)).toFixed(1)}R` });
          continue;
        }

        // VegaMade v1 (Claude's experiment) uses a PROPER SWING contract + an
        // UNDERLYING-based exit; simple/precision keep the cheap +100%/-25% spec so
        // the comparison is honest.
        const isVega = variant === "vegamade";
        const band = isVega ? VEGA_CONTRACT : { priceFloor: BAND.priceFloor, priceIdeal: BAND.priceIdeal, priceCap: BAND.priceCap, otmPct: OTM_PCT, itmPct: ITM_PCT, minDays: 1 };
        let sel = null;
        try {
          sel = await selectContractPriceFirst({
            symbol: sym,
            direction: s.direction,
            entryDay: day,
            spot: s.entry,
            otmPct: band.otmPct,
            itmPct: band.itmPct,
            priceFloor: band.priceFloor,
            priceIdeal: band.priceIdeal,
            priceCap: band.priceCap,
            minDays: band.minDays,
            spread,
          });
        } catch {
          sel = null;
        }
        if (!sel) {
          skip(isVega ? "no_swing_contract_in_band" : "no_contract_in_$0.50-1.00_band");
          continue;
        }
        const entryAsk = round2(askOf(sel.entryBar.vw, spread));
        const fees = spread.feePerContractRoundTrip;

        let exitBid: number;
        let reason: string;
        if (isVega) {
          // Sell when the STOCK hits its 2R target; cut when the stock closes back
          // through the zone (setup broke); ride the swing otherwise. NO -25% option
          // stop — that was what killed the cheap version. Catastrophe floor near
          // expiry only. Real option bars from entry to expiry.
          const underlyingBars: Bar[] = [today, ...data.futureBars(sym, 45)];
          const ex = simulateSwingExit({
            entryAsk,
            direction: s.direction,
            target: s.safeTarget,
            zone: { bottom: s.zone.bottom, top: s.zone.top },
            strike: sel.strike,
            expiry: sel.expiry,
            entryDay: day,
            optionBars: sel.bars,
            underlyingBars,
            spread,
            swingStopLoss: null, // underlying-based, no premium stop
            catastropheFloor: 0.15,
            catastropheDays: 3,
          });
          exitBid = ex.exitBid;
          reason = ex.exitReason;
        } else {
          const ex = simulatePremiumExit(entryAsk, sel.bars, day, spread);
          exitBid = ex.exitBid;
          reason = ex.reason;
        }
        trades.push({
          symbol: sym,
          day,
          direction: s.direction,
          entryAsk,
          exitBid: round2(exitBid),
          plUsd: round2((exitBid - entryAsk) * 100 - fees),
          reason,
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

  const vega = variant === "vegamade";
  L.push("=".repeat(72));
  L.push(`SB-D1 ${variant.toUpperCase()} — OPTION-PRICE SIM (real chain, 1 contract)`);
  L.push(`  ${cfg.from} .. ${cfg.to} · ${days} days · ${symbols} symbols${cfg.callsOnly ? " · CALLS ONLY" : ""}${cfg.universeProfile === "zones_legacy" ? " · CHEAP universe" : ""}${cfg.marketAlign === false ? " · no-align" : ""}`);
  L.push(cfg.shares ? "  instrument: SHARES ($1000 notional/trade) · exit: 2R target / close-through-zone stop · ~3wk swing"
        : vega ? "  contract: ATM/slightly-ITM ~2wk swing · exit: stock hits 2R target OR closes back through the zone (no -25% option stop)"
               : "  contract: $0.50-1.00 · exit: +100% / -25% premium, ~1-day hold");
  L.push("=".repeat(72));
  L.push("");
  L.push(`Trades: ${trades.length}   ·   win rate ${trades.length ? Math.round((wins.length / trades.length) * 100) : 0}%   ·   profit factor ${pf ?? "—"}`);
  L.push(`NET (1 contract/trade): ${money(net)}   ·   avg win ${money(wins.length ? grossWin / wins.length : 0)}  vs  avg loss ${money(losses.length ? -grossLoss / losses.length : 0)}`);
  L.push(`Exits: ${Object.entries(byReason).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  if (cfg.shares) {
    L.push("");
    L.push("ACCOUNT SIM (real $1000, compounding, holds N at a time; extra signals skipped):");
    for (const mo of [1, 2, 3]) {
      const a = accountSimShares(trades, mo, 1000);
      L.push(`  max ${mo} open: $1000 → $${a.endEquity} (${a.retPct >= 0 ? "+" : ""}${a.retPct}%) · max DD ${a.maxDDpct}% · took ${a.taken}, skipped ${a.skipped}`);
    }
  }
  L.push("");
  L.push(dir("call"));
  L.push(dir("put"));
  L.push("");
  L.push(`Contract skips (no contract in band on the real chain): ${Object.values(skips).reduce((a,b)=>a+b,0)}`);
  L.push("");
  L.push("NOTES: real historical option bars; spread MODELED (no historical NBBO); stop");
  L.push("checked before target within a day (conservative); entry-day range skipped; 1");
  L.push("contract/trade for a clean per-unit read. In-sample, one window. Not advice.");
  return L.join("\n");
}

const money = (x: number) => `${x < 0 ? "-" : "+"}$${Math.abs(Math.round(x * 100) / 100)}`;
