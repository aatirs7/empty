/**
 * Backtest self-test (vega-backtest-spec.md: anti-lookahead is THE correctness
 * property — test it deliberately). Assertion script; exits non-zero on failure.
 *
 *   npm run backtest:selftest            (fast checks only)
 *   npm run backtest:selftest -- --full  (adds the 2-symbol determinism replay)
 */
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BACKTEST_DIR = join(process.cwd(), "src", "lib", "backtest");
import { db } from "../src/db";
import { reactions } from "../src/db/schema";
import { and, eq, lte, sql } from "drizzle-orm";
import { queryReactions, forwardWindowMs } from "../src/lib/reactions";
import { computeZones, DEFAULT_ZONE_OPTIONS } from "../src/lib/zones";
import { walkForward } from "../src/lib/backtest/outcomes";
import { PointInTimeData, BacktestLookaheadError } from "../src/lib/backtest/data";
import { tradingDaysFromBars, sessionCloseUtc } from "../src/lib/backtest/clock";
import { hashConfig, mulberry32 } from "../src/lib/backtest/random";
import { runStage1 } from "../src/lib/backtest/engine";
import { getStockBars, type Bar } from "../src/lib/alpaca";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/** Synthetic daily bars: gentle drift + one engineered displacement candle. */
function syntheticBars(n: number, dispAt: number): Bar[] {
  const bars: Bar[] = [];
  let px = 100;
  const rng = mulberry32(42);
  for (let i = 0; i < n; i++) {
    const day = new Date(Date.UTC(2025, 0, 2) + i * 86_400_000).toISOString();
    let o = px;
    let c = px + (rng() - 0.5) * 0.8;
    if (i === dispAt - 1) {
      c = o - 0.5; // bearish candle before the impulse (demand-zone precursor)
    } else if (i === dispAt) {
      c = o + 12; // huge bullish displacement (>> 1.7x ATR)
    }
    const h = Math.max(o, c) + 0.3;
    const l = Math.min(o, c) - 0.3;
    bars.push({ t: day, o, h, l, c, v: 1_000_000 + Math.floor(rng() * 100_000) });
    px = c;
  }
  return bars;
}

async function main() {
  const full = process.argv.includes("--full");

  // ---- 1. Isolation grep: backtest code never imports the broker/executor/live trade tables.
  {
    const dir = BACKTEST_DIR;
    const banned = [/from "\.\.\/broker"/, /from "\.\.\/execute"/, /placeOptionOrder/, /\borders\b.*from "..\/..\/db\/schema"/, /proposals/, /shadowOutcomes/];
    let clean = true;
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const re of banned) {
        if (re.test(src)) {
          clean = false;
          console.log(`  isolation violation in ${f}: ${re}`);
        }
      }
    }
    check("isolation: no broker/execute/live-trade-table imports in src/lib/backtest", clean);
  }

  // ---- 2. Zone-formation timing (the spec's called-out leakage point): a zone
  // formed at bar X must NOT exist when only bars[0..X-1] are visible.
  {
    const bars = syntheticBars(120, 80);
    const withX = computeZones(bars.slice(0, 81), DEFAULT_ZONE_OPTIONS); // includes displacement bar 80
    const withoutX = computeZones(bars.slice(0, 80), DEFAULT_ZONE_OPTIONS);
    const formedAt = bars[80].t;
    const inWith = withX.zones.some((z) => z.formedAt === formedAt);
    const inWithout = withoutX.zones.some((z) => z.formedAt === formedAt);
    check("zone forms ONLY once its displacement candle has closed", inWith && !inWithout, `visible-after=${inWith} visible-before=${inWithout}`);
  }

  // ---- 3. Deliberate future read against the reactions DB (spec-mandated).
  {
    const probe = { symbol: "AAPL", timeframe: "daily", direction: "call" as const, approach: "from_above", spot: 200 };
    const unfiltered = await queryReactions(probe);
    const ancient = await queryReactions({ ...probe, asOf: new Date("1990-01-01T00:00:00Z") });
    check("asOf predating all rows returns n=0 (filter live at the source)", ancient.n === 0 && unfiltered.n > 0, `unfiltered n=${unfiltered.n}, ancient n=${ancient.n}`);

    const asOf = new Date("2026-01-01T00:00:00Z");
    const cutoff = new Date(asOf.getTime() - forwardWindowMs("daily"));
    const filtered = await queryReactions({ ...probe, asOf });
    // Independent count with the same cutoff, matching the tier the query landed in.
    const tierWhere =
      filtered.bucket === "all-symbols"
        ? and(eq(reactions.timeframe, "daily"), eq(reactions.approach, "from_above"), lte(reactions.tappedAt, cutoff))
        : and(eq(reactions.symbol, "AAPL"), eq(reactions.timeframe, "daily"), eq(reactions.approach, "from_above"), lte(reactions.tappedAt, cutoff));
    const [{ c }] = await db.select({ c: sql<number>`count(*)::int` }).from(reactions).where(tierWhere);
    check("asOf-filtered n matches an independent SQL count with the same cutoff", filtered.n === c, `stats n=${filtered.n}, sql count=${c} (bucket=${filtered.bucket})`);
  }

  // ---- 4. Point-in-time layer: bar visibility + monotonic clock + narrowed view.
  {
    const spy = await getStockBars("SPY", 120);
    if (spy.length < 40) {
      check("point-in-time layer (needs SPY bars)", false, "could not fetch SPY bars");
    } else {
      const days = spy.map((b) => b.t.slice(0, 10));
      const midDay = days[Math.floor(days.length / 2)];
      const data = await PointInTimeData.load({ symbols: ["SPY"], from: midDay, to: days[days.length - 1], lookbackDays: 200, forwardPadDays: 0 });
      data.advanceTo(midDay);
      const visible = data.bars("SPY");
      const allBefore = visible.every((b) => b.t.slice(0, 10) < midDay);
      check("bars() serves only bars strictly before the current day", allBefore && visible.length > 0, `${visible.length} bars, last=${visible.at(-1)?.t}`);

      const windowed = data.bars("SPY", 30);
      check("bars(sym, windowDays) trims the left edge only", windowed.length < visible.length && windowed.at(-1)?.t === visible.at(-1)?.t);

      let threw = false;
      try {
        data.advanceTo(days[2]); // rewind
      } catch (e) {
        threw = e instanceof BacktestLookaheadError;
      }
      check("advanceTo backwards throws BacktestLookaheadError", threw);

      const view = data.view() as unknown as Record<string, unknown>;
      check("StrategyView has no todayBar/futureBars/allBars at runtime", !("todayBar" in view) && !("futureBars" in view) && !("allBars" in view));

      const today = data.todayBar("SPY");
      check("todayBar (engine-only) returns the current day's bar", today == null || today.t.slice(0, 10) === data.currentDay());

      const tdays = tradingDaysFromBars(spy, days[0], days[days.length - 1]);
      check("tradingDaysFromBars covers the SPY bar dates", tdays.length === new Set(days).size);
      const close = sessionCloseUtc("2026-07-01"); // EDT → 20:00Z
      check("sessionCloseUtc is 16:00 ET (DST-aware)", close.toISOString() === "2026-07-01T20:00:00.000Z", close.toISOString());
    }
  }

  // ---- 5. walkForward: tie rule, target/invalidation ordering, fixed horizons.
  {
    const mk = (o: number, h: number, l: number, c: number, i: number): Bar => ({ t: new Date(Date.UTC(2026, 0, 5) + i * 86_400_000).toISOString(), o, h, l, c, v: 1 });
    const zone = { bottom: 95, top: 100 };
    // call, entry 100, target 110
    const hitFirst = walkForward(100, "call", 110, zone, [mk(100, 105, 99, 104, 0), mk(104, 111, 103, 108, 1), mk(108, 109, 90, 92, 2)]);
    check("walkForward: target before later invalidation → hit", hitFirst.targetHit && hitFirst.barsToTarget === 2 && !hitFirst.invalidatedFirst);
    const invFirst = walkForward(100, "call", 110, zone, [mk(100, 101, 93, 94, 0), mk(94, 111, 93, 108, 1)]);
    check("walkForward: invalidation (close < zone.bottom) before target → miss", !invFirst.targetHit && invFirst.invalidated && invFirst.invalidatedAtBar === 1 && invFirst.targetTouched);
    const tie = walkForward(100, "call", 110, zone, [mk(100, 112, 92, 93, 0)]);
    check("walkForward: same-bar tie → invalidation wins, tie recorded", !tie.targetHit && tie.tie && tie.invalidated);
    const trunc = walkForward(100, "call", 110, zone, [mk(100, 101, 99, 100.5, 0)]);
    check("walkForward: short window → truncated, ret1d only", trunc.outcomeStatus === "truncated" && trunc.ret1d != null && trunc.ret5d == null);
    const putHit = walkForward(100, "put", 90, zone, [mk(100, 101, 89, 95, 0)]);
    check("walkForward: put target via low", putHit.targetHit && putHit.barsToTarget === 1);
  }

  // ---- 5b. Stage 2 exit sim (synthetic option + underlying bars).
  {
    const { simulateSwingExit } = await import("../src/lib/backtest/stage2");
    const { DEFAULT_SPREAD, occSymbol, pickFridayExpiry, strikeGrid } = await import("../src/lib/backtest/pricing");
    const day = (i: number) => new Date(Date.UTC(2026, 5, 1) + i * 86_400_000).toISOString(); // Jun 1 2026 = Monday
    const ub = (i: number, o: number, h: number, l: number, c: number): Bar => ({ t: day(i), o, h, l, c, v: 1 });
    const ob = (i: number, o: number, h: number, l: number, c: number, vw: number) => ({ ...ub(i, o, h, l, c), vw, n: 100, v: 500 });
    const base = {
      entryAsk: 0.6,
      direction: "call" as const,
      target: 110,
      zone: { bottom: 95, top: 100 },
      strike: 105,
      expiry: "2026-06-05",
      entryDay: "2026-06-01",
      spread: DEFAULT_SPREAD,
      swingStopLoss: -0.5,
      catastropheFloor: 0.1,
      catastropheDays: 2,
    };
    // stop: day-2 option low collapses through -50% of the 0.60 entry
    const stop = simulateSwingExit({ ...base, optionBars: [ob(0, 0.6, 0.7, 0.5, 0.6, 0.6), ob(1, 0.55, 0.6, 0.1, 0.2, 0.3)], underlyingBars: [ub(0, 101, 102, 100, 101), ub(1, 101, 101.5, 96, 97)] });
    check("stage2: -50% stop fires on the option's intraday low (not entry day)", stop.exitReason === "stop_-50%" && stop.exitDay === "2026-06-02", `${stop.exitReason}@${stop.exitDay} bid=${stop.exitBid}`);
    // invalidation: day-1 underlying CLOSES below zone.bottom → sold on day 2
    const inv = simulateSwingExit({ ...base, optionBars: [ob(0, 0.6, 0.7, 0.5, 0.6, 0.6), ob(1, 0.5, 0.6, 0.4, 0.45, 0.5), ob(2, 0.4, 0.5, 0.35, 0.4, 0.42)], underlyingBars: [ub(0, 101, 102, 100, 101), ub(1, 100, 100.5, 94, 94.5), ub(2, 94, 96, 93, 95)] });
    check("stage2: swing invalidation sells the day AFTER the close-through", inv.exitReason === "swing_invalidation" && inv.exitDay === "2026-06-03");
    // target: underlying touches 110 on day 1 → sold at that day's option vwap bid
    const tgt = simulateSwingExit({ ...base, optionBars: [ob(0, 0.6, 0.7, 0.5, 0.6, 0.6), ob(1, 0.9, 2.5, 0.8, 2.0, 1.6)], underlyingBars: [ub(0, 101, 102, 100, 101), ub(1, 102, 110.5, 101, 108)] });
    check("stage2: target-touch exits at the day's real vwap (bid side)", tgt.exitReason === "target" && tgt.exitDay === "2026-06-02" && tgt.exitBid > 1.2, `bid=${tgt.exitBid}`);
    // salvage: nothing hits → sold with <=1 day to expiry
    const sal = simulateSwingExit({ ...base, target: 200, optionBars: [0, 1, 2, 3].map((i) => ob(i, 0.6, 0.65, 0.55, 0.6, 0.6)), underlyingBars: [0, 1, 2, 3].map((i) => ub(i, 101, 102, 100, 101)) });
    check("stage2: expiry salvage fires at <=1 day to expiry", sal.exitReason === "expiry_salvage" && sal.exitDay === "2026-06-04");
    // pricing helpers
    check("stage2: OCC symbol format", occSymbol("AMD", "2026-04-24", "call", 92.5) === "AMD260424C00092500", occSymbol("AMD", "2026-04-24", "call", 92.5));
    check("stage2: friday expiry >= entry+2d", pickFridayExpiry("2026-06-04", 2) === "2026-06-12"); // Thu tap -> NEXT Friday
    check("stage2: strike grid spans the window", strikeGrid(100, "call", 25, 4).length > 10);
  }

  // ---- 5c. Intraday two-contract ladder sim (SB 15M) — synthetic 15m bars.
  {
    const { simulateLadder, etMinutesAt } = await import("../src/lib/backtest/intraday");
    const { DEFAULT_SPREAD } = await import("../src/lib/backtest/pricing");
    // 2026-06-01 is a Monday; 13:30Z = 9:30 ET (EDT).
    const t0 = Date.parse("2026-06-01T14:00:00Z"); // 10:00 ET
    const ob = (i: number, o: number, h: number, l: number, c: number) => ({ t: new Date(t0 + i * 15 * 60_000).toISOString(), o, h, l, c, v: 500, vw: (o + c) / 2, n: 100 });
    const ub = (i: number, o: number, h: number, l: number, c: number) => ({ t: new Date(t0 + i * 15 * 60_000).toISOString(), o, h, l, c, v: 1 });
    const zone = { bottom: 98, top: 100 };
    const base = { entryAsk: 1.0, qty: 2, direction: "call" as const, zone, entryMs: t0, spread: DEFAULT_SPREAD, stopLoss: -0.2, trim1Pct: 0.5, runnerTakeProfit: 0.75 };

    // T1 then breakeven stop: bar 1 spikes to +50% -> trim 1 + stop->breakeven; bar 2 dips to entry -> runner out at breakeven.
    const a = simulateLadder({ ...base, optionBars: [ob(0, 1, 1.1, 0.95, 1.05), ob(1, 1.05, 1.8, 1.05, 1.6), ob(2, 1.6, 1.65, 0.9, 1.0)], underlying15: [ub(0, 100.5, 101, 100, 100.8), ub(1, 100.8, 103, 100.8, 102.5), ub(2, 102.5, 102.6, 100.2, 100.4)] });
    check("ladder: T1 sells 1 at +50%, runner exits at BREAKEVEN stop", a.t1Hit && !a.t2Hit && a.breakevenExit && a.sells.length === 2 && a.exitReason === "breakeven_stop", JSON.stringify(a.sells));
    // Full win: T1 then T2.
    const b = simulateLadder({ ...base, optionBars: [ob(0, 1, 1.8, 1, 1.7), ob(1, 1.7, 2.2, 1.6, 2.0)], underlying15: [ub(0, 100.5, 103, 100.4, 102.9), ub(1, 102.9, 104, 102.8, 103.8)] });
    check("ladder: T1 + runner take-profit at +75%", b.t1Hit && b.t2Hit && b.plUsd > 100, `pl=${b.plUsd}`);
    // Straight stop: -20% on the option low sells BOTH.
    const c = simulateLadder({ ...base, optionBars: [ob(0, 1, 1.05, 0.6, 0.7)], underlying15: [ub(0, 100.5, 100.6, 99.2, 99.4)] });
    check("ladder: -20% stop sells everything (stopOut)", c.stopOut && !c.t1Hit && c.exitReason === "stop_-20%" && c.plUsd < 0);
    // Structural invalidation: underlying 15m close through the zone.
    const d = simulateLadder({ ...base, optionBars: [ob(0, 1, 1.1, 0.95, 1.0), ob(1, 1.0, 1.05, 0.9, 0.95)], underlying15: [ub(0, 100.5, 100.8, 99.9, 100.2), ub(1, 100.2, 100.3, 97.4, 97.6)] });
    check("ladder: 15m close through the zone flattens", d.exitReason === "15m_invalidation" && !d.stopOut);
    // EOD flatten: quiet bars until 15:35 ET.
    const bars = Array.from({ length: 24 }, (_, i) => ob(i, 1, 1.1, 0.95, 1.02));
    const ubs = Array.from({ length: 24 }, (_, i) => ub(i, 100.5, 100.8, 100.2, 100.6));
    const e = simulateLadder({ ...base, optionBars: bars, underlying15: ubs });
    check("ladder: end-of-day flatten fires (~15:35 ET)", e.exitReason === "eod_flatten", e.exitReason);
    check("etMinutesAt: 14:00Z on 2026-06-01 = 10:00 ET", etMinutesAt(t0) === 600, String(etMinutesAt(t0)));
  }

  // ---- 6. Determinism helpers.
  {
    const a = hashConfig({ b: 2, a: [1, { z: 1, y: 2 }] });
    const b = hashConfig({ a: [1, { y: 2, z: 1 }], b: 2 });
    check("hashConfig is key-order independent", a === b, a);
    const r1 = mulberry32(123);
    const r2 = mulberry32(123);
    check("mulberry32 deterministic", [r1(), r1(), r1()].join() === [r2(), r2(), r2()].join());
  }

  // ---- 7. Full determinism replay (2 symbols, ~1 month, dryRun — no writes).
  if (full) {
    const cfg = { profileId: "sbv2" as const, from: "2026-05-01", to: "2026-05-29", granularity: "daily" as const, universe: ["AAPL", "AMD"], dryRun: true };
    const a = await runStage1(cfg);
    const b = await runStage1(cfg);
    const eq1 = JSON.stringify(a.signals) === JSON.stringify(b.signals);
    const eq2 = JSON.stringify(a.baselines) === JSON.stringify(b.baselines);
    check("runStage1 dryRun twice → identical signals + baselines", eq1 && eq2, `${a.signalCount} signals, hash ${a.configHash}`);
  } else {
    console.log("skip  full determinism replay (pass --full)");
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
