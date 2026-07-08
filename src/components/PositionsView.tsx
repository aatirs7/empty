"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { usd, parseOcc, companyName, positionRecommendation, etDateTime } from "@/lib/format";

interface Pos {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  market_value: string | null;
  unrealized_pl: string | null;
  unrealized_plpc: string | null;
  current_price: string | null;
  placedAt: string | null;
  filledAt: string | null;
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
    // Opening this screen also runs goal-driven auto-management (no-op if off).
    fetch("/api/manage", { method: "POST" })
      .catch(() => {})
      .finally(load);
  }, [load]);

  async function close(sym: string) {
    if (!window.confirm(`Close ${sym}? This flattens the paper position.`)) return;
    setClosing(sym);
    await fetch(`/api/positions/${encodeURIComponent(sym)}/close`, { method: "POST" });
    setClosing(null);
    load();
  }

  if (!data) return <p className="text-sm text-muted text-center py-8">Loading positions…</p>;
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
        const plPc = p.unrealized_plpc != null ? Number(p.unrealized_plpc) : null;
        const occ = parseOcc(p.symbol);
        const company = occ ? companyName(occ.underlying) : p.symbol;
        const dir = occ?.type === "call" ? "up" : "down";
        const rec = positionRecommendation(p.symbol, plPc);
        return (
          <div key={p.symbol} className="bg-panel border border-border rounded-2xl p-4 space-y-3">
            <Link href={`/position/${encodeURIComponent(p.symbol)}`} className="block">
              <div className="flex justify-between items-start gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-sm">
                    {company}{" "}
                    {occ && <span className={dir === "up" ? "text-up" : "text-down"}>({dir})</span>}
                  </p>
                  <p className="text-xs text-muted num">
                    {p.qty} @ {usd(p.avg_entry_price)}
                    {occ && ` · target ${usd(occ.strike, 0)}`}
                  </p>
                  {(p.filledAt || p.placedAt) && (
                    <p className="text-[11px] text-muted num mt-0.5">Placed {etDateTime(p.filledAt || p.placedAt)}</p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <p className={`num font-semibold ${pl >= 0 ? "text-up" : "text-down"}`}>
                    {pl >= 0 ? "+" : ""}
                    {usd(pl)}
                  </p>
                  <p className="text-xs text-muted num">{usd(p.market_value)}</p>
                </div>
              </div>
            </Link>

            <div className={`text-xs text-center ${rec.tone === "up" ? "text-up" : rec.tone === "down" ? "text-down" : "text-muted"}`}>
              {rec.text}
            </div>

            <button
              onClick={() => close(p.symbol)}
              disabled={closing === p.symbol}
              className="w-full rounded-xl border border-down/40 text-down text-sm py-2 disabled:opacity-40"
            >
              {closing === p.symbol ? "Closing…" : "Close position"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
