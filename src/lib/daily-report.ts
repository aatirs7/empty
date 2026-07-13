/**
 * Daily report generator. Assembles EVERYTHING the bot did (and considered) today
 * into (a) a short Discord summary embed and (b) a full Markdown report attached as
 * a file. The goal is research: every trade carries its reasoning, every position
 * its P&L, and every skipped setup its reason — so strategy can be tuned from
 * evidence. All numbers are code-computed from the DB + the live broker.
 */
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import { researchRuns, proposals, orders, candidates, activityLog } from "../db/schema";
import { getBroker } from "./broker";
import { getStockBars } from "./alpaca";
import { getProfileCost } from "./cost";
import { getProfile } from "./profiles";
import { getProfileSettings } from "./profile-settings";
import { UI_PROFILE_IDS } from "./ui-profiles";

const money = (n: number | null | undefined) => (n == null ? "—" : `${n >= 0 ? "" : "-"}$${Math.abs(n).toFixed(2)}`);
const signMoney = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
const et = (d: Date | string | null) => (d ? new Date(d).toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" }) : "—");

/** Turn a raw skip detail into a short, plain-English reason. */
function friendlyReason(detail: string): string {
  const s = detail.toLowerCase();
  if (s.includes("probability")) return "probability too low";
  if (s.includes("weekly-options potential") || s.includes("weekly potential")) return "weekly potential too low";
  if (s.includes("execution quality")) return "weak confirmation candle";
  if (s.includes("risk/reward")) return "poor risk/reward";
  if (s.includes("too small")) return "expected move too small";
  if (s.includes("score")) return "quality score too low";
  if (s.includes("catalyst")) return "earnings/Fed catalyst nearby";
  if (s.includes("rarely respected")) return "zone rarely respected historically";
  if (s.includes("thin history")) return "thin history at the level";
  if (s.includes("low sample")) return "not enough historical sample";
  if (s.includes("horizon")) return "no contract fit the horizon";
  if (s.includes("fighting")) return "against the market trend";
  return detail.replace(/rejected:\s*/i, "").slice(0, 30).trim();
}

export interface ReportOutput {
  date: string;
  embed: { title: string; description: string; color: number; fields: { name: string; value: string; inline?: boolean }[] };
  narrative: string; // plain-English recap for the Discord message body
  markdown: string;
  filename: string;
  hasActivity: boolean;
}

/** Sum realized P&L of closed orders within [from, to). */
const sumRealized = (rows: { rp: string | null; exitAt: Date | null }[], from: Date, to?: Date) =>
  Math.round(
    rows
      .filter((r) => r.exitAt && r.exitAt >= from && (!to || r.exitAt < to))
      .reduce((s, r) => s + (r.rp != null ? Number(r.rp) : 0), 0) * 100,
  ) / 100;

export async function buildDailyReport(runDate = new Date().toISOString().slice(0, 10)): Promise<ReportOutput> {
  const dayStart = new Date(`${runDate}T00:00:00Z`);
  const yStart = new Date(dayStart);
  yStart.setUTCDate(dayStart.getUTCDate() - 1); // yesterday 00:00 UTC
  const weekStart = new Date(dayStart);
  weekStart.setUTCDate(dayStart.getUTCDate() - ((dayStart.getUTCDay() + 6) % 7)); // Monday of this week

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

  // Per-profile: live positions, P&L, cost, scan counts, period-realized, skips.
  const perProfile: Record<string, {
    label: string; positions: Awaited<ReturnType<ReturnType<typeof getBroker>["listPositions"]>>;
    tradePL: number; cost: number; net: number; scanned: number; valid: number;
    rzToday: number; rzYest: number; rzWeek: number; winsToday: number; lossesToday: number;
    winsWeek: number; lossesWeek: number; skipsToday: number; topSkip: string; autoOn: boolean;
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

    // Closed trades for this account (realized by period).
    const closed = await db
      .select({ rp: orders.realizedPl, exitAt: orders.exitAt })
      .from(orders)
      .innerJoin(proposals, eq(orders.proposalId, proposals.id))
      .where(and(eq(proposals.profileId, pid), isNotNull(orders.exitAt)));
    const todayClosed = closed.filter((r) => r.exitAt && r.exitAt >= dayStart);
    const weekClosed = closed.filter((r) => r.exitAt && r.exitAt >= weekStart);

    // Top skip reason today (why it passed on setups).
    const skips = acts.filter((a) => a.profileId === pid && a.kind === "skip");
    const reasonCounts = new Map<string, number>();
    for (const s of skips) {
      const key = friendlyReason(s.detail ?? "") || "other";
      reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
    }
    const top = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0];

    perProfile[pid] = {
      label: getProfile(pid).label,
      positions,
      tradePL: pl.totalPL,
      cost: cost.total,
      net: Math.round((pl.totalPL - cost.total) * 100) / 100,
      scanned: Number(c?.n ?? 0),
      valid: Number(c?.v ?? 0),
      rzToday: sumRealized(closed, dayStart),
      rzYest: sumRealized(closed, yStart, dayStart),
      rzWeek: sumRealized(closed, weekStart),
      winsToday: todayClosed.filter((r) => r.rp != null && Number(r.rp) > 0).length,
      lossesToday: todayClosed.filter((r) => r.rp != null && Number(r.rp) < 0).length,
      winsWeek: weekClosed.filter((r) => r.rp != null && Number(r.rp) > 0).length,
      lossesWeek: weekClosed.filter((r) => r.rp != null && Number(r.rp) < 0).length,
      skipsToday: skips.length,
      topSkip: top ? `${top[0]} (${top[1]}x)` : "",
      autoOn: await getProfileSettings(pid).then((s) => s.autoExecute).catch(() => false),
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

  // ---- Plain-English recap (Discord message body, above the file) ----
  const dot = (n: number) => (n > 0 ? "🟢" : n < 0 ? "🔴" : "⚪");
  const N: string[] = [`**📊 Vega recap — ${runDate}**`, ""];
  for (const pid of UI_PROFILE_IDS) {
    const p = perProfile[pid];
    const placed = executed.filter((t) => t.profileId === pid).length;
    const wl = p.winsToday + p.lossesToday > 0 ? ` (${p.winsToday}W/${p.lossesToday}L)` : "";
    let line = `${dot(p.rzToday)} **${p.label}** — Today: placed ${placed} trade${placed === 1 ? "" : "s"}, realized ${signMoney(p.rzToday)}${wl}. `;
    line += `Yesterday ${signMoney(p.rzYest)}, this week ${signMoney(p.rzWeek)}. Account overall ${signMoney(p.net)}`;
    line += p.positions.length ? `, ${p.positions.length} still open.` : ".";
    if (p.skipsToday > 0) line += ` It passed on ${p.skipsToday} setup${p.skipsToday === 1 ? "" : "s"} today${p.topSkip ? ` — mostly "${p.topSkip}"` : ""}.`;
    N.push(line);
  }
  const totalToday = Math.round(UI_PROFILE_IDS.reduce((s, pid) => s + perProfile[pid].rzToday, 0) * 100) / 100;
  const totalWeek = Math.round(UI_PROFILE_IDS.reduce((s, pid) => s + perProfile[pid].rzWeek, 0) * 100) / 100;
  N.push("", `**Overall:** ${signMoney(totalToday)} today, ${signMoney(totalWeek)} this week across accounts.`);

  // SBv1 vs SBv2 head-to-head (the whole point of running both) — this week's REAL
  // realized activity per account, plus SPY buy-and-hold as a plain market benchmark.
  // (SBv2 stays flat here until its auto is enabled; the mechanical shadow tracker
  // measures every SBv2 setup vs SPY in the meantime.)
  let spyWeekPct: number | null = null;
  try {
    const spy = await getStockBars("SPY", 10);
    const base = spy.find((b) => b.t.slice(0, 10) >= weekStart.toISOString().slice(0, 10)) ?? spy[0];
    const cur = spy[spy.length - 1];
    if (base && cur && base.o > 0) spyWeekPct = Math.round(((cur.c - base.o) / base.o) * 1000) / 10;
  } catch {
    /* benchmark is best-effort */
  }
  const hh = (pid: string) => {
    const p = perProfile[pid];
    if (!p) return "";
    const wl = p.winsWeek + p.lossesWeek > 0 ? ` (${p.winsWeek}W/${p.lossesWeek}L)` : "";
    return `${p.label} ${signMoney(p.rzWeek)}${wl}`;
  };
  if (perProfile.sniper_swing && perProfile.sbv2) {
    N.push(
      "",
      `**SBv1 vs SBv2 (this week, realized):** ${hh("sniper_swing")} · ${hh("sbv2")}${
        spyWeekPct != null ? ` · SPY buy-and-hold ${spyWeekPct >= 0 ? "+" : ""}${spyWeekPct}%` : ""
      }.`,
    );
  }
  // Main issue: flag any AUTO-ON account that traded nothing (and why). Auto-off
  // profiles (e.g. SBv2 while it's being shadow-measured) are expected to be flat —
  // not a problem to surface.
  const idle = UI_PROFILE_IDS.filter((pid) => perProfile[pid].autoOn && executed.filter((t) => t.profileId === pid).length === 0);
  if (idle.length) {
    N.push(
      `**Main issue:** ${idle
        .map((pid) => {
          const p = perProfile[pid];
          return `${p.label} placed no trades today${p.skipsToday ? ` — every setup was passed on (mostly "${p.topSkip}")` : " (no setups reached its zones)"}`;
        })
        .join("; ")}.`,
    );
  }
  // Note auto-off tracks so the flat line reads as intentional, not broken.
  const shadowed = UI_PROFILE_IDS.filter((pid) => !perProfile[pid].autoOn);
  if (shadowed.length) N.push(`_${shadowed.map((pid) => perProfile[pid].label).join(", ")}: auto off — shadow-measured only._`);
  N.push("", "_Full trade-by-trade audit attached below._");
  const narrative = N.join("\n").slice(0, 1900);

  return { date: runDate, embed, narrative, markdown: L.join("\n"), filename: `vega-report-${runDate}.md`, hasActivity };
}
