/**
 * Daily report generator. Assembles EVERYTHING the bot did (and considered) today
 * into (a) a short Discord summary embed and (b) a full Markdown report attached as
 * a file. The goal is research: every trade carries its reasoning, every position
 * its P&L, and every skipped setup its reason — so strategy can be tuned from
 * evidence. All numbers are code-computed from the DB + the live broker.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { researchRuns, proposals, orders, candidates, activityLog } from "../db/schema";
import { getBroker } from "./broker";
import { getProfileCost } from "./cost";
import { getProfile } from "./profiles";
import { UI_PROFILE_IDS } from "./ui-profiles";

const money = (n: number | null | undefined) => (n == null ? "—" : `${n >= 0 ? "" : "-"}$${Math.abs(n).toFixed(2)}`);
const signMoney = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
const et = (d: Date | string | null) => (d ? new Date(d).toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" }) : "—");

export interface ReportOutput {
  date: string;
  embed: { title: string; description: string; color: number; fields: { name: string; value: string; inline?: boolean }[] };
  markdown: string;
  filename: string;
  hasActivity: boolean;
}

export async function buildDailyReport(runDate = new Date().toISOString().slice(0, 10)): Promise<ReportOutput> {
  const dayStart = new Date(`${runDate}T00:00:00Z`);

  // Today's monitor proposals (the live trading path) + their orders.
  const monRuns = await db
    .select({ id: researchRuns.id })
    .from(researchRuns)
    .where(and(eq(researchRuns.model, "monitor"), eq(researchRuns.runDate, runDate)));
  const runIds = monRuns.map((r) => r.id);
  const allProps = runIds.length
    ? await db.select().from(proposals).where(inArray(proposals.runId, runIds)).orderBy(proposals.createdAt)
    : [];
  // Exclude shelved/quarantined profiles (zones_legacy) from the active report.
  const props = allProps.filter((p) => !getProfile(p.profileId).shelved);
  const propIds = props.map((p) => p.id);
  const ords = propIds.length ? await db.select().from(orders).where(inArray(orders.proposalId, propIds)) : [];
  const orderByProp = new Map(ords.map((o) => [o.proposalId, o]));

  // Activity log (buys/sells/skips) for today.
  const acts = await db.select().from(activityLog).where(eq(activityLog.runDate, runDate)).orderBy(activityLog.createdAt);

  // Closed-today orders (exits with realized P&L).
  const soldToday = await db.select().from(orders).where(gte(orders.exitAt, dayStart)).orderBy(desc(orders.exitAt));

  // Per-profile: live positions, P&L, cost, scan counts.
  const perProfile: Record<string, {
    label: string; positions: Awaited<ReturnType<ReturnType<typeof getBroker>["listPositions"]>>;
    tradePL: number; cost: number; net: number; scanned: number; valid: number;
  }> = {};
  for (const pid of UI_PROFILE_IDS) {
    const broker = getBroker(pid);
    const positions = await broker.listPositions().catch(() => []);
    const pl = await broker.getPortfolioPL().catch(() => ({ totalPL: 0 } as { totalPL: number }));
    const cost = await getProfileCost(pid);
    const [c] = await db
      .select({ n: sql<string>`count(*)`, v: sql<string>`sum(case when ${candidates.setupValid} then 1 else 0 end)` })
      .from(candidates)
      .where(and(eq(candidates.profileId, pid), eq(candidates.runDate, runDate)));
    perProfile[pid] = {
      label: getProfile(pid).label,
      positions,
      tradePL: pl.totalPL,
      cost: cost.total,
      net: Math.round((pl.totalPL - cost.total) * 100) / 100,
      scanned: Number(c?.n ?? 0),
      valid: Number(c?.v ?? 0),
    };
  }

  const trades = props.filter((p) => p.strategy !== "no_trade");
  const buys = acts.filter((a) => a.kind === "buy");
  const sells = acts.filter((a) => a.kind === "sell");
  const skips = acts.filter((a) => a.kind === "skip");
  const hasActivity = trades.length > 0 || acts.length > 0 || soldToday.length > 0;

  // ---- Markdown (full detail) ----
  const L: string[] = [];
  L.push(`# Vega Daily Report — ${runDate}`, "");
  L.push(`_Generated ${et(new Date())} ET. Paper trading. All numbers code-computed._`, "");

  L.push(`## Bottom line`, "");
  for (const pid of UI_PROFILE_IDS) {
    const p = perProfile[pid];
    L.push(
      `- **${p.label}**: net ${signMoney(p.net)} (trade ${signMoney(p.tradePL)} − API ${money(p.cost)}) · ` +
        `${p.positions.length} open · scanned ${p.scanned} (${p.valid} ready)`,
    );
  }
  L.push("");

  // Trades ACTUALLY placed (have an order) vs signals that fired but weren't
  // auto-executed (e.g. shelved zones_legacy, or no affordable contract).
  const executed = trades.filter((p) => orderByProp.has(p.id));
  const signals = trades.filter((p) => !orderByProp.has(p.id));

  L.push(`## Trades placed today (${executed.length})`, "");
  if (executed.length === 0) L.push("_No trades executed._", "");
  for (const p of executed) {
    const o = orderByProp.get(p.id)!;
    const prof = getProfile(p.profileId);
    L.push(`### ${prof.label} · ${p.symbol} ${p.direction ?? ""} — ${et(p.createdAt)}`);
    L.push(`- Contract: ${o.contractSymbol ?? "?"} · ${o.qty ?? 1}x @ ${money(o.filledPrice ? Number(o.filledPrice) : o.limitPrice ? Number(o.limitPrice) : null)} · mode ${o.executionMode}`);
    L.push(`- Max loss: ${money(o.maxLoss ? Number(o.maxLoss) : null)} · breakeven ${o.breakeven ?? "?"}`);
    L.push(`- Confidence (code): ${p.confidence != null ? Math.round(Number(p.confidence) * 100) : "?"}`);
    if (p.zoneRead) L.push(`- **Why**: ${p.zoneRead}`);
    else if (p.rationale) L.push(`- **Why**: ${p.rationale}`);
    if (p.plainExplanation) L.push(`- Plain: ${p.plainExplanation}`);
    L.push(`- Status: **${p.status}**`);
    if (o.exitAt) L.push(`- Exit: ${money(o.exitPrice ? Number(o.exitPrice) : null)} · **P&L ${money(o.realizedPl ? Number(o.realizedPl) : null)}** · ${o.exitReason ?? ""} (${et(o.exitAt)})`);
    L.push("");
  }

  // Signals not executed
  L.push(`## Signals fired but NOT executed (${signals.length})`, "");
  if (signals.length === 0) L.push("_None._");
  for (const p of signals) {
    const prof = getProfile(p.profileId);
    L.push(`- **${prof.label}** ${p.symbol} ${p.direction ?? ""} (${et(p.createdAt)}) — ${p.zoneRead ?? p.rationale ?? ""} [status: ${p.status}]`);
  }
  L.push("");

  // Positions still open
  L.push(`## Positions still open at close`, "");
  let anyOpen = false;
  for (const pid of UI_PROFILE_IDS) {
    for (const pos of perProfile[pid].positions) {
      anyOpen = true;
      const upl = pos.unrealized_pl != null ? Number(pos.unrealized_pl) : null;
      L.push(`- **${perProfile[pid].label}** ${pos.symbol}: ${pos.qty} @ ${money(Number(pos.avg_entry_price))} → now ${money(pos.current_price ? Number(pos.current_price) : null)} · unrealized ${money(upl)}`);
    }
  }
  if (!anyOpen) L.push("_Flat — no open positions._");
  L.push("");

  // Sold today
  L.push(`## Positions closed today (${soldToday.length})`, "");
  if (soldToday.length === 0) L.push("_None._");
  let realizedTotal = 0;
  for (const o of soldToday) {
    const pl = o.realizedPl != null ? Number(o.realizedPl) : 0;
    realizedTotal += pl;
    L.push(`- ${o.contractSymbol ?? "?"}: ${money(o.filledPrice ? Number(o.filledPrice) : null)} → ${money(o.exitPrice ? Number(o.exitPrice) : null)} · **${money(pl)}** · ${o.exitReason ?? ""} (${et(o.exitAt)})`);
  }
  if (soldToday.length) L.push("", `**Realized today: ${signMoney(Math.round(realizedTotal * 100) / 100)}**`);
  L.push("");

  // Skips (why it passed)
  const skipReasons = new Map<string, number>();
  for (const s of skips) {
    const key = (s.detail ?? "").replace(/[0-9.]+/g, "").replace(/\s+/g, " ").trim().slice(0, 40) || "other";
    skipReasons.set(key, (skipReasons.get(key) ?? 0) + 1);
  }
  L.push(`## Setups considered but NOT taken (${skips.length})`, "");
  if (skips.length === 0) L.push("_No zone crossings were rejected today._");
  else {
    L.push("By reason:");
    for (const [reason, n] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1])) L.push(`- ${reason}: ${n}`);
    L.push("", "Detail:");
    for (const s of skips.slice(0, 80)) L.push(`- ${et(s.createdAt)} ${s.symbol ?? ""} ${s.direction ?? ""} — ${s.detail ?? ""}`);
  }
  L.push("");

  // Decision timeline
  L.push(`## Buy / sell timeline`, "");
  if (buys.length + sells.length === 0) L.push("_No fills._");
  for (const a of acts.filter((x) => x.kind !== "skip")) {
    L.push(`- ${et(a.createdAt)} **${a.kind.toUpperCase()}** ${a.symbol ?? ""} ${a.direction ?? ""} — ${a.detail ?? ""}`);
  }
  L.push("");

  // Account P&L + cost
  L.push(`## Accounts`, "");
  for (const pid of UI_PROFILE_IDS) {
    const p = perProfile[pid];
    L.push(`- **${p.label}**: trade P&L ${signMoney(p.tradePL)} · API cost ${money(p.cost)} · **net ${signMoney(p.net)}**`);
  }
  L.push("");
  L.push(`---`, `Scan: ${UI_PROFILE_IDS.map((pid) => `${perProfile[pid].label} ${perProfile[pid].scanned}/${perProfile[pid].valid} ready`).join(" · ")}`);

  // ---- Summary embed ----
  const totalNet = UI_PROFILE_IDS.reduce((s, pid) => s + perProfile[pid].net, 0);
  const embed = {
    title: `Vega Daily Report — ${runDate}`,
    description:
      `**Net ${signMoney(Math.round(totalNet * 100) / 100)}** across accounts · ` +
      `${executed.length} trades · ${sells.length} sold · ${skips.length} setups passed on.\nFull detail attached ⤵`,
    color: totalNet >= 0 ? 0x2ecc71 : 0xe74c3c,
    fields: UI_PROFILE_IDS.map((pid) => {
      const p = perProfile[pid];
      return {
        name: p.label,
        value: `net ${signMoney(p.net)}\n${p.positions.length} open · ${executed.filter((t) => t.profileId === pid).length} traded`,
        inline: true,
      };
    }),
  };

  return { date: runDate, embed, markdown: L.join("\n"), filename: `vega-report-${runDate}.md`, hasActivity };
}
