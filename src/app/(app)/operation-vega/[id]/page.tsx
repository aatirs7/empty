import { notFound } from "next/navigation";
import { getRunWithProposals } from "@/lib/queries";
import { plainVerdict, plainPricedIn, confidenceLabel, stripDash, usd } from "@/lib/format";
import { PageTitle } from "@/components/ui";

export const dynamic = "force-dynamic";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-panel border border-border rounded-2xl p-3">
      <p className="text-[11px] text-muted">{label}</p>
      <p className="num font-semibold">{value}</p>
    </div>
  );
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}

export default async function OperationVegaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getRunWithProposals(Number(id));
  if (!data) notFound();
  const { run, proposals } = data;

  return (
    <div className="space-y-5">
      <PageTitle title="Operation Vega" subtitle={`${run.runDate} · run #${run.id}`} />

      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label="Stocks" value={String(proposals.length)} />
        <Stat label="Web searches" value={String(run.searchCount ?? 0)} />
        <Stat label="Cost" value={usd(Number(run.costEstimate))} />
      </div>

      {run.marketContext && (
        <div className="bg-panel border border-border rounded-2xl p-4 text-center">
          <p className="text-xs uppercase tracking-wide text-muted mb-1">Market mood</p>
          <p className="text-sm text-muted leading-relaxed">{stripDash(run.marketContext)}</p>
        </div>
      )}

      <div className="space-y-3">
        {proposals.map((p) => {
          const verdict = plainVerdict(p.strategy, p.symbol);
          const tone = verdict.tone === "up" ? "text-up" : verdict.tone === "down" ? "text-down" : "text-muted";
          return (
            <div key={p.id} className="bg-panel border border-border rounded-2xl p-4 space-y-2 text-center">
              <div>
                <span className="font-semibold">{p.symbol}</span> <span className={`text-sm ${tone}`}>· {verdict.title}</span>
              </div>
              {p.plainExplanation && (
                <p className="text-sm text-muted leading-relaxed">{stripDash(p.plainExplanation)}</p>
              )}
              {p.rationale && (
                <p className="text-xs text-muted leading-relaxed">
                  Vega thinks {plainPricedIn(p.pricedInAssessment)}. {stripDash(p.rationale)}
                </p>
              )}
              <p className="text-xs text-muted">
                {confidenceLabel(p.confidence)} · {Math.round(Number(p.confidence) * 100)}%
              </p>
              {p.sources && p.sources.length > 0 && (
                <div className="pt-2 border-t border-border">
                  <p className="text-[11px] uppercase tracking-wide text-muted mb-1">Sources it read</p>
                  <div className="space-y-1">
                    {p.sources.map((s, i) => (
                      <a
                        key={i}
                        href={s}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block text-xs text-accent truncate"
                      >
                        {hostOf(s)}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
