"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

interface Initial {
  autoExecute: boolean;
  autoMinConfidence: number;
  maxAutoTradesPerDay: number;
  autoManage: boolean;
  weeklyGoal: number;
  riskTolerance: string;
  perTradeBudget: number;
  maxContracts: number;
  maxContractPrice: number;
}

const RISK: { key: string; label: string; hint: string }[] = [
  { key: "conservative", label: "Careful", hint: "Take profits early, cut losses fast." },
  { key: "balanced", label: "Balanced", hint: "A middle-ground." },
  { key: "aggressive", label: "Bold", hint: "Let winners run, tolerate bigger swings." },
];

export default function SettingsForm({ initial }: { initial: Initial }) {
  const router = useRouter();
  const [autoExecute, setAutoExecute] = useState(initial.autoExecute);
  const [minConf, setMinConf] = useState(initial.autoMinConfidence);
  const [maxTrades, setMaxTrades] = useState(initial.maxAutoTradesPerDay);
  const [autoManage, setAutoManage] = useState(initial.autoManage);
  const [goal, setGoal] = useState(initial.weeklyGoal);
  const [risk, setRisk] = useState(initial.riskTolerance);
  const [budget, setBudget] = useState(initial.perTradeBudget);
  const [maxPrice, setMaxPrice] = useState(initial.maxContractPrice);
  const [maxContracts, setMaxContracts] = useState(initial.maxContracts);
  const [busy, setBusy] = useState(false);

  async function save(patch: Partial<Initial>) {
    setBusy(true);
    await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    setBusy(false);
    router.refresh();
  }

  const anyAuto = autoExecute || autoManage;

  async function killAll() {
    setAutoExecute(false);
    setAutoManage(false);
    await save({ autoExecute: false, autoManage: false });
  }

  return (
    <div className="space-y-5">
      {anyAuto && (
        <div className="bg-accent/15 border border-accent/40 rounded-2xl p-4 text-center">
          <p className="text-accent text-sm font-medium">
            {autoExecute && autoManage ? "Vega is on autopilot" : autoExecute ? "Auto-buy is on" : "Auto-manage is on"}
          </p>
          <p className="text-xs text-muted mt-1">
            Vega is making paper trades on its own. Turn it off any time.
          </p>
          <button
            onClick={killAll}
            disabled={busy}
            className="mt-3 w-full rounded-lg bg-accent text-white py-2.5 font-medium disabled:opacity-40"
          >
            Turn everything OFF now
          </button>
        </div>
      )}

      {/* Weekly goal + auto-manage */}
      <div className="bg-panel border border-border rounded-2xl p-4 space-y-4">
        <p className="text-sm font-medium text-center">Weekly goal</p>

        <label className="flex items-center justify-between text-sm">
          <span>How much do you want to make each week?</span>
          <span className="flex items-center gap-1">
            <span className="text-muted">$</span>
            <input
              type="number"
              min={0}
              step={25}
              value={goal}
              onChange={(e) => setGoal(Number(e.target.value))}
              onBlur={() => save({ weeklyGoal: goal })}
              className="w-20 rounded-lg bg-panel-2 border border-border px-2 py-1 num text-right"
            />
          </span>
        </label>

        <div>
          <p className="text-sm mb-2">Risk tolerance</p>
          <div className="grid grid-cols-3 gap-2">
            {RISK.map((r) => (
              <button
                key={r.key}
                onClick={() => {
                  setRisk(r.key);
                  save({ riskTolerance: r.key });
                }}
                className={`py-2 rounded-xl text-sm border ${
                  risk === r.key ? "border-accent text-accent bg-accent/10 font-medium" : "border-border text-muted"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted mt-2 text-center">{RISK.find((r) => r.key === risk)?.hint}</p>
        </div>

        <label className="flex items-center justify-between pt-1">
          <span>
            <span className="block text-sm font-medium">Let Vega manage trades for me</span>
            <span className="block text-xs text-muted">Closes winners and losers on its own, toward the goal.</span>
          </span>
          <input
            type="checkbox"
            checked={autoManage}
            onChange={(e) => {
              setAutoManage(e.target.checked);
              save({ autoManage: e.target.checked });
            }}
            className="h-6 w-6 accent-[var(--accent)]"
          />
        </label>
      </div>

      {/* Position sizing */}
      <div className="bg-panel border border-border rounded-2xl p-4 space-y-4">
        <p className="text-sm font-medium text-center">How it sizes each trade</p>

        <label className="flex items-center justify-between text-sm">
          <span>Spend up to (per trade)</span>
          <span className="flex items-center gap-1">
            <span className="text-muted">$</span>
            <input
              type="number"
              min={20}
              step={25}
              value={budget}
              onChange={(e) => setBudget(Number(e.target.value))}
              onBlur={() => save({ perTradeBudget: budget })}
              className="w-20 rounded-lg bg-panel-2 border border-border px-2 py-1 num text-right"
            />
          </span>
        </label>

        <label className="flex items-center justify-between text-sm">
          <span>Only buy options cheaper than</span>
          <span className="flex items-center gap-1">
            <span className="text-muted">$</span>
            <input
              type="number"
              min={0.2}
              step={0.5}
              value={maxPrice}
              onChange={(e) => setMaxPrice(Number(e.target.value))}
              onBlur={() => save({ maxContractPrice: maxPrice })}
              className="w-20 rounded-lg bg-panel-2 border border-border px-2 py-1 num text-right"
            />
          </span>
        </label>

        <label className="flex items-center justify-between text-sm">
          <span>Most contracts per trade</span>
          <input
            type="number"
            min={1}
            max={20}
            value={maxContracts}
            onChange={(e) => setMaxContracts(Number(e.target.value))}
            onBlur={() => save({ maxContracts })}
            className="w-16 rounded-lg bg-panel-2 border border-border px-2 py-1 num text-right"
          />
        </label>

        <p className="text-[11px] text-muted text-center">
          Vega hunts cheap out-of-the-money contracts (big upside if the move is right) and buys as many as your budget
          allows, up to the cap.
        </p>
      </div>

      {/* Auto-buy */}
      <div className="bg-panel border border-border rounded-2xl p-4 space-y-4">
        <label className="flex items-center justify-between">
          <span>
            <span className="block text-sm font-medium">Let Vega buy trades for me</span>
            <span className="block text-xs text-muted">Auto-buys the most confident ideas each morning.</span>
          </span>
          <input
            type="checkbox"
            checked={autoExecute}
            onChange={(e) => {
              setAutoExecute(e.target.checked);
              save({ autoExecute: e.target.checked });
            }}
            className="h-6 w-6 accent-[var(--accent)]"
          />
        </label>

        <div>
          <div className="flex justify-between text-sm">
            <span>Only buy when Vega is at least</span>
            <span className="num text-muted">{Math.round(minConf * 100)}% sure</span>
          </div>
          <input
            type="range"
            min={0.5}
            max={0.95}
            step={0.05}
            value={minConf}
            onChange={(e) => setMinConf(Number(e.target.value))}
            onPointerUp={() => save({ autoMinConfidence: minConf })}
            className="w-full accent-[var(--accent)]"
          />
        </div>

        <label className="flex items-center justify-between text-sm">
          <span>Most auto-buys per day</span>
          <input
            type="number"
            min={1}
            max={5}
            value={maxTrades}
            onChange={(e) => setMaxTrades(Number(e.target.value))}
            onBlur={() => save({ maxAutoTradesPerDay: maxTrades })}
            className="w-16 rounded-lg bg-panel-2 border border-border px-2 py-1 num text-right"
          />
        </label>
      </div>

      <p className="text-[11px] text-muted text-center">
        Everything here is paper-only and keeps the same 1-contract and open-position caps. Changes save automatically.
      </p>
    </div>
  );
}
