import Link from "next/link";
import { getRunsLog } from "@/lib/queries";
import { getAllApiCost } from "@/lib/cost";
import { usd, labelStrategy, stripDash, etTime } from "@/lib/format";
import { Empty, PageTitle } from "@/components/ui";
import LogStatus from "@/components/LogStatus";
import ProfileTabs from "@/components/ProfileTabs";
import { resolveUiProfile } from "@/lib/ui-profiles";

export const dynamic = "force-dynamic";

export default async function LogPage({ searchParams }: { searchParams: Promise<{ profile?: string }> }) {
  const sp = await searchParams;
  const profileId = resolveUiProfile(sp.profile);
  const [allRuns, cost] = await Promise.all([getRunsLog(40), getAllApiCost()]);

  // Filter each run to the selected profile's proposals (+ their orders). Scan
  // runs cover all profiles and have no proposals, so keep them regardless.
  const runs = allRuns
    .map((r) => {
      const rp = r.proposals.filter((p) => p.profileId === profileId);
      const keepIds = new Set(rp.map((p) => p.id));
      return { run: r.run, proposals: rp, orders: r.orders.filter((o) => keepIds.has(o.proposalId)) };
    })
    .filter((r) => r.run.model === "scan" || r.proposals.length > 0)
    .slice(0, 30);

  return (
    <div className="space-y-5">
      <PageTitle title="Log" subtitle={`Month-to-date cost ${usd(cost.monthToDate)}`} />

      <ProfileTabs />

      <LogStatus />

      {runs.length === 0 ? (
        <Empty>No runs yet.</Empty>
      ) : (
        <div className="space-y-2.5">
          {runs.map(({ run, proposals, orders }) => (
            <details key={run.id} className="bg-panel border border-border rounded-2xl px-4 py-3">
              <summary className="flex items-center justify-between cursor-pointer list-none">
                <span className="text-sm num">
                  Run #{run.id} · {run.runDate} · {etTime(run.createdAt)}{" "}
                  <span className={run.status === "complete" ? "text-muted" : "text-down"}>({run.status})</span>
                </span>
                <span className="text-xs text-muted num">{proposals.length} {proposals.length === 1 ? "signal" : "signals"}</span>
              </summary>
              <div className="mt-3 space-y-2">
                {run.marketContext && <p className="text-xs text-muted">{stripDash(run.marketContext)}</p>}
                {proposals.map((p) => (
                  <div key={p.id} className="flex justify-between text-xs">
                    <span>
                      {p.symbol} · {p.strategy === "no_trade" ? "no trade" : labelStrategy(p.strategy)}
                    </span>
                    <span className="text-muted">{p.status}</span>
                  </div>
                ))}
                {orders.length > 0 && (
                  <div className="pt-1 border-t border-border space-y-1">
                    {orders.map((o) => (
                      <div key={o.id} className="text-[11px] text-muted num">
                        order {o.contractSymbol} · {o.status} · {o.executionMode} · max loss {usd(Number(o.maxLoss), 0)}
                      </div>
                    ))}
                  </div>
                )}
                <div className="text-[11px] text-muted num">
                  {run.searchCount ?? 0} searches · {run.inputTokens ?? 0} in / {run.outputTokens ?? 0} out
                </div>
                <Link href={run.model === "scan" ? "/setups" : `/operation-vega/${run.id}`} className="block text-xs text-accent">
                  {run.model === "scan" ? "See setups" : "Full breakdown"} &rarr;
                </Link>
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
