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
import { candidates, monitorState, positionState, proposals, researchRuns } from "../db/schema";
import { getLatestPrices, getStockBars, getOptionQuotes, midPrice } from "./alpaca";
import { getBroker } from "./broker";
import { getSettings } from "./settings";
import { executeProposal } from "./execute";
import { classifyAndScore, PLAYBOOK_MIN_SCORE } from "./playbook";
import { parseOcc } from "./format";

// Farrukh's exit ladder + ratcheting stop.
// - Trim ~20% of the original size at each of +25/50/75/100% (when qty allows).
// - Sell everything remaining at +150% (final target).
// - Stop starts at -40%; once peak >= +75% the stop ratchets to breakeven; once
//   peak >= +100% it ratchets to +25% locked profit.
const TRIM_LEVELS = [0.25, 0.5, 0.75, 1.0];
const FINAL_TP = 1.5; // +150% sell-all
const STOP_LEVELS = [-0.4, 0.0, 0.25]; // stop return by stage: -40% / breakeven / +25%

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

/** Farrukh's exit engine: ratcheting stop + scaled trims + +150% final target.
 *  Runs each tick during market hours over every open position. */
async function manageExits(): Promise<Fire[]> {
  const broker = getBroker();
  const positions = await broker.listPositions();
  if (positions.length === 0) return [];
  const quotes = await getOptionQuotes(positions.map((p) => p.symbol));
  const out: Fire[] = [];

  for (const p of positions) {
    const entry = Number(p.avg_entry_price);
    const qtyNow = Math.abs(Number(p.qty));
    const q = quotes[p.symbol];
    const bid = q?.bp && q.bp > 0 ? q.bp : midPrice(q);
    if (!entry || entry <= 0 || bid == null || qtyNow < 1) continue;
    const ret = (bid - entry) / entry;
    const occ = parseOcc(p.symbol);
    const dir = occ?.type ?? "call";
    const sym = occ?.underlying ?? p.symbol;

    // Per-position exit state (records the original qty for tranche sizing).
    let [st] = await db.select().from(positionState).where(eq(positionState.contractSymbol, p.symbol)).limit(1);
    if (!st) {
      [st] = await db
        .insert(positionState)
        .values({ contractSymbol: p.symbol, entryPremium: String(entry), entryQty: qtyNow, peakPct: String(ret), stopStage: 0, trims: [] })
        .returning();
    }

    // Ratchet high-water mark + stop stage (monotonic; never loosens).
    const peak = Math.max(Number(st.peakPct), ret);
    const stage = peak >= 1.0 ? 2 : peak >= 0.75 ? 1 : 0;
    const stopLevel = STOP_LEVELS[stage];
    const trims: number[] = (st.trims as number[]) ?? [];

    // 1) Stop hit (initial -40%, or ratcheted to breakeven / +25%) → sell all.
    if (ret <= stopLevel) {
      try {
        await broker.closePosition(p.symbol);
        await db.delete(positionState).where(eq(positionState.id, st.id));
        const label = stage === 0 ? `STOP -40% (${Math.round(ret * 100)}%)` : stage === 1 ? `STOP breakeven (peaked +${Math.round(peak * 100)}%)` : `STOP +25% locked (peaked +${Math.round(peak * 100)}%)`;
        out.push({ symbol: sym, direction: dir, candidateId: 0, price: bid, placed: true, detail: label });
      } catch {
        /* retry next tick */
      }
      continue;
    }

    // 2) Final target +150% → sell all remaining.
    if (ret >= FINAL_TP) {
      try {
        await broker.closePosition(p.symbol);
        await db.delete(positionState).where(eq(positionState.id, st.id));
        out.push({ symbol: sym, direction: dir, candidateId: 0, price: bid, placed: true, detail: `SOLD ALL +${Math.round(ret * 100)}% (final target)` });
      } catch {
        /* retry next tick */
      }
      continue;
    }

    // 3) Scale-out: trim ~20% of the ORIGINAL size at each new level crossed.
    const trimSize = Math.floor(Number(st.entryQty) * 0.2);
    let newTrims = trims;
    if (trimSize >= 1) {
      for (const level of TRIM_LEVELS) {
        if (ret >= level && !trims.includes(level)) {
          const sellQty = Math.min(trimSize, qtyNow);
          if (sellQty >= 1) {
            try {
              await broker.closePosition(p.symbol, sellQty);
              newTrims = [...newTrims, level];
              out.push({ symbol: sym, direction: dir, candidateId: 0, price: bid, placed: true, detail: `TRIMMED ${sellQty} at +${Math.round(level * 100)}%` });
            } catch {
              /* retry next tick */
            }
          }
          break; // one trim per tick keeps qty accounting simple
        }
      }
    }

    await db.update(positionState).set({ peakPct: String(peak), stopStage: stage, trims: newTrims }).where(eq(positionState.id, st.id));
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
          expiryHint: "weekly",
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
