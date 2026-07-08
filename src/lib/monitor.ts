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
import { getLatestPrices, getStockBars, getOptionQuotes, midPrice } from "./alpaca";
import { getBroker } from "./broker";
import { getSettings } from "./settings";
import { executeProposal } from "./execute";
import { classifyAndScore, PLAYBOOK_MIN_SCORE } from "./playbook";
import { parseOcc } from "./format";
import { sendPush } from "./push";

// Farrukh's simplified test exit: sell the whole (1-contract) position at +100%,
// or stop out at -30%. Env-tunable.
const TAKE_PROFIT = Number(process.env.MONITOR_TAKE_PROFIT_PCT ?? 1.0); // +100%
const STOP_LOSS = Number(process.env.MONITOR_STOP_PCT ?? -0.3); // -30%

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

/** Farrukh's simple exit: sell at +100%, stop at -30%. Runs each tick in-hours. */
async function manageExits(): Promise<Fire[]> {
  const broker = getBroker();
  const positions = await broker.listPositions();
  if (positions.length === 0) return [];
  const quotes = await getOptionQuotes(positions.map((p) => p.symbol));
  const out: Fire[] = [];

  for (const p of positions) {
    const entry = Number(p.avg_entry_price);
    const q = quotes[p.symbol];
    const bid = q?.bp && q.bp > 0 ? q.bp : midPrice(q);
    if (!entry || entry <= 0 || bid == null) continue;
    const ret = (bid - entry) / entry;
    if (ret < TAKE_PROFIT && ret > STOP_LOSS) continue;

    const occ = parseOcc(p.symbol);
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
          .set({ exitPrice: String(bid), exitAt: new Date(), realizedPl: String(realizedPl), exitReason: ret >= TAKE_PROFIT ? "target" : "stop" })
          .where(eq(orders.id, ord.id));
        await db.update(proposals).set({ status: "closed" }).where(eq(proposals.id, ord.pid));
      }
      const sym = occ?.underlying ?? p.symbol;
      out.push({
        symbol: sym,
        direction: occ?.type ?? "call",
        candidateId: 0,
        price: bid,
        placed: true,
        detail: ret >= TAKE_PROFIT ? `SOLD +${Math.round(ret * 100)}% (target)` : `STOPPED ${Math.round(ret * 100)}%`,
      });
      await sendPush(
        ret >= TAKE_PROFIT ? `Sold ${sym} for +${Math.round(ret * 100)}%` : `Stopped out of ${sym} (${Math.round(ret * 100)}%)`,
        ret >= TAKE_PROFIT ? "Hit the +100% profit target." : "Hit the -30% stop.",
        "/positions",
      ).catch(() => {});
    } catch {
      /* retry next tick */
    }
  }
  return out;
}

export async function monitorTick(): Promise<Fire[]> {
  const settings = await getSettings();

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

  for (const c of cands) {
    const z = c.zone as { bottom: number; top: number };
    const cur = prices[c.symbol];
    if (cur == null) continue;

    const key = String(c.id);
    const prev = prevPrices[key];
    nextPrices[key] = cur;
    if (firedSet.has(c.id)) continue;
    if (prev === undefined) continue; // first sighting: establish baseline, don't fire

    const direction = c.direction as "call" | "put";
    if (!tapCrossing(direction, prev, cur, z.bottom, z.top)) continue;

    // Score the setup; only fire if it clears the quality threshold.
    let pb: ReturnType<typeof classifyAndScore> | null = null;
    try {
      const bars = await getStockBars(c.symbol, 400);
      pb = classifyAndScore(bars, z, direction, cur);
    } catch {
      pb = null;
    }
    if (!pb || !pb.alert) {
      fires.push({
        symbol: c.symbol,
        direction,
        candidateId: c.id,
        price: cur,
        placed: false,
        detail: pb ? `score ${pb.score}/100 < ${PLAYBOOK_MIN_SCORE} (${pb.playbook}); skipped` : "could not score; skipped",
      });
      continue;
    }

    const zoneWord = direction === "call" ? "support" : "resistance";
    const tapBoundary = direction === "call" ? "top" : "bottom"; // call taps top (from above), put taps bottom (from below)
    const tapPrice = direction === "call" ? z.top : z.bottom;
    const alert = `${direction.toUpperCase()}S: ${c.symbol} — ${pb.playbook}. ${tapBoundary} zone tapped ${tapPrice} (${zoneWord} zone ${z.bottom}-${z.top}) at ${cur}. Safe target ${pb.safeTarget ?? "?"}, extended ${pb.extendedTarget ?? "?"}. Score ${pb.score}/100.`;
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
          // The setup's code-computed quality score (0-100) as a 0-1 value — NOT a
          // probability. Shown on Today so it isn't a misleading flat "100% sure".
          confidence: String(pb.score / 100),
          pricedInAssessment: "unclear",
          rationale: `${alert} ${pb.reason}`,
          plainExplanation: `${c.symbol} just tapped its zone live (${pb.playbook}), betting on a ${direction === "call" ? "bounce up off support" : "rejection down off resistance"} over the next 1-2 weeks.`,
          sources: [],
          status: "pending" as const,
          variant: "news_plus_zones",
          zoneSetup: c.setup,
          zoneRead: alert,
          candidateId: c.id,
        })
        .returning({ id: proposals.id });

      if (settings.autoExecute) {
        try {
          const r = await executeProposal(prop.id, "auto");
          fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: true, detail: `order #${r.orderId} ${r.orderStatus}` });
          await sendPush(
            `Bought ${c.symbol} ${direction === "call" ? "call" : "put"}`,
            `${pb.playbook} — tapped ${tapBoundary} zone at ${cur}. Score ${pb.score}/100.`,
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

  // Intraday exits (ratcheting stop + scaled trims). Close-through exits run in the
  // overnight scan job.
  if (settings.autoManage) {
    try {
      fires.push(...(await manageExits()));
    } catch {
      // best-effort
    }
  }

  await db.update(monitorState).set({ prices: nextPrices, updatedAt: new Date() }).where(eq(monitorState.id, row.id));
  return fires;
}
