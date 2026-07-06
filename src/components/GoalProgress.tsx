"use client";
import { useEffect, useState } from "react";
import { usd } from "@/lib/format";

interface Goal {
  weeklyPL: number;
  goal: number;
  pct: number;
  goalMet: boolean;
  autoManage: boolean;
}

export default function GoalProgress() {
  const [g, setG] = useState<Goal | null>(null);
  useEffect(() => {
    fetch("/api/goal")
      .then((r) => r.json())
      .then((j) => (j.ok ? setG(j) : null))
      .catch(() => {});
  }, []);

  if (!g || !g.goal) return null;
  const down = g.weeklyPL < 0;
  const barPct = down ? 0 : g.pct;
  const barColor = g.goalMet ? "bg-up" : down ? "bg-down" : "bg-accent";
  const msgColor = g.goalMet ? "text-up" : down ? "text-down" : "text-foreground";

  return (
    <div className="bg-panel border border-border rounded-2xl p-4">
      <div className="flex justify-between items-baseline">
        <p className="text-xs text-muted">This week&apos;s goal</p>
        <p className="text-xs text-muted num">
          {usd(g.weeklyPL)} / {usd(g.goal)}
        </p>
      </div>
      <div className="mt-2 h-2.5 rounded-full bg-border overflow-hidden">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${barPct}%` }} />
      </div>
      <p className={`text-sm mt-2 text-center ${msgColor}`}>
        {g.goalMet
          ? g.autoManage
            ? "Goal reached. Vega is locking in gains."
            : "Goal reached this week."
          : down
            ? `Down ${usd(Math.abs(g.weeklyPL))} so far this week.`
            : `${g.pct}% of the way there.`}
      </p>
    </div>
  );
}
