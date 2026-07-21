import Link from "next/link";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { backtestRuns } from "@/db/schema";
import { Empty, PageTitle } from "@/components/ui";

export const dynamic = "force-dynamic";

const PROFILE_LABELS: Record<string, string> = { sniper_swing: "SBv1", sbv2: "SBv2" };

// Backtest runs viewer. Runs are LAUNCHED from the terminal (a full replay takes
// minutes — far beyond a serverless request); this page reads their results.
export default async function BacktestPage() {
  const runs = await db.select().from(backtestRuns).orderBy(desc(backtestRuns.id)).limit(50);

  return (
    <div className="space-y-5">
      <PageTitle title="Backtest" subtitle="Replay a strategy against history — signals, hit rates, honesty checks" />

      <div className="bg-panel border border-border rounded-2xl px-4 py-3 text-xs text-muted space-y-1">
        <p>
          Runs are launched from the terminal, not from the app (a replay takes minutes):
        </p>
        <p className="num text-foreground/80">npm run backtest -- --profile SBv2 --from 2026-04-01 --to 2026-07-01 --stage 1</p>
        <p>
          Stage 1 tests whether the setup predicts the <span className="text-foreground/80">stock</span> at all — no options, no fills.
          Stage 2 (options P&amp;L) is gated on a Stage 1 review.
        </p>
      </div>

      {runs.length === 0 ? (
        <Empty>No backtest runs yet.</Empty>
      ) : (
        <div className="space-y-2.5">
          {runs.map((r) => {
            const summary = (r.metrics as { summary?: { hitRateAll?: number | null } } | null)?.summary;
            const hit = summary?.hitRateAll != null ? `${Math.round(summary.hitRateAll * 1000) / 10}% hit` : null;
            return (
              <Link
                key={r.id}
                href={`/backtest/${r.id}`}
                className="block bg-panel border border-border rounded-2xl px-4 py-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm">
                    {PROFILE_LABELS[r.profileId] ?? r.profileId} · Stage {r.stage}
                    <span className="text-muted"> · run #{r.id}</span>
                  </span>
                  <span className={`text-xs ${r.status === "complete" ? "text-up" : r.status === "failed" ? "text-down" : "text-muted"}`}>
                    {r.status}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between text-xs text-muted num">
                  <span>
                    {r.fromDate} → {r.toDate} · {r.signalCount ?? "—"} signals{hit ? ` · ${hit}` : ""}
                  </span>
                  <span>variant #{r.windowVariantCount}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
