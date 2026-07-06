import Link from "next/link";
import { getLatestRun } from "@/lib/queries";
import ProposalActions from "@/components/ProposalActions";
import { PricedInTag, Confidence, StatusPill, Empty } from "@/components/ui";
import { labelStrategy } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const data = await getLatestRun();
  if (!data) return <Empty>No research yet. Operation Vega runs each weekday, pre-market.</Empty>;
  const { run, proposals } = data;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Today</h1>
        <p className="text-xs text-muted num">
          Run #{run.id} · {run.runDate} · {run.status}
        </p>
      </div>

      {run.marketContext && (
        <p className="text-sm text-muted bg-panel border border-border rounded-xl p-3">{run.marketContext}</p>
      )}

      <div className="space-y-3">
        {proposals.map((p) => {
          const isTrade = p.strategy !== "no_trade";
          return (
            <div key={p.id} className="bg-panel border border-border rounded-xl p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <Link href={`/proposal/${p.id}`} className="min-w-0">
                  <span className="font-semibold">{p.symbol}</span>{" "}
                  {isTrade ? (
                    <span className="text-xs text-muted">
                      {labelStrategy(p.strategy)} · {p.strikeHint} · {p.expiryHint}
                    </span>
                  ) : (
                    <span className="text-xs text-muted">no trade</span>
                  )}
                </Link>
                <PricedInTag value={p.pricedInAssessment} />
              </div>

              {p.plainExplanation && <p className="text-sm">{p.plainExplanation}</p>}

              <div className="flex items-center justify-between">
                <Confidence value={p.confidence} />
                {!isTrade ? (
                  <span className="text-xs text-muted">—</span>
                ) : p.status === "pending" ? (
                  <ProposalActions id={p.id} />
                ) : (
                  <StatusPill status={p.status} />
                )}
              </div>

              <Link href={`/proposal/${p.id}`} className="block text-xs text-accent">
                {isTrade ? "See the trade & risk →" : "Details →"}
              </Link>
            </div>
          );
        })}
      </div>
    </div>
  );
}
