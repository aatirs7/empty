import type { Scenario } from "@/lib/risk";
import { usd } from "@/lib/format";

// Every number here is CODE-COMPUTED (risk.ts / resolve.ts). Nothing is
// model-generated. Downside gets equal billing with upside.
export default function RiskExplainer({
  direction,
  underlyingPrice,
  maxLoss,
  breakeven,
  scenarios,
}: {
  direction: "call" | "put";
  underlyingPrice: number | null;
  maxLoss: number;
  breakeven: number;
  scenarios: Scenario[];
}) {
  return (
    <div className="space-y-3">
      <section className="bg-down/10 border border-down/30 rounded-xl p-4">
        <p className="text-xs uppercase tracking-wide text-down/80">What you can lose</p>
        <p className="text-3xl font-bold text-down num mt-1">{usd(maxLoss, 0)}</p>
        <p className="text-sm text-muted mt-1">
          This is the most you can lose. If the trade doesn&apos;t work out, the option can expire worthless and you
          lose the whole premium.
        </p>
      </section>

      <section className="bg-up/10 border border-up/30 rounded-xl p-4">
        <p className="text-xs uppercase tracking-wide text-up/80">What you can gain</p>
        <p className="text-sm mt-1">
          Break-even is <span className="num text-foreground">{usd(breakeven)}</span>
          {underlyingPrice != null && (
            <>
              {" "}
              (the stock is at <span className="num">{usd(underlyingPrice)}</span> now).
            </>
          )}
        </p>
        <p className="text-sm text-muted mt-1">
          {direction === "call"
            ? "The stock has to rise above break-even by expiry to make money. Above that, the gains are uncapped."
            : "The stock has to fall below break-even by expiry to make money. Gains grow as it falls — capped only if the stock reaches $0."}
        </p>
        <div className="mt-3 space-y-1">
          {scenarios.map((s) => (
            <div key={s.label} className="flex justify-between text-sm num">
              <span className="text-muted">
                {s.label} → {usd(s.underlyingPrice)}
              </span>
              <span className={s.payoff >= 0 ? "text-up" : "text-down"}>
                {s.payoff >= 0 ? "+" : ""}
                {usd(s.payoff)}
              </span>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-muted mt-2">
          Payoffs are at expiration, net of premium — computed in code, not estimated by the model.
        </p>
      </section>

      <section className="bg-panel border border-border rounded-xl p-4">
        <p className="text-xs uppercase tracking-wide text-muted">The catch</p>
        <p className="text-sm text-muted mt-1">
          Options lose value as expiration approaches, even if the stock doesn&apos;t move (time decay). Holding costs
          money, and being right too late still loses.
        </p>
      </section>
    </div>
  );
}
