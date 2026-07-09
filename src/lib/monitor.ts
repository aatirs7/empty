/**
 * Live intraday zone monitor (I6). PAPER-ONLY.
 *
 * One stateless tick: polls live prices for the latest scan's candidates and fires
 * the moment price CROSSES a zone boundary in the valid direction (SniperBot rules)
 * — a real intraday trigger, not a stale daily-scan guess. On a tap it classifies
 * the playbook + scores it (SNIPERBOT-PLAYBOOK.md) and only fires when the score
 * clears the threshold, then creates a mechanical proposal and auto-buys via
 * executeProposal (paper assert, cheap near-ATM+liquid picker, live-price check).
 *
 * State (last-seen price per candidate, for crossing detection) lives in the
 * `monitor_state` DB row, so this works identically from a persistent worker loop
 * OR a stateless serverless cron tick. Dedup is durable (proposals.candidateId).
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { candidates, monitorState, orders, proposals, researchRuns } from "../db/schema";
import { getLatestPrices, getStockBars, getOptionQuotes, midPrice, getClock } from "./alpaca";
import { getBroker } from "./broker";
import { executeProposal } from "./execute";
import { classifyAndScore } from "./playbook";
import { parseOcc } from "./format";
import { sendPush } from "./push";
import { getProfile } from "./profiles";
import { getProfileSettings } from "./profile-settings";
import { confirmEntry } from "./confirm";
import { evaluateSniper, indexTrend, type MarketContext } from "./sniper";
import { predict } from "./predict";
import { checkCatalyst } from "./catalyst";
import type { Bar } from "./alpaca";

export interface Fire {
  symbol: string;
  direction: "call" | "put";
  candidateId: number;
  price: number;
  placed: boolean;
  detail: string;
}

/** Heartbeat: stamp monitor_state.updatedAt every cron invocation (even when the
 *  market is closed) so the app can tell "live" from "down". */
export async function heartbeat(): Promise<void> {
  const [row] = await db.select({ id: monitorState.id }).from(monitorState).limit(1);
  if (row) await db.update(monitorState).set({ updatedAt: new Date() }).where(eq(monitorState.id, row.id));
  else await db.insert(monitorState).values({});
}

async function ensureMonitorRun(): Promise<number> {
  const runDate = new Date().toISOString().slice(0, 10);
  const [existing] = await db
    .select()
    .from(researchRuns)
    .where(and(eq(researchRuns.runDate, runDate), eq(researchRuns.model, "monitor")))
    .limit(1);
  if (existing) return existing.id;
  const [r] = await db
    .insert(researchRuns)
    .values({ runDate, status: "complete", model: "monitor", marketContext: "Live intraday zone monitor." })
    .returning({ id: researchRuns.id });
  return r.id;
}

/** A boundary-tap crossing for the setup's direction, else false. */
function tapCrossing(direction: "call" | "put", prev: number, cur: number, bottom: number, top: number): boolean {
  if (direction === "put") return prev < bottom && cur >= bottom; // rose into resistance from below
  return prev > top && cur <= top; // call: pulled into support from above
}

/** Per-profile exit: TP/SL from the profile's exit config, plus a forced same-day
 *  flatten for 0DTE near the close. Runs each tick against the profile's account. */
async function manageExits(profileId: string, nearClose: boolean): Promise<Fire[]> {
  const profile = getProfile(profileId);
  const broker = getBroker(profileId);
  const positions = await broker.listPositions();
  if (positions.length === 0) return [];
  const quotes = await getOptionQuotes(positions.map((p) => p.symbol));
  const out: Fire[] = [];
  const tp = profile.exit.takeProfit;
  const sl = profile.exit.stopLoss;
  const today = new Date().toISOString().slice(0, 10);

  for (const p of positions) {
    const entry = Number(p.avg_entry_price);
    const q = quotes[p.symbol];
    const bid = q?.bp && q.bp > 0 ? q.bp : midPrice(q);
    if (!entry || entry <= 0 || bid == null) continue;
    const ret = (bid - entry) / entry;
    const occ = parseOcc(p.symbol);
    // 0DTE: force a flatten near the close so it never expires worthless.
    const sameDayForce = profile.exit.sameDayExit && occ?.expiry === today && nearClose;
    if (ret < tp && ret > sl && !sameDayForce) continue;
    try {
      await broker.closePosition(p.symbol);
      // Record the exit (price, P&L, reason) and mark the proposal closed so the
      // Closed tab + Today reconcile with reality.
      const [ord] = await db
        .select({ id: orders.id, pid: orders.proposalId, qty: orders.qty })
        .from(orders)
        .where(eq(orders.contractSymbol, p.symbol))
        .orderBy(desc(orders.id))
        .limit(1);
      if (ord) {
        const qty = ord.qty ?? (Math.abs(Number(p.qty)) || 1);
        const realizedPl = Math.round((bid - entry) * 100 * qty * 100) / 100;
        await db
          .update(orders)
          .set({ exitPrice: String(bid), exitAt: new Date(), realizedPl: String(realizedPl), exitReason: ret >= tp ? "target" : ret <= sl ? "stop" : "same_day" })
          .where(eq(orders.id, ord.id));
        await db.update(proposals).set({ status: "closed" }).where(eq(proposals.id, ord.pid));
      }
      const sym = occ?.underlying ?? p.symbol;
      const label = ret >= tp ? `SOLD +${Math.round(ret * 100)}% (target)` : ret <= sl ? `STOPPED ${Math.round(ret * 100)}%` : `CLOSED ${Math.round(ret * 100)}% (0DTE)`;
      out.push({ symbol: sym, direction: occ?.type ?? "call", candidateId: 0, price: bid, placed: true, detail: label });
      await sendPush(
        ret >= tp ? `Sold ${sym} for +${Math.round(ret * 100)}%` : `Closed ${sym} (${ret >= 0 ? "+" : ""}${Math.round(ret * 100)}%)`,
        ret >= tp ? "Hit the profit target." : ret <= sl ? "Hit the stop." : "0DTE end-of-day flatten.",
        "/positions",
      ).catch(() => {});
    } catch {
      /* retry next tick */
    }
  }
  return out;
}

export async function monitorTick(): Promise<Fire[]> {
  const [latest] = await db
    .select({ d: candidates.runDate })
    .from(candidates)
    .orderBy(desc(candidates.runDate))
    .limit(1);
  if (!latest) return [];

  const cands = (
    await db.select().from(candidates).where(and(eq(candidates.runDate, latest.d), eq(candidates.clearRunway, true)))
  ).filter((c) => (c.direction === "call" || c.direction === "put") && c.zone);
  if (cands.length === 0) return [];

  // Durable crossing state.
  let [row] = await db.select().from(monitorState).limit(1);
  if (!row) [row] = await db.insert(monitorState).values({}).returning();
  const prevPrices = { ...(row.prices as Record<string, number>) };

  // Durable dedup: which candidates already fired a proposal.
  const firedRows = await db
    .select({ cid: proposals.candidateId })
    .from(proposals)
    .where(inArray(proposals.candidateId, cands.map((c) => c.id)));
  const firedSet = new Set(firedRows.map((r) => r.cid));

  const prices = await getLatestPrices([...new Set(cands.map((c) => c.symbol))]);
  const nextPrices = { ...prevPrices };
  const fires: Fire[] = [];

  // Market context for the SniperBot confidence engine (fetched once per tick).
  const hasConfirm = cands.some((c) => getProfile(c.profileId).confirmation.enabled);
  let marketCtx: MarketContext = { spy: 0, qqq: 0 };
  if (hasConfirm) {
    try {
      const [spyB, qqqB] = await Promise.all([getStockBars("SPY", 90), getStockBars("QQQ", 90)]);
      marketCtx = { spy: indexTrend(spyB), qqq: indexTrend(qqqB) };
    } catch {
      /* neutral */
    }
  }

  for (const c of cands) {
    const z = c.zone as { bottom: number; top: number };
    const cur = prices[c.symbol];
    if (cur == null) continue;

    const key = String(c.id);
    const prev = prevPrices[key];
    nextPrices[key] = cur;
    if (firedSet.has(c.id)) continue;

    const direction = c.direction as "call" | "put";
    const profile = getProfile(c.profileId);

    // Decide whether this candidate triggers NOW.
    let confirmReason = "";
    let execScore = 0;
    if (profile.confirmation.enabled) {
      // Confirmation profiles (SniperBot, QQQ 0DTE): fire only when price is AT the
      // zone AND an intraday confirmation candle prints (rejection/engulf/strong
      // close + relative volume) — never on a bare tap.
      const atZone = cur >= z.bottom * 0.99 && cur <= z.top * 1.01;
      if (!atZone) continue;
      const conf = await confirmEntry(c.symbol, direction, z, profile.confirmation.minRelVolume);
      if (!conf.confirmed) continue;
      confirmReason = ` Confirmed: ${conf.reason}.`;
      execScore = conf.executionScore;
    } else {
      // Tap-only profiles (zones_legacy): a boundary crossing between two ticks.
      if (prev === undefined) continue; // first sighting: establish baseline
      if (!tapCrossing(direction, prev, cur, z.bottom, z.top)) continue;
    }

    // Score the setup; only fire if it clears the profile's quality threshold.
    let pb: ReturnType<typeof classifyAndScore> | null = null;
    let bars: Bar[] = [];
    try {
      bars = await getStockBars(c.symbol, 400);
      pb = classifyAndScore(bars, z, direction, cur);
    } catch {
      pb = null;
    }
    if (!pb || pb.score < profile.minScore) {
      fires.push({
        symbol: c.symbol,
        direction,
        candidateId: c.id,
        price: cur,
        placed: false,
        detail: pb ? `score ${pb.score}/100 < ${profile.minScore} (${pb.playbook}); skipped` : "could not score; skipped",
      });
      continue;
    }

    // SniperBot confidence engine: 3 code scores + adversarial review + catalyst
    // check. Only setups that survive EVERY gate are promoted.
    let sniperConfidence = pb.score / 100;
    let sniperSummary = "";
    if (profile.confirmation.enabled) {
      // Reaction-DB prediction (probability / expected move / targets from history).
      const marketAlign = ((marketCtx.spy + marketCtx.qqq) / 2) * (direction === "call" ? 1 : -1);
      const pred = await predict(c.symbol, cur, c.timeframe, direction, c.approach ?? "", marketAlign);
      const ev = evaluateSniper(pb, bars, direction, execScore, c.clearRunway, marketCtx, pred);
      if (!ev.passed) {
        fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: `rejected: ${ev.rejections[0] ?? "adversarial"}` });
        continue;
      }
      const cat = await checkCatalyst(c.symbol, 5);
      if (cat.catalyst) {
        fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: `skipped — catalyst: ${cat.event}` });
        continue;
      }
      sniperConfidence = ev.overall / 100;
      sniperSummary = ` ${pred.reason} ${ev.summary}${cat.checked ? "" : " (catalyst unchecked)"}`;
    }

    const zoneWord = direction === "call" ? "support" : "resistance";
    const tapBoundary = direction === "call" ? "top" : "bottom"; // call taps top (from above), put taps bottom (from below)
    const tapPrice = direction === "call" ? z.top : z.bottom;
    const alert = `${direction.toUpperCase()}S: ${c.symbol} — ${pb.playbook}. ${tapBoundary} zone tapped ${tapPrice} (${zoneWord} zone ${z.bottom}-${z.top}) at ${cur}. Safe target ${pb.safeTarget ?? "?"}, extended ${pb.extendedTarget ?? "?"}. Score ${pb.displayScore}/100.${confirmReason}${sniperSummary}`;
    try {
      const runId = await ensureMonitorRun();
      const [prop] = await db
        .insert(proposals)
        .values({
          runId,
          symbol: c.symbol,
          direction,
          strategy: direction === "call" ? "long_call" : "long_put",
          strikeHint: "ATM",
          expiryHint: "friday",
          // SniperBot's blended confidence (0-1) for confirmation profiles, else the
          // playbook quality score. Code-computed, NOT a probability of profit.
          confidence: String(sniperConfidence),
          pricedInAssessment: "unclear",
          rationale: `${alert} ${pb.reason}`,
          plainExplanation: `${c.symbol} just tapped its zone live (${pb.playbook}), betting on a ${direction === "call" ? "bounce up off support" : "rejection down off resistance"} over the next 1-2 weeks.`,
          sources: [],
          status: "pending" as const,
          variant: "news_plus_zones",
          zoneSetup: c.setup,
          zoneRead: alert,
          candidateId: c.id,
          profileId: c.profileId,
        })
        .returning({ id: proposals.id });

      const autoOn = (await getProfileSettings(c.profileId)).autoExecute;
      if (autoOn) {
        try {
          const r = await executeProposal(prop.id, "auto");
          fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: true, detail: `order #${r.orderId} ${r.orderStatus}` });
          await sendPush(
            `Bought ${c.symbol} ${direction === "call" ? "call" : "put"}`,
            `${pb.playbook} — tapped ${tapBoundary} zone at ${cur}. Score ${pb.displayScore}/100.`,
            "/positions",
          ).catch(() => {});
        } catch (e) {
          // Full-auto: a skipped buy (e.g. no cheap contract) must NOT sit pending
          // asking the owner to approve — the bot already decided. Mark it auto-skipped.
          const why = e instanceof Error ? e.message.slice(0, 90) : "execute error";
          await db
            .update(proposals)
            .set({ status: "expired", zoneRead: `${alert} Auto-skip: ${why}` })
            .where(eq(proposals.id, prop.id));
          fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: why });
        }
      } else {
        fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: "proposal created (auto-buy off)" });
      }
    } catch {
      fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: "proposal insert failed" });
    }
  }

  // Intraday exits — per account (default = SniperBot/zones, account 2 = QQQ 0DTE),
  // gated per-profile so an unconfigured account is skipped. 0DTE flattens near close.
  {
    let nearClose = false;
    try {
      const clock = await getClock();
      nearClose = new Date(clock.next_close).getTime() - Date.now() < 25 * 60_000;
    } catch {
      /* keep false */
    }
    for (const pid of ["sniper_swing", "qqq_0dte"]) {
      try {
        if (!(await getProfileSettings(pid)).autoManage) continue;
        fires.push(...(await manageExits(pid, nearClose)));
      } catch {
        // best-effort
      }
    }
  }

  await db.update(monitorState).set({ prices: nextPrices, updatedAt: new Date() }).where(eq(monitorState.id, row.id));
  return fires;
}
