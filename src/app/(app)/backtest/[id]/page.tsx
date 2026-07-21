import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { backtestRuns } from "@/db/schema";
import { buildStage1Report, buildStage2Report, type Stage2TradeStats } from "@/lib/backtest/report";
import { PageTitle } from "@/components/ui";

export const dynamic = "force-dynamic";

const PROFILE_LABELS: Record<string, string> = { sniper_swing: "SBv1", sbv2: "SBv2" };
const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 1000) / 10}%`);
const pctRaw = (x: number | null | undefined) => (x == null ? "—" : `${x}%`);

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-panel border border-border rounded-2xl px-4 py-3 space-y-2">
      <h2 className="text-sm font-medium">{title}</h2>
      {children}
    </div>
  );
}

export default async function BacktestRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const runId = Number(id);
  if (!Number.isFinite(runId)) notFound();
  const [run] = await db.select().from(backtestRuns).where(eq(backtestRuns.id, runId));
  if (!run) notFound();

  if (run.status !== "complete") {
    return (
      <div className="space-y-5">
        <PageTitle title={`Backtest run #${runId}`} subtitle={`${run.fromDate} → ${run.toDate}`} />
        <Section title="Status">
          <p className="text-sm text-muted">
            This run is <span className={run.status === "failed" ? "text-down" : ""}>{run.status}</span>
            {run.error ? ` — ${run.error}` : "."}
          </p>
        </Section>
        <Link href="/backtest" className="block text-center text-xs text-accent">All runs &rarr;</Link>
      </div>
    );
  }

  if (run.stage === 2) return <Stage2View runId={runId} run={{ profileId: run.profileId, fromDate: run.fromDate, toDate: run.toDate, windowVariantCount: run.windowVariantCount }} />;

  const r = await buildStage1Report(runId);
  const b = r.baselines;

  return (
    <div className="space-y-5">
      <PageTitle
        title={`${PROFILE_LABELS[run.profileId] ?? run.profileId} backtest #${runId}`}
        subtitle={`${run.fromDate} → ${run.toDate} · ${r.n} signals · variant #${run.windowVariantCount} of this window`}
      />

      <Section title="Run">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs num">
          {Object.entries(r.header)
            .filter(([, v]) => v !== "")
            .map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2">
                <span className="text-muted">{k}</span>
                <span className="text-right break-all">{String(v)}</span>
              </div>
            ))}
        </div>
      </Section>

      <Section title="Hit rate — target reached before invalidation">
        <div className="flex items-baseline justify-around text-center">
          <div>
            <div className="text-2xl num">{pct(r.hitRateAll)}</div>
            <div className="text-xs text-muted">all {r.n} signals</div>
          </div>
          <div>
            <div className="text-2xl num">{pct(r.hitRateCapConstrained)}</div>
            <div className="text-xs text-muted">cap-constrained (3/day)</div>
          </div>
        </div>
        {r.truncated > 0 && <p className="text-[11px] text-muted">{r.truncated} signals had truncated outcome windows (fired near the window end).</p>}
      </Section>

      <Section title="Calibration — is the reaction DB honest?">
        <p className="text-[11px] text-muted">Stated probability vs what actually happened. If the 80+ bucket doesn&apos;t beat 50-60, the probability number is decoration.</p>
        <table className="w-full text-xs num">
          <thead>
            <tr className="text-muted">
              <th className="text-left font-normal">stated</th>
              <th className="text-right font-normal">n</th>
              <th className="text-right font-normal">realized</th>
            </tr>
          </thead>
          <tbody>
            {r.calibration.filter((c) => c.n > 0).map((c) => (
              <tr key={c.bucket}>
                <td>{c.bucket}%</td>
                <td className="text-right">{c.n}</td>
                <td className="text-right">{pctRaw(c.realizedPct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Timing & adverse moves">
        <div className="text-xs space-y-1 num">
          <p>
            Stated median hold <span className="text-foreground/90">{r.timing.statedMedianBars ?? "—"} bars</span> vs realized{" "}
            <span className="text-foreground/90">{r.timing.realizedMedianBars ?? "—"} bars</span> to target.
          </p>
          {r.mae && (
            <>
              <p>
                MAE (worst drawdown before resolution): p25 {pct(r.mae.p25)} · p50 {pct(r.mae.p50)} · p75 {pct(r.mae.p75)} · p90 {pct(r.mae.p90)}
              </p>
              <p className="text-muted">
                Winners average {pct(r.mae.winners)} against vs losers {pct(r.mae.losers)} — this is what should set stops, empirically.
              </p>
            </>
          )}
          <p className="text-muted">Tie rate (target + invalidation same bar, ruled against the signal): {r.tieRatePct ?? "—"}% · gap-through entries: {r.gapThroughRatePct ?? "—"}%</p>
        </div>
      </Section>

      <Section title="Edge vs baselines">
        <div className="text-xs space-y-1 num">
          <p>
            Signal mean returns: +1d {pct(r.meanRets.r1)} · +3d {pct(r.meanRets.r3)} · +5d {pct(r.meanRets.r5)} · +10d {pct(r.meanRets.r10)}
          </p>
          {b && (
            <>
              <p>
                Random entries (same names/directions/target distances, n={b.randomN}): target touched {pct(b.randomTargetTouchedRate)} · +1d {pct(b.randomRet1d)} · +3d {pct(b.randomRet3d)} · +5d {pct(b.randomRet5d)} · +10d {pct(b.randomRet10d)}
              </p>
              <p>
                SPY buy-and-hold over the window: <span className="text-foreground/90">{b.spyReturnPct != null ? `${b.spyReturnPct}%` : "—"}</span> · window: {b.windowCharacter}
              </p>
              <p className="text-muted">A signal that doesn&apos;t beat random entry timing on the same names has no edge.</p>
            </>
          )}
        </div>
      </Section>

      <Section title="Per setup type">
        <table className="w-full text-xs num">
          <thead>
            <tr className="text-muted">
              <th className="text-left font-normal">playbook</th>
              <th className="text-right font-normal">n</th>
              <th className="text-right font-normal">hit</th>
            </tr>
          </thead>
          <tbody>
            {r.perPlaybook.map((p) => (
              <tr key={p.playbook}>
                <td>{p.playbook}</td>
                <td className="text-right">{p.n}</td>
                <td className="text-right">{pctRaw(p.hitRatePct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Honest limitations — read before believing anything above">
        <ul className="text-[11px] text-muted space-y-1.5 list-disc pl-4">
          {r.limitations.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
        <p className="text-[11px] text-foreground/80">
          Decision gate: if there is no edge on the underlying here, stop — no options structure or exit tuning rescues a signal that can&apos;t predict the stock.
        </p>
      </Section>

      <Link href="/backtest" className="block text-center text-xs text-accent">All runs &rarr;</Link>
    </div>
  );
}

const usd = (x: number | null | undefined) => (x == null ? "—" : `${x < 0 ? "-" : "+"}$${Math.abs(Math.round(x * 100) / 100)}`);

function StatsBlock({ s }: { s: Stage2TradeStats }) {
  return (
    <div className="text-xs space-y-1 num">
      <p>
        n={s.n} · net <span className={s.netPl >= 0 ? "text-up" : "text-down"}>{usd(s.netPl)}</span> · win rate {s.winRate ?? "—"}%
      </p>
      <p className="text-muted">
        avg win {usd(s.avgWinUsd)} ({s.avgWinPct != null ? Math.round(s.avgWinPct) : "—"}%) vs avg loss {usd(s.avgLossUsd)} ({s.avgLossPct != null ? Math.round(s.avgLossPct) : "—"}%)
      </p>
    </div>
  );
}

async function Stage2View({ runId, run }: { runId: number; run: { profileId: string; fromDate: string; toDate: string; windowVariantCount: number } }) {
  const r = await buildStage2Report(runId);
  return (
    <div className="space-y-5">
      <PageTitle
        title={`${PROFILE_LABELS[run.profileId] ?? run.profileId} backtest #${runId} — Stage 2 (options P&L)`}
        subtitle={`${run.fromDate} → ${run.toDate} · ${r.header.signals} signals · real historical chains + modeled spread`}
      />

      <Section title="Portfolio — what the live account would have done (caps applied)">
        <div className="flex items-baseline justify-around text-center">
          <div>
            <div className={`text-2xl num ${r.portfolio.pl >= 0 ? "text-up" : "text-down"}`}>{usd(r.portfolio.pl)}</div>
            <div className="text-xs text-muted">net P&L · $1000 start → ${r.portfolio.endEquity}</div>
          </div>
          <div>
            <div className="text-2xl num">{r.portfolio.taken}</div>
            <div className="text-xs text-muted">trades taken</div>
          </div>
        </div>
        <p className="text-xs text-muted num">max drawdown {usd(r.portfolio.maxDrawdown)} · longest losing streak {r.portfolio.worstStreak}</p>
        <StatsBlock s={r.portfolio.stats} />
      </Section>

      <Section title="All signals (every one that found a fillable contract)">
        <StatsBlock s={r.allSignals} />
        <p className="text-[11px] text-muted num">skipped as unfillable: {Object.entries(r.skips).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}</p>
      </Section>

      <Section title="Return distribution (% on premium)">
        <table className="w-full text-xs num">
          <tbody>
            {Object.entries(r.allSignals.returnDistribution).map(([b, n]) => (
              <tr key={b}>
                <td>{b}%</td>
                <td className="text-right">{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Exit reasons">
        <table className="w-full text-xs num">
          <tbody>
            {Object.entries(r.allSignals.byExitReason).map(([reason, x]) => (
              <tr key={reason}>
                <td>{reason}</td>
                <td className="text-right">n={x.n}</td>
                <td className={`text-right ${x.pl >= 0 ? "text-up" : "text-down"}`}>{usd(x.pl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Sensitivity — same trades, worse fills">
        <div className="text-xs space-y-1 num">
          {Object.entries(r.sensitivity).map(([k, s]) => (
            <p key={k}>
              {k}: net <span className={s.netPl >= 0 ? "text-up" : "text-down"}>{usd(s.netPl)}</span> · win {s.winRate ?? "—"}%
            </p>
          ))}
          <p className="text-muted">If profitability disappears under realistic fills, it was never there.</p>
        </div>
      </Section>

      <Section title="Benchmark">
        <p className="text-xs num">SPY buy-and-hold over the window: {r.spy.spyReturnPct != null ? `${r.spy.spyReturnPct}%` : "—"} · {r.spy.windowCharacter}</p>
      </Section>

      <Section title="Assumptions (every fill is modeled per these)">
        <ul className="text-[11px] text-muted space-y-1.5 list-disc pl-4">
          {Object.entries(r.assumptions).map(([k, v]) => (
            <li key={k}>
              <span className="text-foreground/70">{k}:</span> {typeof v === "string" ? v : JSON.stringify(v)}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Honest limitations">
        <ul className="text-[11px] text-muted space-y-1.5 list-disc pl-4">
          {r.limitations.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </Section>

      <Link href="/backtest" className="block text-center text-xs text-accent">All runs &rarr;</Link>
    </div>
  );
}
