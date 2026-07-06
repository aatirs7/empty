import Link from "next/link";
import { notFound } from "next/navigation";
import { getProposalById } from "@/lib/queries";
import RiskExplainer from "@/components/RiskExplainer";
import PendingRisk from "@/components/PendingRisk";
import { PricedInTag, Confidence } from "@/components/ui";
import { labelStrategy, usd, plainPricedIn } from "@/lib/format";
import type { Scenario } from "@/lib/risk";

export const dynamic = "force-dynamic";

export default async function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getProposalById(Number(id));
  if (!data) notFound();
  const { proposal: p, order } = data;
  const isTrade = p.strategy !== "no_trade" && !!p.direction && p.direction !== "none";
  const plain = p.plainExplanation || p.rationale;

  return (
    <div className="space-y-5">
      <Link href="/" className="text-xs text-muted">
        ← Today
      </Link>

      <div className="text-center">
        <h1 className="text-3xl font-bold">{p.symbol}</h1>
        {isTrade && (
          <p className="text-sm text-muted mt-1">
            {labelStrategy(p.strategy)} · {p.strikeHint} · {p.expiryHint}
          </p>
        )}
        <div className="mt-2 flex justify-center">
          <PricedInTag value={p.pricedInAssessment} />
        </div>
      </div>

      <section>
        <h2 className="text-sm font-semibold mb-1 text-center">In plain English</h2>
        <p className="text-sm text-center leading-relaxed">{plain ?? "—"}</p>
      </section>

      <section>
        <h2 className="text-sm font-semibold mb-1 text-center">Why Vega picked it</h2>
        <p className="text-sm text-muted text-center leading-relaxed">
          Vega thinks <span className="text-foreground">{plainPricedIn(p.pricedInAssessment)}</span>
          {p.plainExplanation && p.rationale ? `. ${p.rationale}` : "."}
        </p>
      </section>

      {isTrade ? (
        order ? (
          <>
            <div className="text-xs text-muted num">
              {order.contractSymbol} · {order.status}
              {order.filledPrice ? ` · filled ${usd(order.filledPrice)}` : ""} · {order.executionMode}
            </div>
            <RiskExplainer
              direction={(order.direction ?? "call") as "call" | "put"}
              underlyingPrice={order.underlyingPrice != null ? Number(order.underlyingPrice) : null}
              maxLoss={Number(order.maxLoss)}
              breakeven={Number(order.breakeven)}
              scenarios={(order.scenarios ?? []) as Scenario[]}
            />
          </>
        ) : p.status === "pending" ? (
          <PendingRisk id={p.id} />
        ) : (
          <p className="text-sm text-muted">This proposal is {p.status} with no order attached.</p>
        )
      ) : (
        <section className="bg-panel border border-border rounded-2xl p-4 text-sm text-muted text-center leading-relaxed">
          No trade today — Vega didn&apos;t see a clear edge on {p.symbol}. A day with no trade is a perfectly good
          outcome.
        </section>
      )}

      <section className="border-t border-border pt-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted">Confidence</span>
          <Confidence value={p.confidence} />
        </div>
        <p className="text-xs text-muted mt-2">
          This is one idea, not a guarantee. Vega is often deliberately low-confidence — most mornings the honest answer
          is &ldquo;no edge.&rdquo; Paper trading only; none of this is financial advice.
        </p>
      </section>
    </div>
  );
}
