/**
 * Live intraday zone monitor (I6). PAPER-ONLY.
 *
 * Polls live prices for the latest scan's candidates and fires the moment price
 * actually TAPS a zone boundary in the valid direction (SniperBot rules): it must
 * CROSS the near edge, not merely sit inside the zone. On a tap it creates a
 * mechanical proposal (no Brain) and auto-buys via executeProposal (paper assert,
 * near-ATM+liquid picker, live-price check, caps). Dedups per candidate.
 *
 * Direction (from the daily-close bias stored on the candidate):
 *   - PUT setup  (price below the zone / resistance): fire when price rises to tap
 *     the BOTTOM boundary from below (prev < bottom, now >= bottom).
 *   - CALL setup (price above the zone / support):    fire when price pulls back to
 *     tap the TOP boundary from above (prev > top, now <= top).
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { candidates, proposals, researchRuns } from "../db/schema";
import { getLatestPrices } from "./alpaca";
import { getSettings } from "./settings";
import { executeProposal } from "./execute";

export interface Fire {
  symbol: string;
  direction: "call" | "put";
  candidateId: number;
  price: number;
  placed: boolean;
  detail: string;
}

/** Session state carried across ticks: what already fired + last seen price per candidate. */
export interface MonitorState {
  fired: Set<number>;
  lastPrice: Map<number, number>;
}

export const newMonitorState = (): MonitorState => ({ fired: new Set(), lastPrice: new Map() });

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

async function alreadyFired(candidateId: number): Promise<boolean> {
  const [p] = await db.select({ id: proposals.id }).from(proposals).where(eq(proposals.candidateId, candidateId)).limit(1);
  return !!p;
}

/** A boundary-tap crossing for the setup's direction, else null (no fire). */
function tapCrossing(direction: "call" | "put", prev: number, cur: number, bottom: number, top: number): boolean {
  if (direction === "put") return prev < bottom && cur >= bottom; // rose into resistance from below
  return prev > top && cur <= top; // call: pulled into support from above
}

export async function monitorTick(state: MonitorState): Promise<Fire[]> {
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

  const prices = await getLatestPrices([...new Set(cands.map((c) => c.symbol))]);
  const fires: Fire[] = [];

  for (const c of cands) {
    const z = c.zone as { bottom: number; top: number };
    const cur = prices[c.symbol];
    if (cur == null) continue;

    const prev = state.lastPrice.get(c.id);
    state.lastPrice.set(c.id, cur);
    if (state.fired.has(c.id)) continue;
    if (prev === undefined) continue; // first sighting: establish a baseline, don't fire

    const direction = c.direction as "call" | "put";
    if (!tapCrossing(direction, prev, cur, z.bottom, z.top)) continue;

    // Live boundary tap.
    state.fired.add(c.id);
    if (await alreadyFired(c.id)) continue;

    const alert =
      direction === "call"
        ? `CALLS: ${c.symbol} tapped support zone [${z.bottom}-${z.top}] at ${cur}.`
        : `PUTS: ${c.symbol} tapped resistance zone [${z.bottom}-${z.top}] at ${cur}.`;
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
          rationale: alert,
          plainExplanation: `${c.symbol} just tapped its zone live, betting on a ${direction === "call" ? "bounce up off support" : "rejection down off resistance"}.`,
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

  return fires;
}
