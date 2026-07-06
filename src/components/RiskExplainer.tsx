import type { Scenario } from "@/lib/risk";
import { usd } from "@/lib/format";

// Every number here is CODE-COMPUTED (risk.ts / resolve.ts), never from the model.
// Downside and upside get equal visual weight.
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
  const best = scenarios.length ? scenarios.reduce((a, b) => (b.payoff > a.payoff ? b : a)) : null;
  const makeNumber = best && best.payoff > 0 ? best.payoff : null;
  const moveWord = direction === "call" ? "rises" : "falls";
  const bestPct = best ? best.label.replace(/[+-]/g, "") : "";

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-down/10 border border-down/30 rounded-2xl p-4 text-center">
          <p className="text-xs uppercase tracking-wide text-down/80">You could lose</p>
          <p className="text-2xl font-bold text-down num mt-1">{usd(maxLoss, 0)}</p>
          <p className="text-[11px] text-muted mt-1">the most, if it expires worthless</p>
        </div>
        <div className="bg-up/10 border border-up/30 rounded-2xl p-4 text-center">
          <p className="text-xs uppercase tracking-wide text-up/80">You could make</p>
          <p className="text-2xl font-bold text-up num mt-1">{makeNumber ? `+${usd(makeNumber, 0)}` : "-"}</p>
          <p className="text-[11px] text-muted mt-1">{makeNumber ? `if it ${moveWord} ${bestPct}` : "needs a bigger move to profit"}</p>
        </div>
      </div>

      <div className="bg-panel border border-border rounded-2xl p-4 text-sm space-y-2">
        <p className="leading-relaxed">
          The stock is at <span className="num">{underlyingPrice != null ? usd(underlyingPrice) : "-"}</span>. It needs to{" "}
          {direction === "call" ? "rise above" : "fall below"} <span className="num text-foreground">{usd(breakeven)}</span>{" "}
          by the deadline for you to come out ahead
          {direction === "call" ? (
            <>, and the more it {moveWord} past that, the more you make (no upper limit).</>
          ) : (
            <>, and the further it {moveWord}, the more you make (up to the stock reaching $0).</>
          )}
        </p>
        <div className="pt-1 space-y-1 num text-sm">
          {scenarios.map((s) => (
            <div key={s.label} className="flex justify-between">
              <span className="text-muted">
                If it moves {s.label} → {usd(s.underlyingPrice)}
              </span>
              <span className={s.payoff >= 0 ? "text-up" : "text-down"}>
                {s.payoff >= 0 ? "+" : ""}
                {usd(s.payoff)}
              </span>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-muted">Worked out in code from the real price, not guesses from the AI.</p>
      </div>

      <div className="bg-panel border border-border rounded-2xl p-4">
        <p className="text-xs uppercase tracking-wide text-muted">The catch</p>
        <p className="text-sm text-muted mt-1 leading-relaxed">
          These bets have a deadline. The option steadily loses value as the deadline nears, even if the stock
          doesn&apos;t move, so being right too slowly can still lose money.
        </p>
      </div>
    </div>
  );
}
