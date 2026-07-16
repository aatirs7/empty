import Link from "next/link";
import { getLatestScan, getTodayMonitorTrades, getCandidateTaps } from "@/lib/queries";
import { PageTitle, Empty } from "@/components/ui";
import { companyName, etDateTime } from "@/lib/format";
import { getProfile } from "@/lib/profiles";
import ProfileTabs from "@/components/ProfileTabs";
import { resolveUiProfile } from "@/lib/ui-profiles";
import QqqPrediction from "@/components/QqqPrediction";
import ManualLevels from "@/components/ManualLevels";

export const dynamic = "force-dynamic";

export default async function SetupsPage({ searchParams }: { searchParams: Promise<{ profile?: string }> }) {
  const sp = await searchParams;
  const profileId = resolveUiProfile(sp.profile);

  const tabs = <ProfileTabs />;

  const scan = await getLatestScan(profileId);
  if (!scan) {
    return (
      <div className="space-y-5">
        <PageTitle title="Setups" />
        {tabs}
        {profileId === "qqq_manual" ? (
          <ManualLevels />
        ) : (
          <Empty>No scan yet for {getProfile(profileId).label}. The scanner runs overnight.</Empty>
        )}
      </div>
    );
  }

  const byScore = (a: { score: number | null }, b: { score: number | null }) => (b.score ?? -1) - (a.score ?? -1);
  const valid = scan.candidates.filter((c) => c.setupValid).sort(byScore);
  // QQQ Manual: each setup rides to the NEXT level in its direction (Farrukh's
  // level-to-level plan) — show that target on the card.
  const manualLevels = scan.candidates
    .map((c) => (c.setup as { manual?: { level?: number } } | null)?.manual?.level)
    .filter((n): n is number => n != null);
  const nextLevelFor = (c: { direction: string | null; setup: unknown }): number | null => {
    const lvl = (c.setup as { manual?: { level?: number } } | null)?.manual?.level;
    if (lvl == null) return null;
    const beyond = c.direction === "call" ? manualLevels.filter((l) => l > lvl) : manualLevels.filter((l) => l < lvl);
    return beyond.length ? (c.direction === "call" ? Math.min(...beyond) : Math.max(...beyond)) : null;
  };
  const watching = scan.candidates.filter((c) => !c.setupValid).sort(byScore);
  // Tapped today = the profile's live monitor trades (same funnel value Today shows).
  const tappedToday = (await getTodayMonitorTrades(profileId)).filter((p) => p.strategy !== "no_trade").length;
  // Per-candidate live tap times (for the card badges).
  const taps = await getCandidateTaps(profileId);

  return (
    <div className="space-y-5">
      <PageTitle title="Setups" subtitle={`${getProfile(profileId).label} · scan ${scan.runDate}`} />

      {tabs}

      <p className="text-center text-sm text-muted leading-relaxed">
        {getProfile(profileId).description} Checked{" "}
        <span className="text-foreground font-medium">{scan.candidates.length}</span> names ·{" "}
        <span className="text-foreground font-medium">
          {valid.length} valid setup{valid.length === 1 ? "" : "s"}
        </span>{" "}
        · <span className="text-foreground font-medium">{tappedToday}</span> tapped today.
      </p>

      {profileId === "qqq_0dte" && <QqqPrediction />}
      {profileId === "qqq_manual" && <ManualLevels />}

      {valid.length === 0 ? (
        <Empty>No ready setups from the latest scan. That&apos;s normal on quiet days.</Empty>
      ) : (
        <div className="space-y-3 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-3">
          {valid.map((c, i) => {
            const z = c.zone as { bottom: number; top: number } | null;
            const isCall = c.direction === "call";
            const strong = (c.score ?? 0) >= 80;
            return (
              <Link
                key={c.id}
                href={`/setup/${c.id}`}
                className={`block bg-panel border rounded-2xl p-4 text-center space-y-1 ${strong ? "border-accent" : "border-accent/30"}`}
              >
                <div className="flex items-center justify-center gap-2">
                  {i === 0 && c.score != null && (
                    <span className="text-[10px] uppercase tracking-wide text-accent font-semibold">Top pick</span>
                  )}
                  <div className="text-lg font-bold tracking-tight">
                    {c.symbol} <span className="text-sm text-muted font-normal">{companyName(c.symbol)}</span>
                  </div>
                </div>
                <div className={`text-sm font-medium ${isCall ? "text-up" : "text-down"}`}>
                  {isCall ? `Bet ${c.symbol} bounces up` : `Bet ${c.symbol} gets pushed down`}
                </div>
                <div className="flex items-center justify-center gap-2 text-[11px]">
                  <span
                    className={`px-2 py-0.5 rounded-full font-semibold ${isCall ? "bg-up/15 text-up" : "bg-down/15 text-down"}`}
                  >
                    {isCall ? "CALL" : "PUT"}
                  </span>
                  <span className="text-muted num">
                    {taps[c.id] ? `Tapped ${etDateTime(taps[c.id])}` : "Awaiting retest"}
                  </span>
                </div>
                {c.score != null && (
                  <div className="text-xs num">
                    <span className={strong ? "text-accent font-medium" : "text-muted"}>
                      Confidence {c.score}/100
                    </span>
                    {c.playbook ? <span className="text-muted"> · {c.playbook}</span> : null}
                  </div>
                )}
                {profileId === "qqq_manual" && nextLevelFor(c) != null && (
                  <div className="text-xs num text-accent/90">rides to the next level: {nextLevelFor(c)}</div>
                )}
                {z && (
                  <div className="text-xs text-muted num">
                    zone {z.bottom}–{z.top} · {Number(c.distanceToEdgePct).toFixed(2)}% from the edge · details →
                  </div>
                )}
              </Link>
            );
          })}
        </div>
      )}

      {watching.length > 0 && (
        <details className="bg-panel border border-border rounded-2xl p-4">
          <summary className="text-sm text-muted cursor-pointer list-none select-none">
            {watching.length} more approaching (not tapped yet) ▾
          </summary>
          <div className="mt-3 space-y-1.5">
            {watching.slice(0, 50).map((c) => {
              const z = c.zone as { bottom: number; top: number } | null;
              return (
                <Link key={c.id} href={`/setup/${c.id}`} className="flex justify-between text-xs num">
                  <span>
                    {c.symbol} <span className="text-muted">{c.direction}</span>
                    {c.score != null && <span className="text-muted"> · {c.score}/100</span>}
                  </span>
                  <span className="text-muted">
                    {z ? `${z.bottom}–${z.top}` : ""} · {Number(c.distanceToEdgePct).toFixed(1)}%
                  </span>
                </Link>
              );
            })}
          </div>
        </details>
      )}

      <p className="text-[11px] text-muted text-center leading-relaxed">
        The scanner runs after each close and finds zone taps for the next session. Ready setups are what Vega may
        auto-buy at the open, up to your buying power. Distance is how far price is from the zone edge.
      </p>
    </div>
  );
}
