"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { usd, parseOcc, companyName, etDateTime, daysUntil } from "@/lib/format";
import { DEFAULT_UI_PROFILE } from "@/lib/ui-profiles";

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
interface ClosedTrade {
  id: number;
  contractSymbol: string | null;
  direction: string | null;
  qty: number | null;
  filledPrice: string | null;
  exitPrice: string | null;
  realizedPl: string | null;
  exitReason: string | null;
  submittedAt: string | null;
  exitAt: string | null;
}
interface ClosedData {
  ok: boolean;
  trades: ClosedTrade[];
  realized: number;
}

export default function PositionsView() {
  const profile = useSearchParams().get("profile") ?? DEFAULT_UI_PROFILE;
  const q = `?profile=${profile}`;
  const [tab, setTab] = useState<"open" | "closed">("open");
  const [data, setData] = useState<Data | null>(null);
  const [closed, setClosed] = useState<ClosedData | null>(null);
  const [closing, setClosing] = useState<string | null>(null);

  const [syncedAt, setSyncedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/positions${q}`, { cache: "no-store" });
    setData(await r.json());
    setSyncedAt(new Date());
  }, [q]);
  const loadClosed = useCallback(async () => {
    const r = await fetch(`/api/positions/closed${q}`, { cache: "no-store" });
    setClosed(await r.json());
  }, [q]);

  useEffect(() => {
    // Just DISPLAY current positions (exits are the monitor cron's job — opening
    // this page must never close a trade). Poll every 15s + on tab focus so the
    // live P&L stays current without a manual refresh. FOREGROUND ONLY — polling
    // a backgrounded PWA drains the phone (2026-07-15 device-lag fix); the
    // visibility/focus handlers below refresh immediately on return.
    const refresh = () => {
      load();
      loadClosed();
    };
    refresh();
    const iv = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 15_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [load, loadClosed]);

  async function close(sym: string) {
    if (!window.confirm(`Close ${sym}? This flattens the paper position.`)) return;
    setClosing(sym);
    await fetch(`/api/positions/${encodeURIComponent(sym)}/close${q}`, { method: "POST" });
    setClosing(null);
    load();
    loadClosed();
  }

  const openCount = data?.positions.length ?? 0;
  const closedCount = closed?.trades.length ?? 0;

  return (
    <div className="space-y-4">
      {/* Open / Closed toggle */}
      <div className="grid grid-cols-2 gap-1 bg-panel-2 border border-border rounded-2xl p-1">
        {(["open", "closed"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-xl py-2 text-sm font-medium capitalize transition-colors ${
              tab === t ? "bg-panel text-foreground shadow-sm" : "text-muted"
            }`}
          >
            {t} {t === "open" ? `(${openCount})` : `(${closedCount})`}
          </button>
        ))}
      </div>

      {tab === "open" && syncedAt && (
        <p className="text-center text-[11px] text-muted num flex items-center justify-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-up animate-pulse" />
          Live · updated {syncedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </p>
      )}

      {tab === "open" ? <OpenView data={data} closing={closing} onClose={close} /> : <ClosedView closed={closed} />}
    </div>
  );
}

function OpenView({ data, closing, onClose }: { data: Data | null; closing: string | null; onClose: (s: string) => void }) {
  if (!data) return <p className="text-sm text-muted text-center py-8">Loading positions…</p>;
  if (!data.positions.length) return <p className="text-sm text-muted text-center py-12">No open positions.</p>;

  return (
    <div className="space-y-3">
      <div className="bg-panel border border-border rounded-2xl p-5 text-center lg:p-6">
        <p className="text-xs text-muted">Total unrealized P&amp;L</p>
        <p className={`text-3xl font-bold num mt-1 ${data.totalUnrealizedPl >= 0 ? "text-up" : "text-down"}`}>
          {data.totalUnrealizedPl >= 0 ? "+" : ""}
          {usd(data.totalUnrealizedPl)}
        </p>
        <p className="text-xs text-muted num mt-1">Market value {usd(data.totalMarketValue)}</p>
      </div>

      <div className="space-y-3 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-3">
        {data.positions.map((p) => {
          const pl = p.unrealized_pl ? Number(p.unrealized_pl) : 0;
          const occ = parseOcc(p.symbol);
          const company = occ ? companyName(occ.underlying) : p.symbol;
          const dir = occ?.type === "call" ? "up" : "down";
          return (
            <div key={p.symbol} className="bg-panel border border-border rounded-2xl p-4 space-y-3">
              <Link href={`/position/${encodeURIComponent(p.symbol)}`} className="block">
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-sm">
                      {company} {occ && <span className={dir === "up" ? "text-up" : "text-down"}>({dir})</span>}
                    </p>
                    <p className="text-xs text-muted num">
                      {p.qty} @ {usd(p.avg_entry_price)}
                      {occ && ` · target ${usd(occ.strike, 0)}`}
                    </p>
                    {(p.filledAt || p.placedAt) && (
                      <p className="text-[11px] text-muted num mt-0.5">
                        Placed {etDateTime(p.filledAt || p.placedAt)}
                        {occ && ` · exp ${occ.expiry} (${daysUntil(occ.expiry)}d)`}
                      </p>
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

              <button
                onClick={() => onClose(p.symbol)}
                disabled={closing === p.symbol}
                className="w-full rounded-xl border border-down/40 text-down text-sm py-2 disabled:opacity-40"
              >
                {closing === p.symbol ? "Closing…" : "Close position"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ClosedView({ closed }: { closed: ClosedData | null }) {
  const [period, setPeriod] = useState<"today" | "all">("all");
  if (!closed) return <p className="text-sm text-muted text-center py-8">Loading…</p>;
  if (!closed.trades.length) return <p className="text-sm text-muted text-center py-12">No closed trades yet.</p>;

  // Today = the trade's exit landed on today's date in ET.
  const todayET = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
  const isToday = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-US", { timeZone: "America/New_York" }) === todayET : false);
  const trades = period === "today" ? closed.trades.filter((t) => isToday(t.exitAt)) : closed.trades;
  const realized = trades.reduce((s, t) => s + (t.realizedPl != null ? Number(t.realizedPl) : 0), 0);

  return (
    <div className="space-y-3">
      {/* Today / All-time toggle */}
      <div className="grid grid-cols-2 gap-1 bg-panel-2 border border-border rounded-2xl p-1">
        {(["today", "all"] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`rounded-xl py-1.5 text-sm font-medium transition-colors ${period === p ? "bg-panel text-foreground shadow-sm" : "text-muted"}`}
          >
            {p === "today" ? "Today" : "All time"}
          </button>
        ))}
      </div>

      <div className="bg-panel border border-border rounded-2xl p-5 text-center lg:p-6">
        <p className="text-xs text-muted">Realized P&amp;L · {period === "today" ? "today" : "all time"}</p>
        <p className={`text-3xl font-bold num mt-1 ${realized >= 0 ? "text-up" : "text-down"}`}>
          {realized >= 0 ? "+" : ""}
          {usd(realized)}
        </p>
        <p className="text-xs text-muted num mt-1">{trades.length} trade{trades.length === 1 ? "" : "s"}</p>
      </div>

      {trades.length === 0 ? (
        <p className="text-sm text-muted text-center py-12">No trades closed today.</p>
      ) : (
      <div className="space-y-3 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-3">
        {trades.map((t) => {
          const occ = t.contractSymbol ? parseOcc(t.contractSymbol) : null;
          const company = occ ? companyName(occ.underlying) : t.contractSymbol ?? "—";
          const dir = (t.direction ?? occ?.type) === "call" ? "up" : "down";
          const entry = t.filledPrice != null ? Number(t.filledPrice) : null;
          const exit = t.exitPrice != null ? Number(t.exitPrice) : null;
          const pl = t.realizedPl != null ? Number(t.realizedPl) : null;
          const pct = entry && exit && entry > 0 ? Math.round(((exit - entry) / entry) * 100) : null;
          return (
            <div key={t.id} className="bg-panel border border-border rounded-2xl p-4">
              <div className="flex justify-between items-start gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-sm">
                    {company} <span className={dir === "up" ? "text-up" : "text-down"}>({dir})</span>
                  </p>
                  <p className="text-xs text-muted num">
                    {t.qty ?? 1} @ {entry != null ? usd(entry) : "—"}
                    {exit != null ? ` → sold ${usd(exit)}` : ""}
                    {t.exitReason ? ` · ${t.exitReason}` : ""}
                  </p>
                  {t.exitAt && <p className="text-[11px] text-muted num mt-0.5">Closed {etDateTime(t.exitAt)}</p>}
                </div>
                <div className="text-right shrink-0">
                  {pl != null ? (
                    <p className={`num font-semibold ${pl >= 0 ? "text-up" : "text-down"}`}>
                      {pl >= 0 ? "+" : ""}
                      {usd(pl)}
                    </p>
                  ) : (
                    <p className="num text-muted text-sm">—</p>
                  )}
                  {pct != null && <p className={`text-xs num ${pct >= 0 ? "text-up" : "text-down"}`}>{pct >= 0 ? "+" : ""}{pct}%</p>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}
