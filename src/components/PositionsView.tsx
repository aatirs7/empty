"use client";
import { useCallback, useEffect, useState } from "react";
import { usd } from "@/lib/format";

interface Pos {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  market_value: string | null;
  unrealized_pl: string | null;
  current_price: string | null;
}
interface Data {
  ok: boolean;
  positions: Pos[];
  totalUnrealizedPl: number;
  totalMarketValue: number;
}

export default function PositionsView() {
  const [data, setData] = useState<Data | null>(null);
  const [closing, setClosing] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/positions");
    setData(await r.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function close(sym: string) {
    if (!window.confirm(`Close ${sym}? This flattens the paper position.`)) return;
    setClosing(sym);
    await fetch(`/api/positions/${encodeURIComponent(sym)}/close`, { method: "POST" });
    setClosing(null);
    load();
  }

  if (!data) return <p className="text-sm text-muted">Loading positions…</p>;
  if (!data.positions.length) return <p className="text-sm text-muted text-center py-12">No open positions.</p>;

  return (
    <div className="space-y-3">
      <div className="bg-panel border border-border rounded-2xl p-5 text-center">
        <p className="text-xs text-muted">Total unrealized P&amp;L</p>
        <p className={`text-3xl font-bold num mt-1 ${data.totalUnrealizedPl >= 0 ? "text-up" : "text-down"}`}>
          {data.totalUnrealizedPl >= 0 ? "+" : ""}
          {usd(data.totalUnrealizedPl)}
        </p>
        <p className="text-xs text-muted num mt-1">Market value {usd(data.totalMarketValue)}</p>
      </div>

      {data.positions.map((p) => {
        const pl = p.unrealized_pl ? Number(p.unrealized_pl) : 0;
        return (
          <div key={p.symbol} className="bg-panel border border-border rounded-2xl p-4">
            <div className="flex justify-between items-start gap-2">
              <div className="min-w-0">
                <p className="font-medium num text-sm break-all">{p.symbol}</p>
                <p className="text-xs text-muted num">
                  {p.qty} @ {usd(p.avg_entry_price)}
                  {p.current_price ? ` · now ${usd(p.current_price)}` : ""}
                </p>
              </div>
              <div className="text-right shrink-0">
                <p className={`num font-semibold ${pl >= 0 ? "text-up" : "text-down"}`}>
                  {pl >= 0 ? "+" : ""}
                  {usd(pl)}
                </p>
                <p className="text-xs text-muted num">{usd(p.market_value)}</p>
              </div>
            </div>
            <button
              onClick={() => close(p.symbol)}
              disabled={closing === p.symbol}
              className="mt-3 w-full rounded-lg border border-down/40 text-down text-sm py-2 disabled:opacity-40"
            >
              {closing === p.symbol ? "Closing…" : "Close position"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
