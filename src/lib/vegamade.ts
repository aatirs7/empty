/**
 * VegaMade v4 — LIVE (paper) daily shares runner. Claude's own strategy, the one
 * validated edge in the project: long-only fresh-demand-zone dip-buys, gated by a
 * market-regime filter (SPY > its 200-day SMA), exited at a 2R stock target or a
 * zone-break, ~3-week swing. It trades SHARES, not options.
 *
 * This mirrors the backtest (`sbd1-stage2.ts --shares --calls-only --regime`) exactly.
 * Run once daily AFTER the close (the entry is a completed-daily-bar zone tap; the swing
 * plays out over days). PAPER-ONLY — every order goes through getBroker (asserts paper).
 * Off unless the profile's autoExecute is on; supports a dry run for safe testing.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { vegamadePositions } from "../db/schema";
import { getBroker } from "./broker";
import { getMultiStockBars, getStockBars, type Bar } from "./alpaca";
import { evaluateSbd1Simple } from "./sbd1";
import { loadUniverse } from "./scanner";
import { getProfileSettings } from "./profile-settings";

const PROFILE_ID = "vegamade_v1";
const MAX_OPEN = 3; // 2-3 concurrent is the risk-adjusted sweet spot (backtest)
const MAX_NEW_PER_DAY = 2;
const HOLD_SESSIONS = 15; // ~3-week swing time-stop
const SMA_LEN = 200; // regime filter length

export interface VegaMadeResult {
  ranAt: string;
  regimeOk: boolean;
  managed: string[]; // exit actions
  entered: string[]; // entry actions
  skipped: string[]; // notable skips
  dryRun: boolean;
}

/** SPY above its 200-day SMA on the latest completed bar = risk-on (longs allowed). */
async function regimeOn(): Promise<boolean> {
  const spy = await getStockBars("SPY", 400);
  if (spy.length < SMA_LEN + 1) return false;
  const closes = spy.map((b) => b.c);
  const sma = closes.slice(-SMA_LEN).reduce((a, b) => a + b, 0) / SMA_LEN;
  return closes[closes.length - 1] > sma;
}

/** One daily pass: manage open positions first (frees slots), then take new entries. */
export async function runVegaMade(opts: { dryRun?: boolean } = {}): Promise<VegaMadeResult> {
  const dryRun = !!opts.dryRun;
  const broker = getBroker(PROFILE_ID);
  const out: VegaMadeResult = { ranAt: new Date().toISOString(), regimeOk: false, managed: [], entered: [], skipped: [], dryRun };

  // Auto-execute gate (paper-assert lives in the broker). Dry runs bypass the gate.
  if (!dryRun) {
    const settings = await getProfileSettings(PROFILE_ID);
    if (!settings.autoExecute) {
      out.skipped.push("autoExecute is OFF for vegamade_v1 — nothing traded");
      return out;
    }
  }

  // ---- 1. Manage exits on open positions ----------------------------------------
  const open = await db.select().from(vegamadePositions).where(eq(vegamadePositions.status, "open"));
  for (const p of open) {
    let bars: Bar[] = [];
    try {
      bars = await getStockBars(p.symbol, 30);
    } catch {
      continue;
    }
    const last = bars[bars.length - 1];
    if (!last) continue;
    const target = Number(p.target);
    const stop = Number(p.stop);
    const ageSessions = bars.filter((b) => new Date(b.t) > new Date(p.openedAt)).length;
    // Conservative daily management (mirrors the backtest): stop (close through the
    // zone) before target (bar high reaches 2R), then the time-stop.
    let reason = "";
    let exitPx = last.c;
    if (last.c <= stop) {
      reason = "zone_break_stop";
      exitPx = last.c;
    } else if (last.h >= target) {
      reason = "target_2R";
      exitPx = target;
    } else if (ageSessions >= HOLD_SESSIONS) {
      reason = "time_stop";
      exitPx = last.c;
    }
    if (!reason) continue;

    if (dryRun) {
      out.managed.push(`WOULD SELL ${p.shares} ${p.symbol} @~${exitPx.toFixed(2)} (${reason})`);
      continue;
    }
    try {
      const order = await broker.closePosition(p.symbol); // sells the whole equity position
      let fill = exitPx;
      try {
        const f = await broker.waitForFill(order.id, 15000, 1500);
        if (f.filled_avg_price && Number(f.filled_avg_price) > 0) fill = Number(f.filled_avg_price);
      } catch {
        /* keep estimate */
      }
      const pl = Math.round((fill - Number(p.entryPrice)) * p.shares * 100) / 100;
      await db
        .update(vegamadePositions)
        .set({ status: "closed", exitPrice: String(fill), exitAt: new Date(), exitReason: reason, realizedPl: String(pl) })
        .where(eq(vegamadePositions.id, p.id));
      out.managed.push(`SOLD ${p.shares} ${p.symbol} @${fill.toFixed(2)} — ${reason} (${pl >= 0 ? "+" : ""}$${pl})`);
    } catch (e) {
      out.skipped.push(`exit ${p.symbol} failed: ${e instanceof Error ? e.message.slice(0, 80) : "err"}`);
    }
  }

  // ---- 2. Regime gate for NEW entries -------------------------------------------
  out.regimeOk = await regimeOn();
  if (!out.regimeOk) {
    out.skipped.push("regime OFF (SPY below its 200-day SMA) — no new longs, exits only");
    return out;
  }

  // ---- 3. New entries (long only, up to the open + per-day caps) -----------------
  const stillOpen = await db
    .select({ n: sql<string>`count(*)` })
    .from(vegamadePositions)
    .where(eq(vegamadePositions.status, "open"));
  let slots = MAX_OPEN - Number(stillOpen[0]?.n ?? 0);
  if (slots <= 0) {
    out.skipped.push(`at position cap (${MAX_OPEN} open) — no new entries`);
    return out;
  }
  const heldToday = await db
    .select({ sym: vegamadePositions.symbol })
    .from(vegamadePositions)
    .where(eq(vegamadePositions.status, "open"));
  const heldSyms = new Set(heldToday.map((r) => r.sym));

  const universe = (await loadUniverse("sniper_swing")).slice().sort();
  const barsBySym = await getMultiStockBars(universe, 450);
  const acct = await broker.getAccount();
  const equity = Number(acct.equity ?? acct.cash ?? 1000) || 1000;
  const perTrade = equity / MAX_OPEN;

  let newToday = 0;
  for (const sym of universe) {
    if (slots <= 0 || newToday >= MAX_NEW_PER_DAY) break;
    if (heldSyms.has(sym)) continue; // one position per name
    const bars = barsBySym[sym];
    if (!bars || bars.length < 210) continue;
    let evald;
    try {
      evald = evaluateSbd1Simple(bars);
    } catch {
      continue;
    }
    // Long-only: a fresh DEMAND-zone tap (call setup) today.
    const setup = evald.setups.find((s) => s.direction === "call");
    if (!setup) continue;
    const entry = setup.entry;
    const shares = Math.floor(perTrade / entry);
    if (shares < 1) {
      out.skipped.push(`${sym}: share price ${entry} > per-trade budget ${perTrade.toFixed(0)}`);
      continue;
    }

    if (dryRun) {
      out.entered.push(`WOULD BUY ${shares} ${sym} @~${entry.toFixed(2)} · target ${setup.safeTarget} · stop ${setup.invalidation}`);
      slots--;
      newToday++;
      continue;
    }
    try {
      const order = await broker.placeEquityOrder({ symbol: sym, qty: shares, side: "buy" }); // market
      let fill = entry;
      try {
        const f = await broker.waitForFill(order.id, 15000, 1500);
        if (f.filled_avg_price && Number(f.filled_avg_price) > 0) fill = Number(f.filled_avg_price);
      } catch {
        /* keep estimate; the buy is in */
      }
      await db.insert(vegamadePositions).values({
        symbol: sym,
        shares,
        entryPrice: String(fill),
        target: String(setup.safeTarget),
        stop: String(setup.invalidation),
        zoneBottom: String(setup.zone.bottom),
        zoneTop: String(setup.zone.top),
        entryOrderId: order.id,
      });
      out.entered.push(`BOUGHT ${shares} ${sym} @${fill.toFixed(2)} · target ${setup.safeTarget} · stop ${setup.invalidation}`);
      slots--;
      newToday++;
    } catch (e) {
      out.skipped.push(`entry ${sym} failed: ${e instanceof Error ? e.message.slice(0, 80) : "err"}`);
    }
  }
  return out;
}
