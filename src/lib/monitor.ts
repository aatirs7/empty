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
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import { candidates, monitorState, orders, positionState, proposals, researchRuns, activityLog } from "../db/schema";
import { getLatestPrices, getStockBars, getIntradayBars, getOptionQuotes, midPrice, getClock } from "./alpaca";
import { getBroker } from "./broker";
import { executeProposal } from "./execute";
import { classifyAndScore } from "./playbook";
import { parseOcc } from "./format";
import { sendPush } from "./push";
import { getProfile, activeProfiles, type Profile } from "./profiles";
import { scanProfile } from "./scanner";
import { zoneOfPosition } from "./manage";
import { getProfileSettings } from "./profile-settings";
import { confirmEntry, evaluateConfirmation } from "./confirm";
import { evaluateSniper, indexTrend, type MarketContext } from "./sniper";
import { predict } from "./predict";
import { checkCatalyst } from "./catalyst";
import { logActivity, fireKind } from "./activity";
import { carryForwardManualLevels } from "./manual-levels";
import { intelEnabled, evaluateSbv2Intel, classifyStructure } from "./intel";
import type { Bar } from "./alpaca";

export interface Fire {
  symbol: string;
  direction: "call" | "put";
  candidateId: number;
  price: number;
  placed: boolean;
  detail: string;
  profileId?: string; // set for exits (which know their account); else derived from the candidate
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

// ---- Session memory (DB-traffic diet) --------------------------------------------
// Module-scope caches survive across invocations on a WARM container (the steady
// 1/min cron keeps one warm) and on the persistent worker; a cold start simply falls
// back to the DB once — every cache is read-through. NOTHING critical lives only in
// memory: trades, fills, exits, tap signals, and catalyst verdicts are written to
// Postgres IMMEDIATELY and individually on the event. Only replaceable state is
// cached (candidate/settings reads) or batched (skip-decision log rows).
const CAND_CACHE_MS = 120_000; // candidates re-read cadence (a manual-level save from another instance lands within this)
const SETTINGS_CACHE_MS = 60_000; // per-profile auto-toggle staleness ceiling
const MAINTENANCE_MS = 5 * 60_000; // buy-fill sync + closed-position reconcile cadence
const SKIP_FLUSH_MS = 4 * 60_000; // max age of buffered skip rows before a forced flush
const mem = {
  cands: null as null | { at: number; rows: (typeof candidates.$inferSelect)[] },
  settings: new Map<string, { at: number; autoExecute: boolean; autoManage: boolean }>(),
  carriedDay: null as string | null, // carry-forward already ensured for this day
  zoneByContract: new Map<string, { at: number; zone: Awaited<ReturnType<typeof zoneOfPosition>> }>(),
  posState: new Map<string, typeof positionState.$inferSelect>(), // write-through (this module is the only writer)
  lastMaintenance: 0,
  skipBuffer: [] as Parameters<typeof logActivity>[0],
  skipBufferAt: 0,
};

/** Per-profile auto toggles with a short TTL — the owner's toggle applies within
 *  ~1 min instead of instantly; buys/exits themselves are unaffected. */
async function cachedSettings(profileId: string): Promise<{ autoExecute: boolean; autoManage: boolean }> {
  const hit = mem.settings.get(profileId);
  if (hit && hit.at > Date.now() - SETTINGS_CACHE_MS) return hit;
  const row = await getProfileSettings(profileId);
  const entry = { at: Date.now(), autoExecute: !!row.autoExecute, autoManage: !!row.autoManage };
  mem.settings.set(profileId, entry);
  return entry;
}

/** zoneOfPosition with a session cache — a proposal's zoneSetup is immutable after
 *  entry, so a non-null result is safe to reuse. Null results are NOT cached (the
 *  order row may simply not be visible yet right after a fill). */
async function cachedZone(occSymbol: string): Promise<Awaited<ReturnType<typeof zoneOfPosition>>> {
  const hit = mem.zoneByContract.get(occSymbol);
  if (hit && hit.at > Date.now() - 10 * 60_000) return hit.zone;
  const zone = await zoneOfPosition(occSymbol);
  if (zone) mem.zoneByContract.set(occSymbol, { at: Date.now(), zone });
  return zone;
}

/** Buffer a batch of SKIP decision rows (non-critical, replaceable) and flush them
 *  piggybacked on critical writes, on age, or on size. Worst case a container death
 *  loses <=4 min of skip rows — never a trade/fill/signal, which flush immediately. */
async function logSkipsBuffered(skips: Parameters<typeof logActivity>[0], force: boolean): Promise<void> {
  if (skips.length) {
    if (mem.skipBuffer.length === 0) mem.skipBufferAt = Date.now();
    mem.skipBuffer.push(...skips);
  }
  const stale = mem.skipBuffer.length > 0 && (Date.now() - mem.skipBufferAt >= SKIP_FLUSH_MS || mem.skipBuffer.length >= 100);
  if ((force && mem.skipBuffer.length > 0) || stale) {
    const batch = mem.skipBuffer.splice(0);
    await logActivity(batch);
  }
}
/** Tick-end activity persistence: critical rows immediately + individually, skip
 *  rows through the buffer (flushed alongside criticals so ordering stays sane). */
async function flushTickActivity(entries: Parameters<typeof logActivity>[0]): Promise<void> {
  const critical = entries.filter((e) => e.kind !== "skip");
  const skips = entries.filter((e) => e.kind === "skip");
  if (critical.length) await logActivity(critical); // never buffered — crash-safe
  await logSkipsBuffered(skips, critical.length > 0);
}
// -----------------------------------------------------------------------------------

// SBv2 enters when price is within this fraction of the flipped boundary — "taps the
// level". Wide enough to catch the tap at minute granularity, tight enough to be a real
// touch. Deduped to once per candidate per day (see tappedSet).
const FLIP_TAP_BAND = 0.004; // 0.4%
// QQQ Manual level-touch band: tighter than the flip band (QQQ levels sit a few
// points apart; 0.4% of ~$720 would be ±$2.9 — too sloppy). 0.15% ≈ ±$1.
const LEVEL_TOUCH_BAND = 0.0015;

/** Minutes since midnight in ET (SB15M's 9:45am-2:45pm day-trade entry window). */
function etMinutesNow(): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/** A profile's day-trade entry window (undefined = always open). */
function inEntryWindow(profile: Profile): boolean {
  const w = profile.entryWindowEt;
  if (!w) return true;
  const now = etMinutesNow();
  return now >= w.startMin && now <= w.endMin;
}

/** Turn a raw execute error into a short, plain "why it didn't buy" for the push. */
function friendlyBlock(msg: string): string {
  const s = msg.toLowerCase();
  if (s.includes("no affordable") || s.includes("price cap") || s.includes("no contract fits") || s.includes("no_quote")) return "no cheap contract that reaches the target";
  if (s.includes("open-position cap") || s.includes("open_cap")) return "position cap reached";
  if (s.includes("daily trade cap")) return "daily trade limit reached (3/day)";
  if (s.includes("invalidated") || s.includes("crossed the zone")) return "price moved the wrong way";
  if (s.includes("market closed")) return "market closed";
  return msg.slice(0, 60);
}

/** ONE catalyst check per symbol/profile/day, cached in the activity log (durable
 *  across serverless ticks AND QQQ's ~5-min candidate re-scans). Without a cache, a
 *  setup that passes the gates but dies downstream (contract band, caps) re-burned a
 *  web-search Claude call EVERY minute (~65 QQQ calls on 2026-07-13 drained the API
 *  credits). Fail-open results are cached for the day too: a timeout abort still
 *  consumes tokens, so retrying it each tick is the same leak. */
async function cachedCatalyst(
  symbol: string,
  profileId: string,
  direction: "call" | "put",
  today: string,
  candidateId: number,
): Promise<{ catalyst: boolean; event: string; checked: boolean }> {
  const [row] = await db
    .select({ meta: activityLog.meta })
    .from(activityLog)
    .where(
      and(eq(activityLog.kind, "catalyst"), eq(activityLog.runDate, today), eq(activityLog.symbol, symbol), eq(activityLog.profileId, profileId)),
    )
    .limit(1);
  let cat = row?.meta as { catalyst: boolean; event: string; checked: boolean } | undefined;
  if (!cat) {
    cat = await checkCatalyst(symbol, 5, profileId); // plain scheduled-catalyst check
    await logActivity([
      {
        profileId,
        symbol,
        kind: "catalyst",
        direction,
        candidateId,
        detail: cat.catalyst ? `catalyst: ${cat.event}` : cat.checked ? "no catalyst" : "unchecked (call failed — fails open)",
        meta: { catalyst: cat.catalyst, event: cat.event, checked: cat.checked },
      },
    ]);
  }
  return cat;
}

/** A boundary-tap crossing for the setup's direction, else false. */
function tapCrossing(direction: "call" | "put", prev: number, cur: number, bottom: number, top: number): boolean {
  if (direction === "put") return prev < bottom && cur >= bottom; // rose into resistance from below
  return prev > top && cur <= top; // call: pulled into support from above
}

/** One ladder pass for a single position (QQQ Manual). Farrukh 2026-07-16:
 *  10 contracts in; -30% base stop; at +50% trim 3 and move the stop to -10%;
 *  past +75% stop to breakeven; at +100% sell 6; the runner exits at the
 *  ratcheted stop, within $0.25 of the NEXT-LEVEL target, on a no-bounce
 *  time-out (2x expected hold), or the 0DTE end-of-day flatten. Tranches scale
 *  proportionally when fewer than the planned contracts filled. */
export async function runLadder(
  profile: Profile,
  broker: ReturnType<typeof getBroker>,
  p: { symbol: string; qty: string; avg_entry_price: string },
  bid: number,
  liveEntry: number,
  occ: ReturnType<typeof parseOcc>,
  today: string,
  nearClose: boolean,
  profileId: string,
): Promise<Fire[]> {
  const L = profile.exit.ladder!;
  const out: Fire[] = [];

  // Lazy state, seeded from the BUY order (original qty — the live position shrinks
  // as we trim; the broker's avg entry is the fallback entry premium). The state row
  // is cached write-through in memory (this module is its only writer), so a steady
  // tick costs zero DB reads here; a cold start re-reads once. The BUY-order lookup
  // only happens when seeding state or closing — not every tick.
  let st = mem.posState.get(p.symbol) ?? null;
  if (!st) {
    [st = null] = await db.select().from(positionState).where(eq(positionState.contractSymbol, p.symbol)).limit(1);
  }
  if (!st) {
    const [ord] = await db.select().from(orders).where(eq(orders.contractSymbol, p.symbol)).orderBy(desc(orders.id)).limit(1);
    [st] = await db
      .insert(positionState)
      .values({
        contractSymbol: p.symbol,
        entryPremium: ord?.filledPrice ?? String(liveEntry),
        entryQty: ord?.qty ?? (Math.abs(Number(p.qty)) || 1),
        openedAt: ord?.submittedAt ?? new Date(),
      })
      .returning();
  }
  mem.posState.set(p.symbol, st);
  const entryPrem = st.entryPremium ? Number(st.entryPremium) : liveEntry;
  if (!entryPrem || entryPrem <= 0) return out;
  const ret = (bid - entryPrem) / entryPrem;
  const peak = Math.max(Number(st.peakPct), ret);
  const trims = st.trims ?? [];
  const heldQty = Math.abs(Number(p.qty)) || 1;

  // Tranche sizes scale to what actually filled (plan: 3 + 6 + 1 runner of 10).
  const planned = L.trim1Qty + L.trim2Qty + 1;
  const scale = st.entryQty / planned;
  const t1Qty = Math.max(1, Math.round(L.trim1Qty * scale));
  const t2Qty = Math.max(1, Math.round(L.trim2Qty * scale));

  // Ratcheting stop off the PEAK (never loosens): -30% -> -10% once +50% printed ->
  // breakeven once +75% printed.
  let stop = profile.exit.stopLoss;
  if (peak >= L.trim1Pct || trims.includes(L.trim1Pct)) stop = L.stopAfterTrim1;
  if (peak >= L.breakevenPct) stop = 0;

  // Runner target: the persisted NEXT-LEVEL price; exit when the UNDERLYING is
  // within $targetProximity of it in the trade's direction. (Session-cached — the
  // proposal's zoneSetup is immutable after entry.) targetProximity <= 0 disables
  // this exit (SB15M — its runner exits on premium targets, not underlying levels).
  const zone = occ ? await cachedZone(p.symbol) : null;
  let spot: number | null = null;
  let nearTarget = false;
  if (zone?.predictedTarget != null && occ && L.targetProximity > 0) {
    try {
      spot = (await getLatestPrices([occ.underlying]))[occ.underlying] ?? null;
    } catch {
      spot = null;
    }
    if (spot != null) {
      nearTarget =
        zone.direction === "call" ? spot >= zone.predictedTarget - L.targetProximity : spot <= zone.predictedTarget + L.targetProximity;
    }
  }
  // No-bounce time-out: nothing trimmed and 2x the expected hold has passed.
  const ageMin = (Date.now() - new Date(st.openedAt).getTime()) / 60_000;
  const timedOut = zone?.expectedHoldMin != null && trims.length === 0 && ageMin > 2 * zone.expectedHoldMin;

  // Structural early exit (SB15M spec §12): a COMPLETED 15-minute candle closing
  // through the zone against the position kills the thesis before the % stop.
  let invalidated15m = "";
  if (profile.exit.invalidateOn15mClose && zone && occ) {
    try {
      const b15 = await getIntradayBars(occ.underlying, "15Min", 90);
      const done = b15.filter((b) => Date.parse(b.t) + 15 * 60_000 <= Date.now());
      const last = done[done.length - 1];
      if (last && ((zone.direction === "call" && last.c < zone.bottom) || (zone.direction === "put" && last.c > zone.top))) {
        invalidated15m = `15m close ${last.c} through the zone — setup invalidated`;
      }
    } catch {
      /* bars unavailable — the % stop still protects */
    }
  }

  // Full-close reasons (sell ALL remaining), in priority order.
  let closeAll = "";
  if (invalidated15m) {
    closeAll = invalidated15m;
  } else if (ret <= stop) {
    closeAll =
      stop === 0
        ? `breakeven stop after +${Math.round(peak * 100)}% peak`
        : `hit ${Math.round(stop * 100)}% stop (${Math.round(ret * 100)}%)`;
  } else if (L.runnerTakeProfit != null && ret >= L.runnerTakeProfit) {
    // SB15M: the LAST contract's premium target (+75%) — the ladder always leaves
    // a runner, so this is how "sell contract 2 at +75%" executes.
    closeAll = `runner take-profit +${Math.round(ret * 100)}% (target +${Math.round(L.runnerTakeProfit * 100)}%)`;
  } else if (nearTarget && zone?.predictedTarget != null) {
    closeAll = `within $${L.targetProximity.toFixed(2)} of next level ${zone.predictedTarget} (QQQ ${spot})`;
  } else if (timedOut) {
    closeAll = `no bounce within 2x expected hold (~${Math.round(zone!.expectedHoldMin!)}min)`;
  } else if (profile.exit.sameDayExit && nearClose && (occ?.expiry === today || profile.exit.forceEodFlatten)) {
    closeAll = `end-of-day flatten (${ret >= 0 ? "+" : ""}${Math.round(ret * 100)}%)`;
  }

  if (closeAll) {
    const closeOrder = await broker.closePosition(p.symbol);
    let exitFill = bid;
    try {
      const f = await broker.waitForFill(closeOrder.id, 8000, 500);
      if (f.filled_avg_price && Number(f.filled_avg_price) > 0) exitFill = Number(f.filled_avg_price);
    } catch {
      /* keep the bid estimate */
    }
    // Whole-trade P&L across ALL partial sells (trims + this close) from broker fills;
    // falls back to runner-only math if the closed-orders read fails.
    let realizedPl = Math.round((exitFill - entryPrem) * 100 * heldQty * 100) / 100;
    try {
      const sells = (await broker.getClosedOrders(p.symbol)).filter(
        (o) => o.side === "sell" && o.status === "filled" && o.filled_avg_price,
      );
      if (sells.length) {
        const soldValue = sells.reduce((s, o) => s + Number(o.filled_avg_price) * Number(o.filled_qty || 0), 0);
        const soldQty = sells.reduce((s, o) => s + Number(o.filled_qty || 0), 0);
        realizedPl = Math.round((soldValue - entryPrem * soldQty) * 100 * 100) / 100;
      }
    } catch {
      /* fallback stands */
    }
    // The order row is fetched here (close time) rather than every tick.
    const [ord] = await db.select().from(orders).where(eq(orders.contractSymbol, p.symbol)).orderBy(desc(orders.id)).limit(1);
    if (ord) {
      await db
        .update(orders)
        .set({ exitPrice: String(exitFill), exitAt: new Date(), realizedPl: String(realizedPl), exitReason: closeAll.slice(0, 80) })
        .where(eq(orders.id, ord.id));
      await db.update(proposals).set({ status: "closed" }).where(eq(proposals.id, ord.proposalId));
    }
    await db.delete(positionState).where(eq(positionState.contractSymbol, p.symbol));
    mem.posState.delete(p.symbol);
    mem.zoneByContract.delete(p.symbol);
    const sym = occ?.underlying ?? p.symbol;
    const money = `${realizedPl >= 0 ? "+" : "-"}$${Math.abs(realizedPl).toFixed(2)}`;
    out.push({ symbol: sym, direction: occ?.type ?? "call", candidateId: 0, price: exitFill, placed: true, detail: `SOLD ${sym} ${money} — ${closeAll}`, profileId });
    await sendPush(`${profile.label}: Sold ${sym} ${money}`, closeAll, "/positions").catch(() => {});
    return out;
  }

  // Trims (partial sells) — one rung per tick; the next tick catches the next rung.
  // Always leave at least 1 contract (the runner).
  let trimQty = 0;
  let trimLevel = 0;
  if (!trims.includes(L.trim1Pct) && ret >= L.trim1Pct && heldQty > 1) {
    trimQty = Math.min(t1Qty, heldQty - 1);
    trimLevel = L.trim1Pct;
  } else if (trims.includes(L.trim1Pct) && !trims.includes(L.trim2Pct) && ret >= L.trim2Pct && heldQty > 1) {
    trimQty = Math.min(t2Qty, heldQty - 1);
    trimLevel = L.trim2Pct;
  }
  if (trimQty > 0) {
    await broker.closePosition(p.symbol, trimQty);
    const trimPatch = { trims: [...trims, trimLevel], peakPct: String(peak), stopStage: peak >= L.breakevenPct ? 2 : 1 };
    await db.update(positionState).set(trimPatch).where(eq(positionState.contractSymbol, p.symbol)); // critical — immediate
    mem.posState.set(p.symbol, { ...st, ...trimPatch });
    const sym = occ?.underlying ?? p.symbol;
    const stopWord = peak >= L.breakevenPct ? "breakeven" : `${Math.round(L.stopAfterTrim1 * 100)}%`;
    const d = `trimmed ${trimQty} of ${st.entryQty} at +${Math.round(ret * 100)}% (stop → ${stopWord})`;
    out.push({ symbol: sym, direction: occ?.type ?? "call", candidateId: 0, price: bid, placed: true, detail: `SOLD ${sym} — ${d}`, profileId });
    await sendPush(`${profile.label}: Trimmed ${sym} +${Math.round(ret * 100)}%`, d, "/positions").catch(() => {});
  } else {
    // Persist the high-water mark ONLY when it crosses a ratchet threshold — the
    // stop stage depends solely on peak-vs-thresholds, so intermediate peaks don't
    // change behavior and don't need a write. Crossings persist immediately so the
    // ratchet survives any restart EXACTLY (a mid-band peak lost to a crash can
    // never loosen the stop — stage-at-crossing is already durable).
    const stageOf = (pct: number) => (pct >= L.breakevenPct ? 2 : pct >= L.trim1Pct ? 1 : 0);
    if (stageOf(peak) > stageOf(Number(st.peakPct))) {
      const peakPatch = { peakPct: String(peak), stopStage: stageOf(peak) };
      await db.update(positionState).set(peakPatch).where(eq(positionState.contractSymbol, p.symbol));
      mem.posState.set(p.symbol, { ...st, ...peakPatch });
    } else if (peak > Number(st.peakPct)) {
      mem.posState.set(p.symbol, { ...st, peakPct: String(peak) }); // memory only — replaceable
    }
  }
  return out;
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
  const today = new Date().toISOString().slice(0, 10);

  for (const p of positions) {
    const entry = Number(p.avg_entry_price);
    const q = quotes[p.symbol];
    const bid = q?.bp && q.bp > 0 ? q.bp : midPrice(q);
    if (!entry || entry <= 0 || bid == null) continue;
    const ret = (bid - entry) / entry;
    const occ = parseOcc(p.symbol);
    const daysToExpiry = occ?.expiry ? Math.ceil((Date.parse(`${occ.expiry}T00:00:00Z`) - Date.now()) / 86_400_000) : Infinity;

    // LADDER (QQQ Manual, Farrukh 2026-07-16): trim tranches at premium milestones
    // with a stop that ratchets on the PEAK gain (never loosens), leave a runner for
    // the next-level target. State (original qty, peak, fired trims) lives in the
    // position_state table so it survives serverless ticks.
    if (profile.exit.style === "intraday" && profile.exit.ladder) {
      try {
        const fired = await runLadder(profile, broker, p, bid, entry, occ, today, nearClose, profileId);
        out.push(...fired);
      } catch {
        /* retry next tick */
      }
      continue;
    }

    let reason = ""; // non-empty => close this position; empty => HOLD

    if (profile.exit.style === "swing") {
      // SWING: hold toward the target over the multi-day horizon. Exit on swing
      // INVALIDATION (a completed daily close back through the zone against the
      // trade), the target hit, the optional swing stop, or expiry salvage.
      const tgtPrem = profile.exit.targetPremium;
      if (tgtPrem && bid >= tgtPrem) reason = `rode to $${bid.toFixed(2)} (>= $${tgtPrem.toFixed(2)} target)`;

      // Optional mid-swing premium stop (Farrukh 2026-07-16, SBv2: "wait to sell at
      // intended target or 50% stop"). Unset for SBv1 → no mid-swing stop, unchanged.
      const sStop = profile.exit.swingStopLoss;
      if (!reason && sStop != null && ret <= sStop) {
        reason = `hit swing stop (${Math.round(ret * 100)}% <= ${Math.round(sStop * 100)}%)`;
      }

      if (!reason) {
        const zone = occ ? await cachedZone(p.symbol) : null;
        if (zone && occ) {
          let bars: Bar[] = [];
          try {
            bars = await getStockBars(occ.underlying, 400);
          } catch {
            /* no bars -> fall through to expiry check */
          }
          if (bars.length) {
            const underlyingNow = bars[bars.length - 1].c;
            const completed = bars.filter((b) => b.t.slice(0, 10) < today);
            const lastClose = completed.length ? completed[completed.length - 1].c : null;
            if (lastClose != null && zone.direction === "call" && lastClose < zone.bottom) {
              reason = `swing invalidated — daily close ${lastClose} back below the zone`;
            } else if (lastClose != null && zone.direction === "put" && lastClose > zone.top) {
              reason = `swing invalidated — daily close ${lastClose} back above the zone`;
            } else {
              // Prefer the reaction-DB target persisted at entry (SBv2). Fall back to the
              // playbook safe-target when absent (SBv1 — unchanged behavior).
              let target: number | null = zone.predictedTarget;
              if (target == null) {
                try {
                  target = classifyAndScore(bars, { bottom: zone.bottom, top: zone.top }, zone.direction, underlyingNow).safeTarget;
                } catch {
                  target = null;
                }
              }
              if (target != null && ((zone.direction === "call" && underlyingNow >= target) || (zone.direction === "put" && underlyingNow <= target))) {
                reason = `hit target ${target} (underlying ${underlyingNow})`;
              }
            }
          }
        }
      }
      // Catastrophe floor — ONLY near expiry: cut a basically-dead option that's out
      // of time. Does NOT fire mid-swing (that was the RIVN bug).
      if (!reason && profile.exit.catastropheFloor != null && bid <= profile.exit.catastropheFloor && daysToExpiry <= (profile.exit.catastropheDays ?? 2)) {
        reason = `catastrophe floor — $${bid.toFixed(2)} <= $${profile.exit.catastropheFloor.toFixed(2)} with ${daysToExpiry}d to expiry`;
      }
      // Salvage: never let a swing option expire worthless if the move ran late.
      if (!reason && daysToExpiry <= 1) reason = "near expiry — salvaging remaining value";
    } else {
      // INTRADAY 0DTE: premium TP/SL + a forced same-day flatten near the close.
      const tp = profile.exit.takeProfit;
      const sl = profile.exit.stopLoss;
      if (ret >= tp) reason = `hit take-profit (+${Math.round(ret * 100)}%)`;
      else if (ret <= sl) reason = `hit stop (${Math.round(ret * 100)}%)`;
      else if (profile.exit.sameDayExit && occ?.expiry === today && nearClose)
        reason = `0DTE end-of-day flatten (${ret >= 0 ? "+" : ""}${Math.round(ret * 100)}%)`;
    }

    if (!reason) continue; // HOLD

    try {
      const closeOrder = await broker.closePosition(p.symbol);
      const [ord] = await db
        .select({ id: orders.id, pid: orders.proposalId, qty: orders.qty, buyFill: orders.filledPrice })
        .from(orders)
        .where(eq(orders.contractSymbol, p.symbol))
        .orderBy(desc(orders.id))
        .limit(1);
      // Use the ACTUAL close fill (not the bid estimate) + the actual buy fill so
      // realized P&L matches the Alpaca account exactly.
      let exitFill = bid;
      try {
        const filled = await broker.waitForFill(closeOrder.id, 8000, 500);
        if (filled.filled_avg_price && Number(filled.filled_avg_price) > 0) exitFill = Number(filled.filled_avg_price);
      } catch {
        /* keep the bid estimate */
      }
      const buyFill = ord?.buyFill ? Number(ord.buyFill) : entry;
      const qty = ord?.qty ?? (Math.abs(Number(p.qty)) || 1);
      const realizedPl = Math.round((exitFill - buyFill) * 100 * qty * 100) / 100;
      if (ord) {
        await db
          .update(orders)
          .set({ exitPrice: String(exitFill), exitAt: new Date(), realizedPl: String(realizedPl), exitReason: reason.slice(0, 80) })
          .where(eq(orders.id, ord.id));
        await db.update(proposals).set({ status: "closed" }).where(eq(proposals.id, ord.pid));
      }
      const sym = occ?.underlying ?? p.symbol;
      const pct = `${realizedPl >= 0 ? "+" : ""}$${Math.abs(realizedPl).toFixed(2)}`;
      out.push({ symbol: sym, direction: occ?.type ?? "call", candidateId: 0, price: exitFill, placed: true, detail: `SOLD ${sym} ${pct} — ${reason}`, profileId });
      await sendPush(`${profile.label}: Sold ${sym} ${pct}`, reason, "/positions").catch(() => {});
    } catch {
      /* retry next tick */
    }
  }
  return out;
}

const INTRADAY_RESCAN_MS = 5 * 60_000;

/** Keep intraday profiles' zones fresh DURING market hours (Farrukh's "24/7
 *  scanner"): re-scan QQQ (single ticker, intraday tfs) when its candidates are
 *  older than ~5 min. Only runs inside a market-open tick, so it self-starts at
 *  the open and stops at the close. */
async function refreshIntradayScans(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  for (const p of activeProfiles()) {
    // Shelved profiles are PAUSED — re-scanning them every ~5 min (bar fetches +
    // candidate delete/insert) was pure DB/API waste (qqq_0dte after the pause).
    // Their nightly /api/scan coverage for shadow measurement is unaffected.
    if (p.shelved) continue;
    // 15min/1h zones refresh every ~5 min; 4h-zone profiles (SB15M) refresh HOURLY —
    // a 4-hour zone can only change when a 4H bar completes mid-session, so a 5-min
    // cadence would be pure API waste across an 18-name universe.
    const fast = p.zoneTimeframes.some((z) => z.timeframe === "1h" || z.timeframe === "15min");
    const slow = !fast && p.zoneTimeframes.some((z) => z.timeframe === "4h");
    if (!fast && !slow) continue;
    const cadence = fast ? INTRADAY_RESCAN_MS : 60 * 60_000;
    const [newest] = await db
      .select({ at: candidates.createdAt })
      .from(candidates)
      .where(eq(candidates.profileId, p.id))
      .orderBy(desc(candidates.createdAt))
      .limit(1);
    const age = newest?.at ? Date.now() - new Date(newest.at).getTime() : Infinity;
    if (age > cadence) {
      try {
        await scanProfile(p, today);
        mem.cands = null; // fresh zones — force the next candidate read from the DB
      } catch {
        /* keep the tick alive even if a rescan fails */
      }
    }
  }
}

/** Heal the ENTRY side of DB/broker drift: a limit buy that fills AFTER execute's
 *  short fill-wait stays `new` with no fill price forever (e.g. F filled 13 min after
 *  submission on 2026-07-14). Poll those orders' broker status each tick and record
 *  the fill — or the terminal cancel/reject — so P&L, reports, and reconciliation
 *  (which only matches status='filled' rows) see the truth. */
export async function syncPendingBuyFills(profileId: string): Promise<void> {
  const broker = getBroker(profileId);
  const rows = await db
    .select({ oid: orders.id, aid: orders.alpacaOrderId })
    .from(orders)
    .innerJoin(proposals, eq(orders.proposalId, proposals.id))
    .where(
      and(
        eq(proposals.profileId, profileId),
        isNull(orders.filledPrice),
        inArray(orders.status, ["new", "submitted", "accepted", "partially_filled", "pending_new"]),
      ),
    );
  for (const r of rows) {
    if (!r.aid) continue;
    try {
      const o = await broker.waitForFill(r.aid, 1, 1); // single status read, no polling loop
      if (o.status === "filled" && o.filled_avg_price) {
        await db
          .update(orders)
          .set({ status: "filled", filledPrice: o.filled_avg_price, filledAt: o.filled_at ? new Date(o.filled_at) : new Date() })
          .where(eq(orders.id, r.oid));
      } else if (["canceled", "rejected", "expired"].includes(o.status)) {
        await db.update(orders).set({ status: o.status }).where(eq(orders.id, r.oid));
      }
    } catch {
      /* retry next tick */
    }
  }
}

/** Heal DB/broker drift: if a filled order's contract is no longer held at the
 *  broker but we never recorded an exit, mark it closed (recovering the exit fill
 *  from Alpaca). Without this, a position closed outside our close path stays
 *  "open" on Today while Positions (broker-truth) shows nothing. */
export async function reconcileClosedPositions(profileId: string): Promise<void> {
  const broker = getBroker(profileId);
  const held = new Set((await broker.listPositions()).map((p) => p.symbol));
  const rows = await db
    .select({ oid: orders.id, sym: orders.contractSymbol, qty: orders.qty, entry: orders.filledPrice, pid: orders.proposalId })
    .from(orders)
    .innerJoin(proposals, eq(orders.proposalId, proposals.id))
    .where(and(eq(proposals.profileId, profileId), isNull(orders.exitAt), eq(orders.status, "filled")));
  for (const r of rows) {
    if (!r.sym || held.has(r.sym)) continue; // still open — leave it
    let exitPrice: number | null = null;
    try {
      const closed = await broker.getClosedOrders(r.sym);
      const sell = closed.find((o) => o.side === "sell" && o.status === "filled" && o.filled_avg_price);
      if (sell?.filled_avg_price) exitPrice = Number(sell.filled_avg_price);
    } catch {
      /* best effort — still mark closed below so Today/Positions agree */
    }
    const entry = r.entry != null ? Number(r.entry) : null;
    const qty = r.qty ?? 1;
    const realizedPl = exitPrice != null && entry != null ? Math.round((exitPrice - entry) * 100 * qty * 100) / 100 : null;
    await db
      .update(orders)
      .set({
        exitPrice: exitPrice != null ? String(exitPrice) : null,
        exitAt: new Date(),
        realizedPl: realizedPl != null ? String(realizedPl) : null,
        exitReason: "reconciled (closed at broker)",
      })
      .where(eq(orders.id, r.oid));
    await db.update(proposals).set({ status: "closed" }).where(eq(proposals.id, r.pid));
  }
}

export async function monitorTick(): Promise<Fire[]> {
  // Refresh intraday zones first so QQQ trades off fresh same-session levels.
  await refreshIntradayScans();

  // QQQ Manual levels CARRY FORWARD (owner 2026-07-17): if nothing was entered
  // today, clone the latest day's list into today (fresh ids, directions off the
  // live spot). Once ensured for a day, the check is remembered in memory so it
  // costs zero DB reads on subsequent ticks (cold start re-checks once — idempotent).
  {
    const today = new Date().toISOString().slice(0, 10);
    if (mem.carriedDay !== today) {
      try {
        if (!getProfile("qqq_manual").shelved && (await carryForwardManualLevels(today))) {
          mem.cands = null; // new candidates exist — force a fresh read below
          await sendPush(
            "QQQ Manual: reusing your last levels",
            "No levels entered today — yesterday's list is live. Update it on Setups if your chart changed.",
            "/setups?profile=qqq_manual",
          ).catch(() => {});
        }
        mem.carriedDay = today;
      } catch {
        /* carry-forward is best-effort (retried next tick); a fresh save always works */
      }
    }
  }

  // Candidate list: cached in memory for CAND_CACHE_MS. Candidates change rarely
  // intraday (nightly scan + explicit invalidations above); a manual-level save from
  // ANOTHER instance goes live within the TTL (~2 min) — acceptable staleness for a
  // large cut in per-tick reads. Entries/dedup stay exact: fired/tapped checks below
  // always hit the DB before any order is placed.
  let allRows: (typeof candidates.$inferSelect)[];
  if (mem.cands && mem.cands.at > Date.now() - CAND_CACHE_MS) {
    allRows = mem.cands.rows;
  } else {
    const [latest] = await db
      .select({ d: candidates.runDate })
      .from(candidates)
      .orderBy(desc(candidates.runDate))
      .limit(1);
    if (!latest) return [];
    allRows = await db.select().from(candidates).where(eq(candidates.runDate, latest.d));
    mem.cands = { at: Date.now(), rows: allRows };
  }

  const cands = allRows.filter((c) => {
    if (!(c.direction === "call" || c.direction === "put") || !c.zone) return false;
    const prof = getProfile(c.profileId);
    if (prof.shelved) return false; // quarantined — no live signals (e.g. zones_legacy)
    // Clear-runway (white space) is required unless the profile opts out (QQQ 0DTE
    // relies on its confirmation candle instead — intraday zones sit too close).
    if (prof.requireClearRunway !== false && !c.clearRunway) return false;
    return true;
  });
  if (cands.length === 0) return [];

  const prices = await getLatestPrices([...new Set(cands.map((c) => c.symbol))]); // Alpaca, not the DB
  const fires: Fire[] = [];
  const today = new Date().toISOString().slice(0, 10);
  // Outcome push for a tapped SBv2 setup that did NOT enter (pairs with the "checking"
  // alert): the owner sees checking -> bought (via executeProposal) OR not-entered here.
  // Auto-off profiles stay silent (SBv3 is an undiverged SBv2 clone — pushing for both
  // would double every alert; a paused profile shouldn't buzz the phone either).
  const notifyBlocked = async (pid: string, sym: string, dir: string, why: string) => {
    try {
      if (!(await cachedSettings(pid)).autoExecute) return;
      await sendPush(`${getProfile(pid).label}: ${sym} not entered`, `${dir.toUpperCase()} blocked — ${why}`, "/positions");
    } catch {
      /* push failures never break the tick */
    }
  };

  // In-memory TRIGGER PRECHECK (DB-traffic diet): mirrors each entry branch's own
  // price gate EXACTLY, using only the fetched quotes. On a quiet tick — nothing at a
  // boundary — the entry path does ZERO DB reads (no crossing-state, no dedup
  // queries, no market-context bars). When any candidate is at its trigger, the full
  // original evaluation below runs unchanged, dedup queries and all.
  const usesPrevState = (p: Profile) => p.entryKind !== "flip_retest" && !p.manualLevels && !p.confirmation.enabled;
  const maybeTriggered = cands.some((c) => {
    const cur = prices[c.symbol];
    if (cur == null) return false;
    const z = c.zone as { bottom: number; top: number };
    const p = getProfile(c.profileId);
    if (p.entryKind === "flip_retest") {
      const b = (c.setup as { flipped_boundary?: number } | null)?.flipped_boundary ?? (c.direction === "call" ? z.top : z.bottom);
      return b > 0 && Math.abs(cur - b) / b <= FLIP_TAP_BAND;
    }
    if (p.manualLevels) {
      const lvl = (c.setup as { manual?: { level?: number } } | null)?.manual?.level ?? (z.bottom + z.top) / 2;
      return lvl > 0 && Math.abs(cur - lvl) / lvl <= LEVEL_TOUCH_BAND;
    }
    if (p.confirmation.enabled) return cur >= z.bottom * 0.99 && cur <= z.top * 1.01;
    return true; // tap-crossing profiles need prev-tick state — must run the loop
  });

  if (maybeTriggered) {
    // Durable crossing state — only tap-crossing profiles (zones_legacy, shelved)
    // use it; skip both the read AND the write when no active profile needs it.
    const usePrev = cands.some((c) => usesPrevState(getProfile(c.profileId)));
    let stateRow: typeof monitorState.$inferSelect | null = null;
    if (usePrev) {
      [stateRow] = await db.select().from(monitorState).limit(1);
      if (!stateRow) [stateRow] = await db.insert(monitorState).values({}).returning();
    }
    const prevPrices = { ...((stateRow?.prices as Record<string, number> | undefined) ?? {}) };
    const nextPrices = { ...prevPrices };

    // Durable dedup: which candidates already fired a proposal.
    const firedRows = await db
      .select({ cid: proposals.candidateId })
      .from(proposals)
      .where(inArray(proposals.candidateId, cands.map((c) => c.id)));
    const firedSet = new Set(firedRows.map((r) => r.cid));

    // Durable dedup for the SBv2 tap trigger: candidates that already logged a tap today.
    // The flip entry fires on a boundary TAP (not a crossing edge), so it needs this to
    // fire once per candidate per day (a proposal isn't always created — e.g. a skip).
    const tapRows = await db
      .select({ cid: activityLog.candidateId })
      .from(activityLog)
      .where(and(eq(activityLog.kind, "tap"), eq(activityLog.runDate, today), inArray(activityLog.candidateId, cands.map((c) => c.id))));
    const tappedSet = new Set(tapRows.map((r) => r.cid));

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
    if (profile.entryKind === "flip_retest") {
      // SBv2: enter on the FIRST TAP of the flipped boundary — price reaching the level
      // (within a small band), NOT a strict two-tick crossing (which can miss a fast tap
      // that happens between minute ticks). Deduped via tappedSet so it fires once per
      // candidate per day even when a tap doesn't result in a proposal.
      if (tappedSet.has(c.id)) continue; // already tapped today
      const boundary = (c.setup as { flipped_boundary?: number } | null)?.flipped_boundary ?? (direction === "call" ? z.top : z.bottom);
      const atBoundary = boundary > 0 && Math.abs(cur - boundary) / boundary <= FLIP_TAP_BAND;
      if (!atBoundary) continue;
      // "Checking" audit alert (SBv2): fire the moment the flipped boundary is tapped,
      // for ALL watchlist setups, so alert timing/accuracy can be audited. This is NOT a
      // command — the buy may still be blocked; a separate "Bought"/"not entered" push
      // follows once the outcome is known. Logging the tap below adds this candidate to
      // tappedSet on the next tick, so it won't re-fire while price rests at the zone.
      // Pushes only for profiles that can actually BUY (auto on) — SBv3 is an undiverged
      // SBv2 clone, so alerting for both would double every tap notification; its taps
      // are still logged for measurement.
      if ((await cachedSettings(c.profileId)).autoExecute) {
        await sendPush(`${profile.label}: ${c.symbol} zone tap ${cur}`, `${direction.toUpperCase()} — checking…`, "/positions").catch(() => {});
      }
      await logActivity([{ profileId: c.profileId, symbol: c.symbol, kind: "tap", direction, price: cur, candidateId: c.id, detail: `zone tap ${cur} — checking ${direction.toUpperCase()}` }]);
      confirmReason = " First retest of the flipped boundary.";
    } else if (profile.manualLevels) {
      // QQQ Manual: enter on the LEVEL TOUCH (Farrukh's ladder message supersedes the
      // earlier confirmation-candle rule). Same machinery as SBv2's tap: a proximity
      // band + once-per-level-per-day dedup via the tap activity row. The real filters
      // are downstream: 60% DB probability floor + EV net of costs + cached catalyst.
      if (tappedSet.has(c.id)) continue; // already touched today
      const level = (c.setup as { manual?: { level?: number } } | null)?.manual?.level ?? (z.bottom + z.top) / 2;
      const atLevel = level > 0 && Math.abs(cur - level) / level <= LEVEL_TOUCH_BAND;
      if (!atLevel) continue;
      if ((await cachedSettings(c.profileId)).autoExecute) {
        await sendPush(`${profile.label}: ${c.symbol} level touch ${cur}`, `${direction.toUpperCase()} — checking…`, "/positions").catch(() => {});
      }
      await logActivity([{ profileId: c.profileId, symbol: c.symbol, kind: "tap", direction, price: cur, candidateId: c.id, detail: `level touch ${cur} — checking ${direction.toUpperCase()}` }]);
      confirmReason = ` Level ${level} touched.`;
    } else if (profile.confirmation.enabled) {
      // Confirmation profiles (SBv1, QQQ 0DTE, SB15M): fire only when price is AT
      // the zone AND an intraday confirmation candle prints (rejection/engulf/strong
      // close + relative volume) — never on a bare tap.
      const atZone = cur >= z.bottom * 0.99 && cur <= z.top * 1.01;
      if (!atZone) continue;
      if (profile.id === "sb15m") {
        // SB 15M day trader (spec 2026-07-21): decisions on COMPLETED 15-minute
        // candles only, inside the 9:45am-2:45pm ET window, with the 15-min market
        // structure as a confirmation filter (structure never triggers on its own;
        // an OPPOSED structure blocks unless the rejection candle is strong —
        // spec §8's "unless the zone reaction produces a confirmed reversal").
        if (!inEntryWindow(profile)) continue;
        let bars15: Bar[] = [];
        try {
          bars15 = await getIntradayBars(c.symbol, "15Min", 3 * 390);
        } catch {
          continue;
        }
        const completed = bars15.filter((b) => Date.parse(b.t) + 15 * 60_000 <= Date.now());
        const conf = evaluateConfirmation(completed, direction, z, profile.confirmation.minRelVolume);
        if (!conf.confirmed) continue;
        const structure = classifyStructure(completed);
        const opposed = (direction === "call" && structure === "bearish") || (direction === "put" && structure === "bullish");
        if (opposed && conf.executionScore < 60) {
          fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: `skipped — 15m structure ${structure} opposes the ${direction} and the rejection isn't strong (exec ${conf.executionScore})` });
          continue;
        }
        confirmReason = ` Confirmed on a completed 15m candle: ${conf.reason}. 15m structure ${structure}.`;
        execScore = conf.executionScore;
      } else {
        const conf = await confirmEntry(c.symbol, direction, z, profile.confirmation.minRelVolume);
        if (!conf.confirmed) continue;
        confirmReason = ` Confirmed: ${conf.reason}.`;
        execScore = conf.executionScore;
      }
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

    // SBv2 flip validity is fixed at the scan (off the settled daily close) — it can't
    // change intraday because there's no new daily close during the session. We do NOT
    // re-derive it from a fresh data fetch (that fetch can disagree with the scanner's
    // and falsely invalidate a good flip). The real intraday guard is execute.ts's
    // live price-vs-zone check (rejects a wrong-way entry if price has crossed the zone).
    // We only guard against an ANCIENT candidate (a missed nightly scan).
    if (profile.entryKind === "flip_retest") {
      const scanAgeDays = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${c.runDate}T00:00:00Z`)) / 86_400_000;
      if (scanAgeDays > 3) {
        fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: `flip scan ${Math.round(scanAgeDays)}d old (missed scan) — skipped` });
        await notifyBlocked(c.profileId, c.symbol, direction, "watchlist scan too old");
        continue;
      }
    }
    // SBv2 (flip_retest) enters MECHANICALLY on a valid first-retest tap: NO playbook
    // score gate and NO adversarial sniper engine (per sniperbot-daily-swing-v2.md). It
    // keeps only the spec's light gates: a valid DB target (reward/move large enough) +
    // the news-against veto. SBv1/QQQ keep the score gate + sniper engine unchanged.
    const mechanical = profile.entryKind === "flip_retest";
    if (!pb) {
      fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: "could not score; skipped" });
      if (mechanical || profile.manualLevels) await notifyBlocked(c.profileId, c.symbol, direction, "could not read the chart");
      continue;
    }
    // Playbook score gate — skipped for mechanical entries (SBv2 flips per spec) AND
    // manual levels (a ±0.15% synthetic zone isn't a scanned order block; the owner's
    // level + the probability floor + EV are the QQQ Manual filters).
    if (!mechanical && !profile.manualLevels && pb.score < profile.minScore) {
      fires.push({
        symbol: c.symbol,
        direction,
        candidateId: c.id,
        price: cur,
        placed: false,
        detail: `score ${pb.score}/100 < ${profile.minScore} (${pb.playbook}); skipped`,
      });
      continue;
    }

    // Confidence engine (SBv1/QQQ) or mechanical flip vet (SBv2). Both use the reaction
    // DB for numbers; neither lets the model produce a probability/target.
    let sniperConfidence = pb.score / 100;
    let sniperSummary = "";
    if (profile.confirmation.enabled) {
      const marketAlign = ((marketCtx.spy + marketCtx.qqq) / 2) * (direction === "call" ? 1 : -1);
      const pred = await predict(c.symbol, cur, c.timeframe, direction, c.approach ?? "", marketAlign);
      // HARD probability floor (QQQ 0DTE): a ~50% coin flip loses to spread + same-day
      // theta, so below the floor the correct action is NO trade. Only profiles that set
      // minProbability are affected (SBv1/SBv2 leave it unset → unchanged).
      if (profile.minProbability != null && pred.probability < profile.minProbability) {
        fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: `skipped — probability ${Math.round(pred.probability)}% < ${profile.minProbability}% floor (coin flip)` });
        continue;
      }
      if (mechanical) {
        // News veto — read the verdict the NIGHTLY vet (/api/vet-flips) stored on the
        // candidate. Zero hot-path Claude cost (the ~40s web-search call would blow the
        // 60s tick when several names tap at once). Block on a scheduled earnings/Fed
        // catalyst or fresh news against the accepted breakout. Un-vetted flips have no
        // verdict → fail open (trade).
        const news = (c.setup as { news?: { catalyst?: boolean; event?: string; newsAgainst?: boolean; newsFor?: boolean; summary?: string } } | null)?.news;
        if (news?.catalyst) {
          fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: `skipped — catalyst: ${news.event ?? "scheduled event"}` });
          await notifyBlocked(c.profileId, c.symbol, direction, `earnings/Fed: ${news.event || "scheduled event"}`);
          continue;
        }
        if (news?.newsAgainst) {
          fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: `skipped — news contradicts the flip: ${news.summary ?? ""}`.trim() });
          await notifyBlocked(c.profileId, c.symbol, direction, "fresh news against the breakout");
          continue;
        }
        // Reward / "move large enough": require a reaction-DB target — no target means
        // thin history or too small a projected move, so skip.
        if (pred.targetMain == null) {
          fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: "skipped — no DB target (move too small / thin history)" });
          await notifyBlocked(c.profileId, c.symbol, direction, "no historical target (move too small)");
          continue;
        }
        // Market-intelligence + portfolio-risk layer (owner 2026-07-18, after the
        // 7/17 correlated-calls day): market/stock bias, structure, relative
        // strength, same-direction + sector exposure caps, session loss response.
        // ONE call site, all logic in src/lib/intel.ts. REVERT: env SBV2_INTEL=off.
        if (intelEnabled(c.profileId)) {
          try {
            const verdict = await evaluateSbv2Intel(c.symbol, direction);
            if (!verdict.allowed) {
              fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: verdict.summary });
              await notifyBlocked(c.profileId, c.symbol, direction, verdict.summary.slice(0, 90));
              continue;
            }
            sniperSummary = ` ${verdict.summary}`;
          } catch {
            /* intel is advisory scaffolding — a data hiccup FAILS OPEN to the
               mechanical entry rather than silently disabling SBv2 */
          }
        }
        sniperConfidence = Math.max(0, Math.min(1, pred.probability / 100));
        sniperSummary = ` ${pred.reason} Target ${pred.targetMain}.${news?.newsFor ? " News supports it." : ""}` + sniperSummary;
      } else if (profile.manualLevels) {
        // QQQ Manual: MECHANICAL level-touch entry — no candle, no sniper engine (with
        // no confirmation the exec-quality input is 0 and would auto-reject everything).
        // Gates: the 60% probability floor (above), a reaction-DB target (move big
        // enough — execute overrides it with the NEXT LEVEL), the cached catalyst check.
        if (pred.targetMain == null) {
          fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: "skipped — no DB target (move too small / thin history)" });
          await notifyBlocked(c.profileId, c.symbol, direction, "no historical target (move too small)");
          continue;
        }
        const cat = await cachedCatalyst(c.symbol, c.profileId, direction, today, c.id);
        if (cat.catalyst) {
          fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: `skipped — catalyst: ${cat.event}` });
          await notifyBlocked(c.profileId, c.symbol, direction, `earnings/Fed: ${cat.event || "scheduled event"}`);
          continue;
        }
        sniperConfidence = Math.max(0, Math.min(1, pred.probability / 100));
        sniperSummary = ` ${pred.reason} Riding to the next level.`;
      } else {
        const isIntraday = profile.exit.style === "intraday"; // QQQ 0DTE — judge as a same-day scalp
        const ev = evaluateSniper(pb, bars, direction, execScore, c.clearRunway, marketCtx, pred, isIntraday);
        if (!ev.passed) {
          fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: `rejected: ${ev.rejections[0] ?? "adversarial"}` });
          continue;
        }
        const cat = await cachedCatalyst(c.symbol, c.profileId, direction, today, c.id);
        if (cat.catalyst) {
          fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: `skipped — catalyst: ${cat.event}` });
          continue;
        }
        sniperConfidence = ev.overall / 100;
        sniperSummary = ` ${pred.reason} ${ev.summary}${cat.checked ? "" : " (catalyst unchecked)"}`;
      }
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
          plainExplanation: `${
            profile.entryKind === "flip_retest"
              ? `${c.symbol} just retested a flipped daily order block live (${pb.playbook})`
              : `${c.symbol} just tapped its zone live (${pb.playbook})`
          }, betting on a ${direction === "call" ? "bounce up off support" : "rejection down off resistance"} ${
            profile.exit.style === "intraday" ? "intraday" : profile.id === "sbv2" ? "over the next 1-2 days" : "over the next 1-2 weeks"
          }.`,
          sources: [],
          status: "pending" as const,
          variant: "news_plus_zones",
          zoneSetup: c.setup,
          zoneRead: alert,
          candidateId: c.id,
          profileId: c.profileId,
        })
        .returning({ id: proposals.id });

      // Profiles whose broker falls back to SBv1's DEFAULT account when their own
      // keys are missing must never auto-buy in that state: qqq_manual needs the QQQ
      // account keys (ALPACA_*_2), sbv3 needs ALPACA_*_5, sb15m needs ALPACA_*_4.
      const noOwnAccount =
        (c.profileId === "qqq_manual" && !process.env.ALPACA_API_KEY_ID2?.trim()) ||
        (c.profileId === "sbv3" && !process.env.ALPACA_API_KEY_ID5?.trim()) ||
        (c.profileId === "sb15m" && !process.env.ALPACA_API_KEY_ID4?.trim());
      const autoOn = !noOwnAccount && (await cachedSettings(c.profileId)).autoExecute;
      if (noOwnAccount) {
        const keysHint = c.profileId === "sbv3" ? "ALPACA_*_5" : c.profileId === "sb15m" ? "ALPACA_*_4" : "ALPACA_*_2";
        await db
          .update(proposals)
          .set({ status: "expired", zoneRead: `${alert} Auto-skip: ${c.profileId} has no account keys (set ${keysHint})` })
          .where(eq(proposals.id, prop.id));
        fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: `skipped — ${c.profileId} needs its account keys (${keysHint})` });
      } else if (autoOn) {
        try {
          const r = await executeProposal(prop.id, "auto");
          fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: true, detail: `order #${r.orderId} ${r.orderStatus}` });
          // Buy notification now fires inside executeProposal (covers auto + manual).
        } catch (e) {
          // Full-auto: a skipped buy (e.g. no cheap contract) must NOT sit pending
          // asking the owner to approve — the bot already decided. Mark it auto-skipped.
          const why = e instanceof Error ? e.message.slice(0, 90) : "execute error";
          await db
            .update(proposals)
            .set({ status: "expired", zoneRead: `${alert} Auto-skip: ${why}` })
            .where(eq(proposals.id, prop.id));
          fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: why });
          if (profile.entryKind === "flip_retest" || profile.manualLevels) await notifyBlocked(c.profileId, c.symbol, direction, friendlyBlock(why));
        }
      } else {
        fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: "proposal created (auto-buy off)" });
      }
    } catch {
      fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: "proposal insert failed" });
    }
  }

    // Persist crossing state only when a tap-crossing profile is actually using it.
    if (usePrev && stateRow) {
      await db.update(monitorState).set({ prices: nextPrices, updatedAt: new Date() }).where(eq(monitorState.id, stateRow.id));
    }
  } // end maybeTriggered

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
    // Drift healing (late buy-fills + broker-closed positions) runs on a SLOW
    // cadence, not every tick — it's reconciliation, not trading. Executes/exits in
    // this instance write the DB directly, so nothing here is load-bearing minute
    // to minute; a 5-min sweep keeps DB/broker truth aligned with far fewer reads.
    if (Date.now() - mem.lastMaintenance >= MAINTENANCE_MS) {
      mem.lastMaintenance = Date.now();
      for (const p of activeProfiles()) {
        try {
          await syncPendingBuyFills(p.id); // record late entry fills FIRST...
          await reconcileClosedPositions(p.id); // ...so reconcile (status='filled' only) sees them
        } catch {
          // best-effort
        }
      }
    }
    for (const pid of ["sniper_swing", "sbv2", "sbv3", "qqq_0dte", "qqq_manual", "sb15m"]) {
      try {
        // A shelved profile is PAUSED: no orders, and no exit management — its account
        // may have been handed to another profile (qqq_0dte → qqq_manual, 2026-07-15),
        // and two profiles managing one account would flatten each other's positions.
        // Code-level so a stale autoManage DB flag can't override it.
        if (getProfile(pid).shelved) continue;
        // Profiles without their own keys fall back to SBv1's default account for
        // reads — never manage exits there (qqq_manual → keys2, sbv3 → keys5).
        if (pid === "qqq_manual" && !process.env.ALPACA_API_KEY_ID2?.trim()) continue;
        if (pid === "sbv3" && !process.env.ALPACA_API_KEY_ID5?.trim()) continue;
        if (pid === "sb15m" && !process.env.ALPACA_API_KEY_ID4?.trim()) continue;
        if (!(await cachedSettings(pid)).autoManage) continue;
        fires.push(...(await manageExits(pid, nearClose)));
      } catch {
        // best-effort
      }
    }
  }

  // Persist decisions. CRITICAL rows (buys, sells) are written IMMEDIATELY and
  // individually — an ungraceful crash can never lose a trade record. SKIP rows
  // (repetitive "score too low" style decisions, ~hundreds/day) are batched in
  // memory and flushed piggybacked on any critical write, on age (<=4 min), or on
  // size. Tap signals + catalyst verdicts were already written inline above.
  await flushTickActivity(
    fires.map((f) => {
      const cand = f.candidateId ? cands.find((c) => c.id === f.candidateId) : undefined;
      return {
        profileId: f.profileId ?? cand?.profileId ?? null,
        symbol: f.symbol,
        kind: fireKind(f.placed, f.detail),
        direction: f.direction,
        price: f.price,
        candidateId: f.candidateId || null,
        detail: f.detail,
      };
    }),
  );
  return fires;
}
