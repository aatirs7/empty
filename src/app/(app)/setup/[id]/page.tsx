import Link from "next/link";
import { notFound } from "next/navigation";
import { getCandidateById } from "@/lib/queries";
import { getStockBars } from "@/lib/alpaca";
import { classifyAndScore } from "@/lib/playbook";
import { companyName } from "@/lib/format";

export const dynamic = "force-dynamic";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm py-1.5 border-b border-border last:border-0">
      <span className="text-muted">{label}</span>
      <span className="num">{value}</span>
    </div>
  );
}
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-panel border border-border rounded-2xl p-4">
      <p className="text-sm font-medium mb-1">{title}</p>
      {children}
    </div>
  );
}

export default async function SetupDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await getCandidateById(Number(id));
  if (!c || !c.zone || (c.direction !== "call" && c.direction !== "put")) notFound();
  const z = c.zone as { bottom: number; top: number };
  const dir = c.direction as "call" | "put";
  const isCall = dir === "call";

  let pb: ReturnType<typeof classifyAndScore> | null = null;
  try {
    const bars = await getStockBars(c.symbol, 400);
    pb = classifyAndScore(bars, z, dir, Number(c.price));
  } catch {
    pb = null;
  }

  return (
    <div className="space-y-4">
      <Link href="/setups" className="text-xs text-muted">
        ← Setups
      </Link>

      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight">{c.symbol}</h1>
        <p className="text-sm text-muted">{companyName(c.symbol)}</p>
        <p className={`mt-1 font-medium ${isCall ? "text-up" : "text-down"}`}>
          {isCall ? `Bet ${c.symbol} bounces up off support` : `Bet ${c.symbol} gets pushed down off resistance`}
        </p>
        {pb && (
          <p className="text-xs text-accent mt-1">
            {pb.playbook} · Score {pb.score}/100 {c.setupValid ? "· tapped" : "· approaching"}
          </p>
        )}
      </div>

      <p className="text-sm text-muted text-center leading-relaxed">
        {isCall
          ? `${c.symbol} pulled down into a support zone. The bet is that it bounces up off that level — Vega buys a call when price actually taps it.`
          : `${c.symbol} is rising into a resistance zone. The bet is that it gets rejected back down — Vega buys a put when price actually taps it.`}
      </p>

      <Card title="The zone">
        <Row label="Zone (support/resistance)" value={`${z.bottom} – ${z.top}`} />
        <Row
          label="Zone tap"
          value={isCall ? `top zone tapped ${z.top}` : `bottom zone tapped ${z.bottom}`}
        />
        <Row label="Price now" value={c.price} />
        <Row label="Distance to the edge" value={`${Number(c.distanceToEdgePct).toFixed(2)}%`} />
        <Row label="Approach" value={(c.approach ?? "").replace(/_/g, " ")} />
        <Row label="Clear runway" value={c.clearRunway ? "yes" : "no"} />
        <Row label="Status" value={c.setupValid ? "tapped — live setup" : "approaching (watching)"} />
      </Card>

      {pb && (
        <>
          <Card title="Targets (5–10 day swing)">
            <Row label="Safe target" value={pb.safeTarget ?? "—"} />
            <Row label="Extended target" value={pb.extendedTarget ?? "—"} />
            <Row label="Risk / reward" value={pb.riskReward ?? "—"} />
          </Card>

          <Card title="History at this level">
            <Row label="Prior taps" value={pb.historical.reactions} />
            <Row label="Respected (moved >2%)" value={pb.historical.respected} />
            <Row label="Avg move after" value={`+${pb.historical.avgMovePct}%`} />
            <Row label="Best move" value={`+${pb.historical.maxMovePct}%`} />
            <Row label="Avg duration" value={`${pb.historical.avgDays} days`} />
          </Card>
        </>
      )}

      <p className="text-[11px] text-muted text-center leading-relaxed">
        The zone is the entry level; targets come from daily swing structure, not the zone. Vega only trades this if price
        taps the edge live and the setup scores 80+. Not financial advice.
      </p>
    </div>
  );
}
