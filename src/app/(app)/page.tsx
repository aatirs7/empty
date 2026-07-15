import Link from "next/link";
import { getTodayMonitorTrades, getLatestScan } from "@/lib/queries";
import ProposalActions from "@/components/ProposalActions";
import GoalProgress from "@/components/GoalProgress";
import { StatusPill, PageTitle } from "@/components/ui";
import { plainVerdict, confidenceLabel, stripDash, etDateTime } from "@/lib/format";
import { getProfile } from "@/lib/profiles";
import ProfileTabs from "@/components/ProfileTabs";
import { resolveUiProfile } from "@/lib/ui-profiles";

export const dynamic = "force-dynamic";

export default async function TodayPage({ searchParams }: { searchParams: Promise<{ profile?: string }> }) {
  const sp = await searchParams;
  const profileId = resolveUiProfile(sp.profile);
  const profile = getProfile(profileId);
  const [proposals, scan] = await Promise.all([
    getTodayMonitorTrades(profileId),
    getLatestScan(profileId),
  ]);
  const runDate = scan?.runDate ?? new Date().toISOString().slice(0, 10);
  const trades = proposals.filter((p) => p.strategy !== "no_trade");
  const openTrades = trades.filter((p) => p.status !== "closed");
  const closedTrades = trades.filter((p) => p.status === "closed");
  const cands = scan?.candidates ?? [];
  const readyCount = cands.filter((c) => c.setupValid).length; // full count (funnel), NOT the top-5 slice
  const validSetups = cands
    .filter((c) => c.setupValid)
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .slice(0, 5); // rendered list only — the count above is uncapped so Today matches Setups
  // When nothing is tapped/ready, still show the nearest zones approaching (so a
  // profile like QQQ 0DTE — which fires intraday, not from a daily-scan tap —
  // isn't a blank page).
  const approaching = cands
    .filter((c) => !c.setupValid)
    .sort((a, b) => Number(a.distanceToEdgePct) - Number(b.distanceToEdgePct))
    .slice(0, 5);
  const watchList = validSetups.length > 0 ? validSetups : approaching;
  const watchReady = validSetups.length > 0;

  return (
    <div className="space-y-5">
      <PageTitle title="Today" subtitle={`${profile.label} · ${runDate}`} />

      <ProfileTabs />

      <GoalProgress />

      <p className="text-center text-sm text-muted leading-relaxed">
        {stripDash(profile.description)}{" "}
        <span className="text-muted">
          Checked <span className="text-foreground font-medium">{cands.length}</span> names ·{" "}
          <span className="text-foreground font-medium">{readyCount}</span> valid setup{readyCount === 1 ? "" : "s"} ·{" "}
          <span className="text-foreground font-medium">{trades.length}</span> tapped today
          {trades.length > 0 ? ` (${openTrades.length} open, ${closedTrades.length} closed)` : ""}.
        </span>
      </p>

      <Link href={`/setups?profile=${profileId}`} className="block text-center text-xs text-accent">
        See the latest scan &amp; setups &rarr;
      </Link>

      {profileId === "qqq_manual" && (
        <div className="bg-panel border border-accent/30 rounded-2xl p-5 text-center space-y-3">
          <p className="text-sm font-medium">Your levels, Vega&apos;s discipline</p>
          <p className="text-xs text-muted leading-relaxed">
            Each morning, enter the QQQ levels you&apos;ve marked on your 5m, 15m, and 1h charts. Levels below the
            current price become CALL setups (support), levels above become PUT setups (resistance). Vega then watches
            them live all day — but it never buys a bare touch: it waits for a 5-minute candle to actually confirm the
            level (a rejection with real volume), checks that this kind of setup has won at least 60% of the time
            historically, and only picks a same-day contract whose expected payoff beats the spread and time decay.
            If any of those checks fail, it sits out. Positions flatten before the close — nothing held overnight.
          </p>
          <Link
            href="/setups?profile=qqq_manual"
            className="inline-block rounded-xl bg-accent text-white px-5 py-2.5 text-sm font-semibold"
          >
            {cands.length > 0 ? `Update today's levels (${cands.length} set)` : "Add today's levels"}
          </Link>
        </div>
      )}

      <div className="space-y-3">
        {proposals.map((p) => {
          const isTrade = p.strategy !== "no_trade";
          const verdict = plainVerdict(p.strategy, p.symbol);
          const toneClass = verdict.tone === "up" ? "text-up" : verdict.tone === "down" ? "text-down" : "text-muted";
          const plain = stripDash(p.plainExplanation || p.rationale);
          return (
            <div key={p.id} className="bg-panel border border-accent/30 rounded-2xl p-5 text-center space-y-3">
              <div className="mx-auto h-1 w-10 rounded-full bg-accent/70" />
              <div>
                <div className="text-xl font-bold tracking-tight">{p.symbol}</div>
                <div className={`text-sm font-medium ${toneClass}`}>{verdict.title}</div>
              </div>

              {plain && <p className="text-sm text-muted leading-relaxed">{plain}</p>}

              {p.zoneRead && (
                <p className="text-xs text-accent/90 leading-relaxed">
                  <span className="uppercase tracking-wide text-[10px] text-muted">Zone</span> {stripDash(p.zoneRead)}
                </p>
              )}

              {isTrade && (p.strikeHint || p.expiryHint) && (
                <p className="text-xs text-muted num">
                  {p.strikeHint} · {p.expiryHint}
                </p>
              )}

              {p.variant === "news_plus_zones" ? (
                <div className="text-xs text-muted">
                  Setup score <span className="num">{Math.round(Number(p.confidence) * 100)}</span>/100
                  {p.createdAt && <span className="num"> · alerted {etDateTime(p.createdAt)}</span>}
                </div>
              ) : (
                <div className="text-xs text-muted">
                  {confidenceLabel(p.confidence)} · <span className="num">{Math.round(Number(p.confidence) * 100)}%</span> sure
                </div>
              )}

              {isTrade && p.status === "pending" ? (
                <div className="pt-1 space-y-2">
                  <ProposalActions id={p.id} />
                  <Link href={`/proposal/${p.id}`} className="block text-xs text-accent">
                    See what you could make or lose →
                  </Link>
                </div>
              ) : isTrade ? (
                <div className="flex items-center justify-center gap-3">
                  <StatusPill status={p.status} />
                  <Link href={`/proposal/${p.id}`} className="text-xs text-accent">
                    Details →
                  </Link>
                </div>
              ) : (
                <Link href={`/proposal/${p.id}`} className="text-xs text-accent">
                  Why sit out? →
                </Link>
              )}
            </div>
          );
        })}
      </div>

      {openTrades.length === 0 && watchList.length > 0 && (
        <div className="space-y-2">
          <p className="text-center text-xs text-muted leading-relaxed">
            {watchReady
              ? closedTrades.length > 0
                ? "No open trades right now. Vega is watching these top setups live and will auto-buy the moment one taps its zone."
                : "No trades placed yet today. Vega is watching these top setups live and will auto-buy the moment one taps its zone."
              : "Nothing has tapped a zone yet today. These are the nearest zones approaching — Vega auto-buys the moment one is tapped and confirmed."}
          </p>
          {watchList.map((c) => {
            const isCall = c.direction === "call";
            return (
              <Link
                key={c.id}
                href={`/setup/${c.id}`}
                className="flex items-center justify-between bg-panel border border-border rounded-2xl px-4 py-3"
              >
                <span className="text-sm">
                  <span className="font-medium">{c.symbol}</span>{" "}
                  <span className={isCall ? "text-up" : "text-down"}>{isCall ? "bounce up" : "push down"}</span>
                </span>
                <span className="text-xs text-muted num">
                  {watchReady
                    ? c.score != null
                      ? `${c.score}/100`
                      : ""
                    : `${Number(c.distanceToEdgePct).toFixed(1)}% away`}
                </span>
              </Link>
            );
          })}
          <Link href={`/setups?profile=${profileId}`} className="block text-center text-xs text-accent pt-1">
            See all setups →
          </Link>
        </div>
      )}

      {openTrades.length === 0 && watchList.length === 0 && (
        <p className="text-center text-xs text-muted leading-relaxed">
          {profileId === "qqq_manual"
            ? "No levels entered for today yet. Add your morning levels with the button above, or on the "
            : profileId === "qqq_0dte"
              ? "No QQQ zone in play right now. QQQ 0DTE fires intraday when price reaches a Daily/4H level — see the live prediction on the "
              : "No setups in play right now. The scanner runs after each close — check back, or see the "}
          <Link href={`/setups?profile=${profileId}`} className="text-accent">
            Setups page →
          </Link>
        </p>
      )}
    </div>
  );
}
