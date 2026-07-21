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
