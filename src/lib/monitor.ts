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
import { candidates, monitorState, orders, proposals, researchRuns } from "../db/schema";
import { getLatestPrices, getStockBars, getOptionQuotes, midPrice, getClock } from "./alpaca";
import { getBroker } from "./broker";
import { executeProposal } from "./execute";
import { classifyAndScore } from "./playbook";
import { parseOcc } from "./format";
import { sendPush } from "./push";
import { getProfile, activeProfiles } from "./profiles";
import { computeZones } from "./zones";
import { detectFlips, DEFAULT_FLIP_OPTIONS } from "./flips";
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
              let target: number | null = null;
              try {
                target = classifyAndScore(bars, { bottom: zone.bottom, top: zone.top }, zone.direction, underlyingNow).safeTarget;
              } catch {
                target = null;
              }
              if (target != null && ((zone.direction === "call" && underlyingNow >= target) || (zone.direction === "put" && underlyingNow <= target))) {
                reason = `hit first target ${target} (underlying ${underlyingNow})`;
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
      // SBv2: fire on the FIRST live tap of the flipped boundary (a crossing between
      // ticks). Durable dedup (firedSet) guarantees only the first retest ever fires.
      // The daily flip state is re-validated below before the order is placed.
      if (prev === undefined) continue; // first sighting: establish baseline
      if (!tapCrossing(direction, prev, cur, z.bottom, z.top)) continue;
      // Best-effort confirmation candle for the execution-quality score — NOT required
      // (the spec enters on the first clean retest tap itself).
      try {
        const conf = await confirmEntry(c.symbol, direction, z, profile.confirmation.minRelVolume);
        execScore = conf.executionScore;
        confirmReason = conf.confirmed ? ` First retest + ${conf.reason}.` : ` First retest of the flipped boundary.`;
      } catch {
        confirmReason = " First retest of the flipped boundary.";
      }
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

    // SBv2: re-validate the flip on the FRESH settled daily bars before committing —
    // the scan is hours old. Exclude today's in-progress candle (the live retest tap
    // is exactly what we're firing on; including it would self-invalidate). If the
    // flip closed back inside / went stale / already retested on a completed bar, skip.
    if (profile.entryKind === "flip_retest") {
      let stillValid = false;
      try {
        const completed = bars.filter((b) => b.t.slice(0, 10) < today);
        const { zones } = computeZones(completed, profile.zoneTimeframes[0].opts);
        const fresh = detectFlips(completed, zones, DEFAULT_FLIP_OPTIONS);
        const setup = c.setup as { flipped_boundary?: number } | null;
        const wantBound = setup?.flipped_boundary ?? (direction === "call" ? z.top : z.bottom);
        stillValid = fresh.some((f) => f.direction === direction && Math.abs(f.flippedBoundary - wantBound) / wantBound < 0.005);
      } catch {
        stillValid = false;
      }
      if (!stillValid) {
        fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: "flip invalidated (stale) — skipped" });
        continue;
      }
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
      const isIntraday = profile.exit.style === "intraday"; // QQQ 0DTE — judge as a same-day scalp
      const ev = evaluateSniper(pb, bars, direction, execScore, c.clearRunway, marketCtx, pred, isIntraday);
      if (!ev.passed) {
        fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: `rejected: ${ev.rejections[0] ?? "adversarial"}` });
        continue;
      }
      // Flip setups (SBv2) also get a flip-aware NEWS-CONTEXT read (does fresh news
      // support or contradict the accepted breakout?); tap setups keep the plain
      // scheduled-catalyst check. Both fail open.
      const cat = await checkCatalyst(c.symbol, 5, c.profileId, profile.entryKind === "flip_retest" ? { direction } : undefined);
      if (cat.catalyst) {
        fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: `skipped — catalyst: ${cat.event}` });
        continue;
      }
      if (cat.newsAgainst) {
        fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: `skipped — news contradicts the flip: ${cat.newsSummary ?? ""}`.trim() });
        continue;
      }
      sniperConfidence = ev.overall / 100;
      const newsNote = cat.newsFor ? ` News supports it: ${cat.newsSummary ?? ""}.` : cat.newsSummary ? ` News: ${cat.newsSummary}.` : "";
      sniperSummary = ` ${pred.reason} ${ev.summary}${newsNote}${cat.checked ? "" : " (catalyst unchecked)"}`;
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
        await reconcileClosedPositions(p.id);
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
