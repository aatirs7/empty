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
import { runStage1, type BacktestableProfileId } from "../src/lib/backtest/engine";
import { buildStage1Report, renderStage1Report } from "../src/lib/backtest/report";

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
    console.log(renderStage1Report(await buildStage1Report(Number(reportId))));
    return;
  }

  const stage = Number(arg("stage") ?? 1);
  if (stage === 2) {
    console.error("Stage 2 is GATED on Stage 1 review (spec §Decision gate). Run and read a Stage 1 report first.");
    process.exitCode = 1;
    return;
  }
  if (stage !== 1) {
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
