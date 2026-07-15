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
import { candidates, monitorState, orders, proposals, researchRuns, activityLog } from "../db/schema";
import { getLatestPrices, getStockBars, getOptionQuotes, midPrice, getClock } from "./alpaca";
import { getBroker } from "./broker";
import { executeProposal } from "./execute";
import { classifyAndScore } from "./playbook";
import { parseOcc } from "./format";
import { sendPush } from "./push";
import { getProfile, activeProfiles } from "./profiles";
import { scanProfile } from "./scanner";
import { zoneOfPosition } from "./manage";
import { getProfileSettings } from "./profile-settings";
import { confirmEntry } from "./confirm";
import { evaluateSniper, indexTrend, type MarketContext } from "./sniper";
import { predict } from "./predict";
import { checkCatalyst } from "./catalyst";
import { logActivity, fireKind } from "./activity";
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

// SBv2 enters when price is within this fraction of the flipped boundary — "taps the
// level". Wide enough to catch the tap at minute granularity, tight enough to be a real
// touch. Deduped to once per candidate per day (see tappedSet).
const FLIP_TAP_BAND = 0.004; // 0.4%

/** Turn a raw execute error into a short, plain "why it didn't buy" for the push. */
function friendlyBlock(msg: string): string {
  const s = msg.toLowerCase();
  if (s.includes("no affordable") || s.includes("price cap") || s.includes("no contract fits") || s.includes("no_quote")) return "no cheap contract that reaches the target";
  if (s.includes("open-position cap") || s.includes("open_cap")) return "position cap reached";
  if (s.includes("invalidated") || s.includes("crossed the zone")) return "price moved the wrong way";
  if (s.includes("market closed")) return "market closed";
  return msg.slice(0, 60);
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
  const today = new Date().toISOString().slice(0, 10);

  for (const p of positions) {
    const entry = Number(p.avg_entry_price);
    const q = quotes[p.symbol];
    const bid = q?.bp && q.bp > 0 ? q.bp : midPrice(q);
    if (!entry || entry <= 0 || bid == null) continue;
    const ret = (bid - entry) / entry;
    const occ = parseOcc(p.symbol);
    const daysToExpiry = occ?.expiry ? Math.ceil((Date.parse(`${occ.expiry}T00:00:00Z`) - Date.now()) / 86_400_000) : Infinity;

    let reason = ""; // non-empty => close this position; empty => HOLD

    if (profile.exit.style === "swing") {
      // SWING: hold toward the first target over the multi-day horizon. Exit ONLY on
      // swing INVALIDATION (a completed daily close back through the zone against the
      // trade), a first-target hit, the $2 upside take-profit, or expiry salvage.
      // NO intraday premium hard stop — a cheap option dipping intraday is HELD.
      const tgtPrem = profile.exit.targetPremium;
      if (tgtPrem && bid >= tgtPrem) reason = `rode to $${bid.toFixed(2)} (>= $${tgtPrem.toFixed(2)} target)`;

      if (!reason) {
        const zone = occ ? await zoneOfPosition(p.symbol) : null;
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
      await sendPush(`Sold ${sym} ${pct}`, reason, "/positions").catch(() => {});
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
    if (!p.zoneTimeframes.some((z) => z.timeframe === "1h" || z.timeframe === "15min")) continue;
    const [newest] = await db
      .select({ at: candidates.createdAt })
      .from(candidates)
      .where(eq(candidates.profileId, p.id))
      .orderBy(desc(candidates.createdAt))
      .limit(1);
    const age = newest?.at ? Date.now() - new Date(newest.at).getTime() : Infinity;
    if (age > INTRADAY_RESCAN_MS) {
      try {
        await scanProfile(p, today);
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

  const [latest] = await db
    .select({ d: candidates.runDate })
    .from(candidates)
    .orderBy(desc(candidates.runDate))
    .limit(1);
  if (!latest) return [];

  const cands = (await db.select().from(candidates).where(eq(candidates.runDate, latest.d))).filter((c) => {
    if (!(c.direction === "call" || c.direction === "put") || !c.zone) return false;
    const prof = getProfile(c.profileId);
    if (prof.shelved) return false; // quarantined — no live signals (e.g. zones_legacy)
    // Clear-runway (white space) is required unless the profile opts out (QQQ 0DTE
    // relies on its confirmation candle instead — intraday zones sit too close).
    if (prof.requireClearRunway !== false && !c.clearRunway) return false;
    return true;
  });
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
  const today = new Date().toISOString().slice(0, 10);
  // Outcome push for a tapped SBv2 setup that did NOT enter (pairs with the "checking"
  // alert): the owner sees checking -> bought (via executeProposal) OR not-entered here.
  const notifyBlocked = (sym: string, dir: string, why: string) =>
    sendPush(`${sym} not entered`, `${dir.toUpperCase()} blocked — ${why}`, "/positions").catch(() => {});
  // Durable dedup for the SBv2 tap trigger: candidates that already logged a tap today.
  // The flip entry fires on a boundary TAP (not a crossing edge), so it needs this to
  // fire once per candidate per day (a proposal isn't always created — e.g. a skip).
  const tapRows = cands.length
    ? await db
        .select({ cid: activityLog.candidateId })
        .from(activityLog)
        .where(and(eq(activityLog.kind, "tap"), eq(activityLog.runDate, today), inArray(activityLog.candidateId, cands.map((c) => c.id))))
    : [];
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
      await sendPush(`${c.symbol} zone tap ${cur}`, `${direction.toUpperCase()} — checking…`, "/positions").catch(() => {});
      await logActivity([{ profileId: c.profileId, symbol: c.symbol, kind: "tap", direction, price: cur, candidateId: c.id, detail: `zone tap ${cur} — checking ${direction.toUpperCase()}` }]);
      confirmReason = " First retest of the flipped boundary.";
    } else if (profile.confirmation.enabled) {
      // Confirmation profiles (SBv1, QQQ 0DTE): fire only when price is AT the
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
        await notifyBlocked(c.symbol, direction, "watchlist scan too old");
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
      if (mechanical) await notifyBlocked(c.symbol, direction, "could not read the chart");
      continue;
    }
    if (!mechanical && pb.score < profile.minScore) {
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
          await notifyBlocked(c.symbol, direction, `earnings/Fed: ${news.event || "scheduled event"}`);
          continue;
        }
        if (news?.newsAgainst) {
          fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: `skipped — news contradicts the flip: ${news.summary ?? ""}`.trim() });
          await notifyBlocked(c.symbol, direction, "fresh news against the breakout");
          continue;
        }
        // Reward / "move large enough": require a reaction-DB target — no target means
        // thin history or too small a projected move, so skip.
        if (pred.targetMain == null) {
          fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: "skipped — no DB target (move too small / thin history)" });
          await notifyBlocked(c.symbol, direction, "no historical target (move too small)");
          continue;
        }
        sniperConfidence = Math.max(0, Math.min(1, pred.probability / 100));
        sniperSummary = ` ${pred.reason} Target ${pred.targetMain}.${news?.newsFor ? " News supports it." : ""}`;
      } else {
        const isIntraday = profile.exit.style === "intraday"; // QQQ 0DTE — judge as a same-day scalp
        const ev = evaluateSniper(pb, bars, direction, execScore, c.clearRunway, marketCtx, pred, isIntraday);
        if (!ev.passed) {
          fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: `rejected: ${ev.rejections[0] ?? "adversarial"}` });
          continue;
        }
        // ONE catalyst check per symbol/profile/day, cached in the activity log (durable
        // across serverless ticks AND QQQ's ~5-min candidate re-scans). Without this, a
        // setup that passes the engine but dies downstream (contract band, caps) re-burned
        // a web-search Claude call EVERY minute — ~65 QQQ calls on 2026-07-13 alone, which
        // drained the API credits. Fail-open results are cached for the day too: a timeout
        // abort still consumes tokens, so retrying it each tick is the same leak.
        const [cachedCat] = await db
          .select({ meta: activityLog.meta })
          .from(activityLog)
          .where(
            and(
              eq(activityLog.kind, "catalyst"),
              eq(activityLog.runDate, today),
              eq(activityLog.symbol, c.symbol),
              eq(activityLog.profileId, c.profileId),
            ),
          )
          .limit(1);
        let cat = cachedCat?.meta as { catalyst: boolean; event: string; checked: boolean } | undefined;
        if (!cat) {
          cat = await checkCatalyst(c.symbol, 5, c.profileId); // tap setups: plain scheduled catalyst check
          await logActivity([
            {
              profileId: c.profileId,
              symbol: c.symbol,
              kind: "catalyst",
              direction,
              candidateId: c.id,
              detail: cat.catalyst ? `catalyst: ${cat.event}` : cat.checked ? "no catalyst" : "unchecked (call failed — fails open)",
              meta: { catalyst: cat.catalyst, event: cat.event, checked: cat.checked },
            },
          ]);
        }
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

      const autoOn = (await getProfileSettings(c.profileId)).autoExecute;
      if (autoOn) {
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
          if (profile.entryKind === "flip_retest") await notifyBlocked(c.symbol, direction, friendlyBlock(why));
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
    // Sync DB with broker truth every tick for ALL profiles (heals orphaned
    // "open" trades), including shelved zones_legacy on the shared account.
    for (const p of activeProfiles()) {
      try {
        await syncPendingBuyFills(p.id); // record late entry fills FIRST...
        await reconcileClosedPositions(p.id); // ...so reconcile (status='filled' only) sees them
      } catch {
        // best-effort
      }
    }
    for (const pid of ["sniper_swing", "sbv2", "qqq_0dte"]) {
      try {
        if (!(await getProfileSettings(pid)).autoManage) continue;
        fires.push(...(await manageExits(pid, nearClose)));
      } catch {
        // best-effort
      }
    }
  }

  await db.update(monitorState).set({ prices: nextPrices, updatedAt: new Date() }).where(eq(monitorState.id, row.id));

  // Persist every decision this tick (buys, sells, and skips-with-reason) for the
  // daily report. candidateId 0 (exits) is stored as null.
  await logActivity(
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
