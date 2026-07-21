import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { backtestRuns } from "@/db/schema";
import { buildStage1Report } from "@/lib/backtest/report";
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
