import Link from "next/link";
import { notFound } from "next/navigation";
import { getProposalById } from "@/lib/queries";
import RiskExplainer from "@/components/RiskExplainer";
import PendingRisk from "@/components/PendingRisk";
import { PricedInTag, Confidence } from "@/components/ui";
import { labelStrategy, usd } from "@/lib/format";
import type { Scenario } from "@/lib/risk";

export const dynamic = "force-dynamic";

export default async function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getProposalById(Number(id));
  if (!data) notFound();
  const { proposal: p, order } = data;
  const isTrade = p.strategy !== "no_trade" && !!p.direction && p.direction !== "none";
  const priced = (p.pricedInAssessment ?? "unclear").replace("_", " ");

  return (
    <div className="space-y-5">
      <Link href="/" className="text-xs text-muted">
        ← Today
      </Link>

      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold">{p.symbol}</h1>
          {isTrade && <span className="text-sm text-muted">{labelStrategy(p.strategy)}</span>}
          <div className="ml-auto">
            <PricedInTag value={p.pricedInAssessment} />
          </div>
        </div>
        {isTrade && (
          <p className="text-sm text-muted mt-1">
            {p.strikeHint} · {p.expiryHint}
          </p>
        )}
      </div>

      <section>
        <h2 className="text-sm font-semibold mb-1">In plain English</h2>
        <p className="text-sm">{p.plainExplanation ?? "—"}</p>
      </section>

      <section>
        <h2 className="text-sm font-semibold mb-1">Why Vega picked it</h2>
        <p className="text-sm text-muted">{p.rationale ?? "—"}</p>
        <p className="text-xs text-muted mt-1">
          Vega&apos;s read: the market&apos;s reaction looks <span className="text-foreground">{priced}</span>.
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
        <section className="bg-panel border border-border rounded-xl p-4 text-sm text-muted">
          No trade today — no clear, defensible edge on {p.symbol}. A day with no trade is a fine outcome.
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
