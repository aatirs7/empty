/**
 * Backtest CLI (vega-backtest-spec.md).
 *
 *   npm run backtest -- --profile SBv2 --from 2026-04-01 --to 2026-07-01 --stage 1
 *   npm run backtest -- --report 3            (re-render an existing run, no replay)
 *
 * Flags: --profile SBv1|sniper_swing|SBv2|sbv2 · --from/--to YYYY-MM-DD ·
 *        --stage 1 · --universe AAPL,MSFT,... · --seed <str> · --label <str>
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { backtestRuns } from "../src/db/schema";
import { runStage1, type BacktestableProfileId } from "../src/lib/backtest/engine";
import { runStage2 } from "../src/lib/backtest/stage2";
import { buildStage1Report, renderStage1Report, buildStage2Report, renderStage2Report } from "../src/lib/backtest/report";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const PROFILE_ALIASES: Record<string, string> = {
  sbv1: "sniper_swing",
  sniper_swing: "sniper_swing",
  sbv2: "sbv2",
  qqq_manual: "qqq_manual",
  qqq_0dte: "qqq_0dte",
};

async function main() {
  const reportId = arg("report");
  if (reportId) {
    const [row] = await db.select({ stage: backtestRuns.stage }).from(backtestRuns).where(eq(backtestRuns.id, Number(reportId)));
    if (row?.stage === 2) console.log(renderStage2Report(await buildStage2Report(Number(reportId))));
    else console.log(renderStage1Report(await buildStage1Report(Number(reportId))));
    return;
  }

  const stage = Number(arg("stage") ?? 1);
  if (stage !== 1 && stage !== 2) {
    console.error(`unknown stage ${stage}`);
    process.exitCode = 1;
    return;
  }

  const rawProfile = (arg("profile") ?? "").toLowerCase();
  const profileId = PROFILE_ALIASES[rawProfile];
  if (!profileId) {
    console.error("usage: npm run backtest -- --profile SBv1|SBv2 --from YYYY-MM-DD --to YYYY-MM-DD --stage 1");
    process.exitCode = 1;
    return;
  }
  if (profileId === "qqq_manual") {
    console.error("qqq_manual cannot be honestly backtested: the owner-entered levels have no historical record, and substituting today's levels would be lookahead. (spec §Manual levels)");
    process.exitCode = 1;
    return;
  }
  if (profileId === "qqq_0dte") {
    console.error("qqq_0dte needs intraday-granularity replay (not built; profile shelved).");
    process.exitCode = 1;
    return;
  }

  const from = arg("from");
  const to = arg("to");
  if (!from || !to) {
    console.error("--from and --to (YYYY-MM-DD) are required");
    process.exitCode = 1;
    return;
  }
  const universe = arg("universe")?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

  if (stage === 2) {
    if (profileId !== "sbv2") {
      console.error("Stage 2 currently supports SBv2 only (price-first contract path). SBv1's EV-path Stage 2 is a follow-up.");
      process.exitCode = 1;
      return;
    }
    console.log("NOTE (spec decision gate): Stage 1 on this window showed weak/no underlying edge for SBv2 —");
    console.log("Stage 2 quantifies what that costs in option P&L; it cannot rescue the signal.");
    console.log(`Stage 2 options sim: ${profileId} ${from}..${to} (real historical chains + modeled spread)...`);
    const res2 = await runStage2({ profileId: "sbv2", from, to, universe, seed: arg("seed"), label: arg("label") });
    console.log(`Simulated ${res2.trades.length} trades from ${res2.signalCount} signals (run #${res2.runId}, config ${res2.configHash}).`);
    console.log("");
    console.log(renderStage2Report(await buildStage2Report(res2.runId)));
    return;
  }

  console.log(`Stage 1 replay: ${profileId} ${from}..${to} (daily granularity)...`);
  const res = await runStage1({
    profileId: profileId as BacktestableProfileId,
    from,
    to,
    granularity: "daily",
    universe,
    seed: arg("seed"),
    label: arg("label"),
  });
  console.log(`Replayed ${res.days} trading days × ${res.symbols} symbols → ${res.signalCount} signals (run #${res.runId}, config ${res.configHash}, variant #${res.windowVariantCount} of this window).`);
  if (res.runId != null) {
    console.log("");
    console.log(renderStage1Report(await buildStage1Report(res.runId)));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
