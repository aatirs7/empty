import Link from "next/link";
import { getPosition, getStockBars } from "@/lib/alpaca";
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
  const bars = occ ? await getStockBars(occ.underlying, 90).catch(() => []) : [];
  const closes = bars.map((b) => b.c);

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

      {occ && <StockChart closes={closes} strike={occ.strike} />}

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
