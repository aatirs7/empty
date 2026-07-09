"use client";
import { useEffect, useState } from "react";
import { usd } from "@/lib/format";

interface Acct {
  accountNumber: string | null;
  equity: number;
  cash: number;
  buyingPower: number;
  positionsValue: number;
  dayPL: number;
}

export default function AccountBalance({ profile }: { profile?: string }) {
  const [a, setA] = useState<Acct | null>(null);
  useEffect(() => {
    fetch(`/api/account${profile ? `?profile=${profile}` : ""}`)
      .then((r) => r.json())
      .then((j) => (j.ok ? setA(j) : null))
      .catch(() => {});
  }, [profile]);

  if (!a) return null;
  const up = a.dayPL >= 0;

  return (
    <div className="bg-panel border border-accent/30 rounded-2xl p-5 text-center">
      <p className="text-xs text-muted">Total balance</p>
      <p className="text-4xl font-bold num mt-1 tracking-tight">{usd(a.equity)}</p>
      <p className={`text-sm num mt-1 ${up ? "text-up" : "text-down"}`}>
        {up ? "+" : ""}
        {usd(a.dayPL)} today
      </p>
      <div className="grid grid-cols-3 gap-2 mt-4">
        <div className="bg-panel-2 rounded-xl p-2">
          <p className="text-[11px] text-muted">Cash</p>
          <p className="num text-sm">{usd(a.cash)}</p>
        </div>
        <div className="bg-panel-2 rounded-xl p-2">
          <p className="text-[11px] text-muted">In trades</p>
          <p className="num text-sm">{usd(a.positionsValue)}</p>
        </div>
        <div className="bg-panel-2 rounded-xl p-2">
          <p className="text-[11px] text-muted">Buying power</p>
          <p className="num text-sm">{usd(a.buyingPower)}</p>
        </div>
      </div>
      {a.accountNumber && <p className="text-[10px] text-muted mt-3">Paper account {a.accountNumber}</p>}
    </div>
  );
}
