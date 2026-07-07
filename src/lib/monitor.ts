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
import { candidates, monitorState, proposals, researchRuns } from "../db/schema";
import { getLatestPrices, getStockBars } from "./alpaca";
import { getSettings } from "./settings";
import { executeProposal } from "./execute";
import { classifyAndScore, PLAYBOOK_MIN_SCORE } from "./playbook";

export interface Fire {
  symbol: string;
  direction: "call" | "put";
  candidateId: number;
  price: number;
  placed: boolean;
  detail: string;
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
    const alert = `${direction.toUpperCase()}S: ${c.symbol} — ${pb.playbook}. Tapped ${zoneWord} zone [${z.bottom}-${z.top}] at ${cur}. Safe target ${pb.safeTarget ?? "?"}, extended ${pb.extendedTarget ?? "?"}, ~5-10d. Score ${pb.score}/100.`;
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
          expiryHint: "2-4 weeks",
          confidence: "1",
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
          fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: e instanceof Error ? e.message.slice(0, 70) : "execute error" });
        }
      } else {
        fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: "proposal created (auto-buy off)" });
      }
    } catch {
      fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: "proposal insert failed" });
    }
  }

  await db.update(monitorState).set({ prices: nextPrices, updatedAt: new Date() }).where(eq(monitorState.id, row.id));
  return fires;
}
