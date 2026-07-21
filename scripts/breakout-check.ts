/**
 * SBv2 4H breakout detector — synthetic assertions (npm run breakout:check).
 * Pure math, no DB/network. Exits non-zero on failure.
 */
import "dotenv/config"; // the exit-sim import pulls in the db module (env-checked at load)
import { detectBreakoutsDetailed, DEFAULT_BREAKOUT_OPTIONS } from "../src/lib/breakout";
import type { Zone } from "../src/lib/zones";
import type { Bar } from "../src/lib/alpaca";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const zone = (bottom: number, top: number): Zone => ({ type: "demand", bottom, top, formedAt: "2026-06-01T04:00:00Z", used: false });
const bar = (i: number, o: number, h: number, l: number, c: number): Bar => ({ t: new Date(Date.UTC(2026, 5, 1, 13, 30) + i * 4 * 3600_000).toISOString(), o, h, l, c, v: 1000 });

async function main() {
  const Z = zone(95, 100);

  // 1. Bull breakout: body completely above the zone, no retest yet → CALL at the top boundary.
  {
    const bars = [bar(0, 98, 100, 96, 99), bar(1, 99, 104, 98.5, 103.5), bar(2, 103.5, 106, 102.5, 105)];
    const r = detectBreakoutsDetailed([Z], bars, 105);
    check("bull body-breakout → call at the top boundary", r.breakouts.length === 1 && r.breakouts[0].direction === "call" && r.breakouts[0].boundary === 100, JSON.stringify(r.breakouts[0] ?? r.rejections));
  }
  // 2. Wick-only: high poked above but the body never closed outside → rejected.
  {
    const bars = [bar(0, 98, 100, 96, 99), bar(1, 99, 103, 98, 99.5)];
    const r = detectBreakoutsDetailed([Z], bars, 99.5);
    check("wick beyond the zone without a body close → no setup (wick_only)", r.breakouts.length === 0 && (r.rejections.wick_only ?? 0) > 0, JSON.stringify(r.rejections));
  }
  // 3. Closed back inside after the breakout → cancelled.
  {
    const bars = [bar(0, 99, 104, 98.5, 103.5), bar(1, 103.5, 104, 99, 99.5)];
    const r = detectBreakoutsDetailed([Z], bars, 99.5);
    check("later 4h close back inside → cancelled (closed_back_inside/already_retested)", r.breakouts.length === 0, JSON.stringify(r.rejections));
  }
  // 4. First retest already happened (a later bar's low touched the boundary) → retired.
  {
    const bars = [bar(0, 99, 104, 98.5, 103.5), bar(1, 103.5, 104.5, 99.8, 103.8), bar(2, 103.8, 105, 103, 104.5)];
    const r = detectBreakoutsDetailed([Z], bars, 104.5);
    check("boundary touched after the breakout → retired (already_retested)", r.breakouts.length === 0 && (r.rejections.already_retested ?? 0) > 0, JSON.stringify(r.rejections));
  }
  // 5. Stale: breakout too many completed bars ago without a retest.
  {
    const bars = [bar(0, 99, 104, 98.5, 103.5), ...Array.from({ length: 8 }, (_, i) => bar(i + 1, 103.5, 104.5, 102.5, 104))];
    const r = detectBreakoutsDetailed([Z], bars, 104, { ...DEFAULT_BREAKOUT_OPTIONS, staleBars: 6 });
    check("breakout older than staleBars → stale", r.breakouts.length === 0 && (r.rejections.stale ?? 0) > 0, JSON.stringify(r.rejections));
  }
  // 6. No empty space: another daily zone immediately ahead.
  {
    const ahead = zone(101, 103); // right on top of the boundary
    const bars = [bar(0, 99, 104, 98.5, 103.5)];
    const r = detectBreakoutsDetailed([Z, ahead], bars, 103.5);
    check("daily zone immediately ahead → no_empty_space", r.breakouts.every((b) => b.zone.top !== 100) && (r.rejections.no_empty_space ?? 0) > 0, JSON.stringify(r.rejections));
  }
  // 7. Space mostly consumed: price already traveled most of the gap to the next zone.
  {
    const ahead = zone(110, 112);
    const bars = [bar(0, 99, 108, 98.5, 107.5)];
    const r = detectBreakoutsDetailed([Z, ahead], bars, 108); // traveled 8 of 10 points
    check("price through most of the empty space → space_consumed", r.breakouts.every((b) => b.zone.top !== 100) && (r.rejections.space_consumed ?? 0) > 0, JSON.stringify(r.rejections));
  }
  // 8. Bear breakout: body completely below → PUT at the bottom boundary.
  {
    const bars = [bar(0, 97, 98, 92, 93.5), bar(1, 93.5, 94, 90, 91)];
    const r = detectBreakoutsDetailed([Z], bars, 91);
    check("bear body-breakout → put at the bottom boundary", r.breakouts.length === 1 && r.breakouts[0].direction === "put" && r.breakouts[0].boundary === 95, JSON.stringify(r.breakouts[0] ?? r.rejections));
  }

  // ---- Exit sim (backtest engine — same premium rules as live) --------------
  {
    const t0 = Date.parse("2026-06-01T14:00:00Z"); // 10:00 ET Monday
    const ob = (i: number, o: number, h: number, l: number, c: number) => ({ t: new Date(t0 + i * 15 * 60_000).toISOString(), o, h, l, c, v: 500, vw: (o + c) / 2, n: 100 });
    const b4 = (i: number, c: number): Bar => ({ t: new Date(Date.parse("2026-06-01T12:00:00Z") + i * 4 * 3600_000).toISOString(), o: c, h: c + 1, l: c - 1, c, v: 1000 });
    const spread = (await import("../src/lib/backtest/pricing")).DEFAULT_SPREAD;
    const { simulateBreakoutExit } = await import("../src/lib/backtest/sbv2-breakout");
    const mk = (over: Partial<Parameters<typeof simulateBreakoutExit>[0]>) =>
      simulateBreakoutExit({
        entryAsk: 1.2,
        direction: "call",
        zone: { bottom: 95, top: 100 },
        strike: 102,
        expiry: "2026-06-05",
        entryMs: t0,
        optionBars15: [],
        bars4h: [],
        underlyingDailyCloseAtExpiry: null,
        spread,
        stopLoss: -0.25,
        takeProfit: 1.0,
        catastropheFloor: 0.1,
        catastropheDays: 2,
        ...over,
      });
    // -25% stop on the option's 15m low
    const st = mk({ optionBars15: [ob(0, 1.2, 1.3, 1.1, 1.2), ob(1, 1.2, 1.25, 0.8, 0.95)] });
    check("exit sim: -25% stop fires on the 15m option low", st.exitReason === "stop_-25%", st.exitReason);
    // +100% TP on the option's 15m high
    const tp = mk({ optionBars15: [ob(0, 1.2, 1.4, 1.15, 1.35), ob(1, 1.35, 2.8, 1.3, 2.6)] });
    check("exit sim: +100% take-profit sells at 2x entry", tp.exitReason === "target_+100%" && tp.exitBid === 2.4, `${tp.exitReason} @ ${tp.exitBid}`);
    // 4h close back inside the zone exits before premium rules
    const inv = mk({
      // the second 4h candle completes 20:00Z; the option bar at 20:30Z is the first
      // tradeable print after it — the sim must sell there, not ride on.
      optionBars15: [ob(0, 1.2, 1.3, 1.15, 1.25), ob(26, 1.25, 1.3, 1.2, 1.25)],
      bars4h: [b4(0, 103), b4(1, 99)],
    });
    check("exit sim: 4h close back inside exits", inv.exitReason === "4h_close_back_inside", inv.exitReason);
    // quiet bars to expiry → salvage on expiry day
    const quiet = Array.from({ length: 5 * 26 }, (_, i) => ob(i, 1.2, 1.25, 1.15, 1.2));
    const sal = mk({ optionBars15: quiet });
    check("exit sim: expiry-day salvage fires", sal.exitReason === "expiry_salvage" || sal.exitReason === "data_end", sal.exitReason);
  }

  console.log(failures === 0 ? "\nALL BREAKOUT CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
