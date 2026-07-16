import Link from "next/link";
import { getPosition, getStockBars, getUnderlyingPrice } from "@/lib/alpaca";
import { getProposalForContract } from "@/lib/queries";
import { classifyAndScore } from "@/lib/playbook";
import { parseOcc, companyName, usd, longDate, daysUntil, positionRecommendation } from "@/lib/format";
import StockChart from "@/components/StockChart";
import ClosePositionButton from "@/components/ClosePositionButton";

export const dynamic = "force-dynamic";

export default async function PositionPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const pos = await getPosition(symbol);

  if (!pos) {
    return (
      <div className="space-y-4">
        <Link href="/positions" className="text-xs text-muted">
          ← Positions
        </Link>
        <p className="text-sm text-muted text-center py-12">This position isn&apos;t open anymore, it may have been closed.</p>
      </div>
    );
  }

  const occ = parseOcc(symbol);
  const bars = occ ? await getStockBars(occ.underlying, 250).catch(() => []) : [];
  const closes = bars.map((b) => b.c);
  const spot = occ ? await getUnderlyingPrice(occ.underlying).catch(() => closes[closes.length - 1] ?? null) : null;

  // Timing estimate: how long the move typically takes at this zone (past taps).
  const proposal = occ ? await getProposalForContract(symbol).catch(() => null) : null;
  const zs = proposal?.zoneSetup as { active_zone?: { bottom: number; top: number }; predictedTarget?: number | null } | null;
  const zone = zs?.active_zone ?? null;
  // The REAL exit target persisted at entry (DB target / next manual level) — Vega
  // sells when the underlying reaches this, NOT at the strike.
  const exitTarget = typeof zs?.predictedTarget === "number" ? zs.predictedTarget : null;
  let avgDays: number | null = null;
  if (occ && zone && spot != null && bars.length > 30) {
    try {
      avgDays = classifyAndScore(bars, zone, occ.type as "call" | "put", spot).historical.avgDays || null;
    } catch {
      avgDays = null;
    }
  }
  const daysLeft = occ ? daysUntil(occ.expiry) : 0;

  const pl = pos.unrealized_pl ? Number(pos.unrealized_pl) : 0;
  const plPc = pos.unrealized_plpc != null ? Number(pos.unrealized_plpc) : null;
  const entry = Number(pos.avg_entry_price);
  const cost = pos.cost_basis ? Number(pos.cost_basis) : entry * 100 * Number(pos.qty);
  const rec = positionRecommendation(symbol, plPc);
  const company = occ ? companyName(occ.underlying) : symbol;
  const dir = occ?.type === "call" ? "up" : "down";
  const dirWord = occ?.type === "call" ? "rise above" : "fall below";

  return (
    <div className="space-y-5">
      <Link href="/positions" className="text-xs text-muted">
        ← Positions
      </Link>

      <div className="text-center">
        <h1 className="text-2xl font-bold">
          {company}
          {occ && <span className="text-muted text-lg"> ({occ.underlying})</span>}
        </h1>
        {occ && (
          <p className={`text-sm font-medium ${dir === "up" ? "text-up" : "text-down"}`}>
            You&apos;re betting {company} goes {dir}
          </p>
        )}
      </div>

      {occ && (
        <p className="text-sm text-center leading-relaxed">
          You own a <span className="font-medium">{occ.type}</span> option on {company}. In plain terms, you&apos;re
          predicting {company} will {dirWord} <span className="num text-foreground">{usd(occ.strike)}</span> by{" "}
          <span className="text-foreground">{longDate(occ.expiry)}</span> ({daysUntil(occ.expiry)} days left).
        </p>
      )}

      {occ && spot != null && (
        <div className="bg-panel border border-border rounded-2xl p-4 text-center space-y-2">
          <div>
            <p className="text-xs text-muted">{occ.underlying} is now</p>
            <p className="text-2xl font-bold num">{usd(spot)}</p>
          </div>
          {(() => {
            const isCall = occ.type === "call";
            // Sell target = the price persisted at entry (DB target / next manual
            // level). The strike is just the contract; shown separately below.
            const target = exitTarget ?? occ.strike;
            const dist = isCall ? target - spot : spot - target; // >0 = still needed in the bet's direction
            const distPct = spot > 0 ? Math.abs(dist / spot) * 100 : 0;
            const be = isCall ? occ.strike + entry : occ.strike - entry;
            const beDist = isCall ? be - spot : spot - be; // >0 = still needed to reach breakeven
            return (
              <div className="space-y-1 text-sm">
                <p>
                  {exitTarget != null ? "Vega sells at" : "Your target:"}{" "}
                  <span className="num text-foreground">
                    {exitTarget != null ? usd(target) : `${isCall ? "above" : "below"} ${usd(target)}`}
                  </span>{" "}
                  {dist <= 0 ? (
                    <span className="text-up">— already there ✓</span>
                  ) : (
                    <span className="text-muted num">
                      — needs {isCall ? "+" : "−"}
                      {usd(Math.abs(dist))} ({distPct.toFixed(1)}%)
                    </span>
                  )}
                </p>
                <p className="text-[11px] text-muted num">
                  Contract: ${occ.strike} {occ.type} · exp {occ.expiry} · breakeven at expiry {usd(be)}
                  {beDist <= 0 ? " ✓" : ` (${usd(Math.abs(beDist))} to go)`}
                </p>
              </div>
            );
          })()}
        </div>
      )}

      {occ && <StockChart closes={closes.slice(-90)} strike={occ.strike} />}

      {occ && (
        <div className="bg-panel border border-border rounded-2xl p-4 text-center space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted mb-1">Timing</p>
          <p className="text-sm leading-relaxed">
            The plan is to hold until {occ.underlying} reaches{" "}
            {exitTarget != null ? <span className="num text-foreground">{usd(exitTarget)}</span> : "the exit target"} or
            the option expires <span className="num text-foreground">{longDate(occ.expiry)}</span> —{" "}
            <span className="num">{daysLeft}</span> {daysLeft === 1 ? "day" : "days"} left. Whichever comes first (or
            the setup breaks down / the stop hits).
          </p>
          {avgDays != null && avgDays > 0 && (
            <p className="text-xs text-muted leading-relaxed">
              If it plays out like past moves off this level, it should turn profitable in about{" "}
              <span className="num">{avgDays}</span> {avgDays === 1 ? "day" : "days"}
              {avgDays > daysLeft
                ? " — that's tighter than the time left, so it needs to move faster than usual to pay off before expiry."
                : ", well inside the time left."}
            </p>
          )}
        </div>
      )}

      <div className="bg-panel border border-border rounded-2xl p-4 grid grid-cols-2 gap-3 text-center">
        <div>
          <p className="text-xs text-muted">You paid</p>
          <p className="num font-semibold">
            {usd(entry)}
            <span className="text-xs text-muted"> /sh</span>
          </p>
          <p className="text-[11px] text-muted num">{usd(cost)} total</p>
        </div>
        <div>
          <p className="text-xs text-muted">Now worth</p>
          <p className="num font-semibold">
            {usd(pos.current_price)}
            <span className="text-xs text-muted"> /sh</span>
          </p>
          <p className="text-[11px] text-muted num">{usd(pos.market_value)} total</p>
        </div>
        <div className="col-span-2 border-t border-border pt-3">
          <p className="text-xs text-muted">Profit / loss so far</p>
          <p className={`text-2xl font-bold num ${pl >= 0 ? "text-up" : "text-down"}`}>
            {pl >= 0 ? "+" : ""}
            {usd(pl)}
            {plPc != null && (
              <span className="text-sm">
                {" "}
                ({plPc >= 0 ? "+" : ""}
                {Math.round(plPc * 100)}%)
              </span>
            )}
          </p>
        </div>
      </div>

      <div className="bg-panel border border-border rounded-2xl p-4 text-center">
        <p className="text-xs uppercase tracking-wide text-muted mb-1">Vega&apos;s tip</p>
        <p className={`text-sm ${rec.tone === "up" ? "text-up" : rec.tone === "down" ? "text-down" : "text-foreground"}`}>
          {rec.text}
        </p>
        <p className="text-[11px] text-muted mt-1">A simple rule of thumb, not advice.</p>
      </div>

      <ClosePositionButton symbol={symbol} />
    </div>
  );
}
