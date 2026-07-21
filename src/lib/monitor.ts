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
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { candidates, monitorState, orders, positionState, proposals, researchRuns, activityLog } from "../db/schema";
import { getLatestPrices, getStockBars, getIntradayBars, getOptionQuotes, midPrice, getClock } from "./alpaca";
import { getBroker } from "./broker";
import { executeProposal } from "./execute";
import { classifyAndScore } from "./playbook";
import { parseOcc } from "./format";
import { sendPush } from "./push";
import { getProfile, activeProfiles, type Profile, type ExitConfig } from "./profiles";
import { scanProfile } from "./scanner";
import { zoneOfPosition } from "./manage";
import { getProfileSettings } from "./profile-settings";
import { confirmEntry } from "./confirm";
import { evaluateSniper, indexTrend, type MarketContext } from "./sniper";
import { predict } from "./predict";
import { checkCatalyst } from "./catalyst";
import { logActivity, fireKind } from "./activity";
import { carryForwardManualLevels } from "./manual-levels";
import { intelEnabled, evaluateSbv2Intel } from "./intel";
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
  // Previous tick's price per symbol — lets the manual-level PRECHECK notice a level
  // that price jumped clean through between two ticks (a proximity band alone would
  // miss it). Replaceable: a cold start just falls back to the proximity test.
  lastPrice: new Map<string, number>(),
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
// QQQ Manual PRECHECK band only (owner 2026-07-21: "do not enter early merely
// because price is within a wide percentage band"). A real touch is decided by
// manualApproach() below — price actually reaching/crossing the level relative to
// the prior completed 15-minute bar. This band, plus a last-tick crossing test, is
// only the cheap superset that decides whether the full evaluation runs at all.
const LEVEL_PRECHECK_BAND = 0.005;

// SB 15M (empty-space zone tap) — precheck band around the FACING boundary; the real
// entry test is `emptySpaceTap` below (touch + penetration + acceptance + feed age).
const TAP_PRECHECK_BAND = 0.004;
// How far price may reach past the boundary and still count as "touches or slightly
// penetrates" rather than "already deep inside the zone" / "gapped through": a
// quarter of the zone's own height, with a floor so a razor-thin zone is still
// tradable and a ceiling so a huge zone doesn't allow a deep entry.
const MAX_PENETRATION_ZONE_FRAC = 0.25;
const MIN_PENETRATION_PCT = 0.0006; // 0.06% of price
const MAX_PENETRATION_PCT = 0.004; // 0.4% of price
// A touch must be a real reach of the level, not "close enough" — this is only the
// tolerance for minute-granularity quotes.
const TOUCH_TOLERANCE_PCT = 0.0004; // 0.04% of price
// The 15-minute feed must be current: the newest bar (forming included) can't be
// older than this or we're trading a delayed quote.
const MAX_FEED_AGE_MS = 20 * 60_000;

/** SB 15M entry test (Farrukh spec, "message (5).txt"): price approaching through
 *  EMPTY SPACE touches the boundary FACING it — call = the TOP of a zone below,
 *  put = the BOTTOM of a zone above. Rejects the spec's do-not-enter cases: gapping
 *  clean through the level, already deep inside the zone, price having ACCEPTED
 *  through the zone, and a delayed data feed. */
type TapVerdict = { ok: true; boundary: number; penetration: number; barTime: string } | { ok: false; reason: string | null };
async function emptySpaceTap(
  symbol: string,
  direction: "call" | "put",
  zone: { bottom: number; top: number },
  cur: number,
): Promise<TapVerdict> {
  const boundary = direction === "call" ? zone.top : zone.bottom;
  if (!(boundary > 0)) return { ok: false, reason: null };
  const tol = cur * TOUCH_TOLERANCE_PCT;
  // Signed distance INTO the zone (negative = price hasn't reached the level yet).
  const penetration = direction === "call" ? boundary - cur : cur - boundary;
  if (penetration < -tol) return { ok: false, reason: null }; // not touched yet — stay on the watchlist
  const height = Math.max(0, zone.top - zone.bottom);
  const maxPen = Math.min(
    Math.max(height * MAX_PENETRATION_ZONE_FRAC, cur * MIN_PENETRATION_PCT),
    cur * MAX_PENETRATION_PCT,
  );
  if (penetration > maxPen) {
    return { ok: false, reason: `price ${cur} is ${penetration.toFixed(2)} past the ${boundary} boundary (max ${maxPen.toFixed(2)}) — gapped through or already deep inside the zone` };
  }
  // Feed age + acceptance-through check, both off the 15-minute chart the profile
  // trades. A completed bar that CLOSED beyond the far side of the zone means price
  // accepted through it — the level is no longer a rejection level.
  let bars: Bar[] = [];
  try {
    bars = await getIntradayBars(symbol, "15Min", 3 * 24 * 60);
  } catch {
    return { ok: false, reason: "15-minute data unavailable" };
  }
  const newest = bars[bars.length - 1];
  if (!newest || Date.now() - Date.parse(newest.t) > MAX_FEED_AGE_MS) {
    return { ok: false, reason: "data feed delayed (no fresh 15-minute bar)" };
  }
  const completed = bars.filter((b) => Date.parse(b.t) + 15 * 60_000 <= Date.now());
  const last = completed[completed.length - 1];
  if (last && ((direction === "call" && last.c < zone.bottom) || (direction === "put" && last.c > zone.top))) {
    return { ok: false, reason: `last completed 15m bar closed ${last.c}, through the zone ${zone.bottom}-${zone.top} — price has accepted through` };
  }
  return { ok: true, boundary, penetration, barTime: newest.t };
}

/** QQQ Manual, owner 2026-07-21. The prior COMPLETED 15-minute bar decides BOTH
 *  whether the level was really touched and which way we trade it:
 *    bar above the level + price now at/through it  => approached from above => CALL
 *    bar below the level + price now at/through it  => approached from below => PUT
 *  Direction is therefore decided at TOUCH time, never when the levels were saved. */
type ManualTouch =
  | { touched: false; reason: string }
  | { touched: true; direction: "call" | "put"; approach: "from_above" | "from_below"; barClose: number; barTime: string };
async function manualApproach(symbol: string, level: number, cur: number): Promise<ManualTouch> {
  let bars: Bar[] = [];
  try {
    // Wall-clock lookback, wide enough that a completed bar always exists — including
    // right after the 9:30 open (where the prior completed bar is the previous
    // session's last one) and after a weekend/holiday.
    bars = await getIntradayBars(symbol, "15Min", 5 * 24 * 60);
  } catch {
    return { touched: false, reason: "15-min bars unavailable" };
  }
  const prev = bars.filter((b) => Date.parse(b.t) + 15 * 60_000 <= Date.now()).pop();
  if (!prev) return { touched: false, reason: "no completed 15-min bar yet" };
  if (prev.c > level && cur <= level) return { touched: true, direction: "call", approach: "from_above", barClose: prev.c, barTime: prev.t };
  if (prev.c < level && cur >= level) return { touched: true, direction: "put", approach: "from_below", barClose: prev.c, barTime: prev.t };
  return { touched: false, reason: `level ${level} not reached (15m close ${prev.c}, now ${cur})` };
}

/** Has this profile actually PLACED a buy today? QQQ Manual takes ONE trade per
 *  session — "once the first level triggers an entry, ignore all other levels". A
 *  level that fails to enter (no contract in band, etc.) does NOT consume the day. */
async function enteredToday(profileId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<string>`count(*)` })
    .from(orders)
    .innerJoin(proposals, eq(orders.proposalId, proposals.id))
    .where(
      and(
        eq(proposals.profileId, profileId),
        sql`(${orders.submittedAt} AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date`,
        sql`${orders.status} not in ('canceled', 'rejected')`,
      ),
    );
  return Number(row?.n ?? 0) > 0;
}

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
  if (s.includes("full") && s.includes("contract lot")) return "no contract in the $0.30-0.35 band with size for the full 5-lot";
  if (s.includes("daily trade cap")) return "daily trade limit reached";
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

/** PURE ladder decision: given the exit config and the position's current state,
 *  return the enforced stop plus AT MOST ONE action (a full close or a single trim).
 *  Priority: structural invalidation → stop → full-lot take-profit → underlying
 *  target → no-bounce time-out → end-of-day flatten → the next untaken trim rung.
 *  No I/O, so scripts/ladder-selftest.ts can assert every rung of the spec. */
export interface LadderPlanInput {
  exit: ExitConfig;
  ret: number; // current premium return vs the average FILL
  peak: number; // high-water return (the ratchet never loosens)
  trims: number[]; // rung levels already taken
  entryQty: number; // contracts originally filled
  heldQty: number; // contracts still open
  invalidatedReason?: string; // SB15M 15-min structural close-through
  nearTargetLevel?: number | null; // underlying target reached (null = not / disabled)
  spot?: number | null;
  timedOutMin?: number | null; // expected-hold minutes when the no-bounce timeout fired
  eodFlatten?: boolean;
}
export interface LadderPlanResult {
  stop: number; // the stop currently enforced (fraction of premium)
  close: string; // non-empty => sell EVERYTHING still open, with this reason
  trim: { qty: number; atPct: number; newStop: number } | null;
}
export function ladderPlan(i: LadderPlanInput): LadderPlanResult {
  const L = i.exit.ladder!;
  // Rungs: the profile's explicit list (QQQ Manual — +50% sell 2 → stop breakeven,
  // +75% sell 1 → stop +25%) or the legacy trim1/trim2 pair (SB15M).
  const rungs = L.rungs ?? [
    { atPct: L.trim1Pct, sellQty: L.trim1Qty, stopTo: L.stopAfterTrim1 as number | undefined },
    { atPct: L.trim2Pct, sellQty: L.trim2Qty, stopTo: undefined as number | undefined },
  ];
  // Stop ratchets off the PEAK (never loosens): the highest rung whose level has
  // printed sets the stop. Legacy configs keep their separate breakeven ratchet.
  const stopAt = (high: number, extraTaken?: number) => {
    let s = i.exit.stopLoss;
    rungs.forEach((r) => {
      if (r.stopTo != null && (high >= r.atPct || r.atPct === extraTaken || i.trims.includes(r.atPct))) s = r.stopTo;
    });
    if (L.rungs == null && high >= L.breakevenPct) s = 0;
    return s;
  };
  const stop = stopAt(i.peak);
  const pct = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`;

  let close = "";
  if (i.invalidatedReason) {
    close = i.invalidatedReason;
  } else if (i.ret <= stop) {
    close = stop === 0 ? `breakeven stop after ${pct(i.peak)} peak` : `hit ${pct(stop)} stop (${pct(i.ret)})`;
  } else if (L.runnerTakeProfit != null && i.ret >= L.runnerTakeProfit) {
    close = `take-profit ${pct(i.ret)} (target ${pct(L.runnerTakeProfit)})`;
  } else if (i.nearTargetLevel != null && L.targetProximity > 0) {
    close = `within $${L.targetProximity.toFixed(2)} of next level ${i.nearTargetLevel}${i.spot != null ? ` (${i.spot})` : ""}`;
  } else if (i.timedOutMin != null && L.holdTimeout !== false) {
    close = `no bounce within 2x expected hold (~${Math.round(i.timedOutMin)}min)`;
  } else if (i.eodFlatten) {
    close = `end-of-day flatten (${pct(i.ret)})`;
  }
  if (close) return { stop, close, trim: null };

  // Trims — the FIRST untaken SELLING rung whose level has printed, in order. Always
  // leave at least one contract open (a full exit is a `close`, never a trim).
  // A rung with sellQty 0 is a stop ratchet only (SB 15M's +40% breakeven move): it
  // never sells and never blocks a later rung.
  const planned = L.plannedQty ?? L.trim1Qty + L.trim2Qty + 1;
  const scale = i.entryQty / planned;
  const taken = (n: number) => rungs[n].sellQty <= 0 || i.trims.includes(rungs[n].atPct);
  const idx = rungs.findIndex((r, n) => r.sellQty > 0 && !i.trims.includes(r.atPct) && i.ret >= r.atPct && (n === 0 || taken(n - 1)));
  if (idx < 0 || i.heldQty <= 1) return { stop, close: "", trim: null };
  const qty = Math.min(Math.max(1, Math.round(rungs[idx].sellQty * scale)), i.heldQty - 1);
  return { stop, close: "", trim: { qty, atPct: rungs[idx].atPct, newStop: stopAt(i.peak, rungs[idx].atPct) } };
}

/** One ladder pass for a single position. At most ONE action per call (per quote
 *  update); the next call re-evaluates the new state.
 *  QQQ Manual (owner 2026-07-21): 5 contracts in; -25% base stop; +50% sell 2 and
 *  the stop moves to breakeven; +75% sell 1 and the stop moves to +25% (so a fade
 *  back to +25% sells the rest); +100% sell the final 2; end-of-day flatten.
 *  SB15M keeps its legacy trim1/trim2 config. Tranches scale proportionally when
 *  fewer than the planned contracts filled. */
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
  // Disabled per-profile (QQQ Manual dropped it, owner 2026-07-21).
  const ageMin = (Date.now() - new Date(st.openedAt).getTime()) / 60_000;
  const timedOut = L.holdTimeout !== false && zone?.expectedHoldMin != null && trims.length === 0 && ageMin > 2 * zone.expectedHoldMin;

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

  // ALL the ladder's decision-making lives in the pure planner below (self-tested in
  // scripts/ladder-selftest.ts); everything above just gathers live inputs.
  const plan = ladderPlan({
    exit: profile.exit,
    ret,
    peak,
    trims,
    entryQty: st.entryQty,
    heldQty,
    invalidatedReason: invalidated15m,
    nearTargetLevel: nearTarget && zone?.predictedTarget != null ? zone.predictedTarget : null,
    spot,
    timedOutMin: timedOut ? (zone!.expectedHoldMin as number) : null,
    eodFlatten: !!profile.exit.sameDayExit && nearClose && (occ?.expiry === today || !!profile.exit.forceEodFlatten),
  });
  const closeAll = plan.close;

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
  if (plan.trim) {
    const { qty: trimQty, atPct: trimLevel, newStop } = plan.trim;
    await broker.closePosition(p.symbol, trimQty);
    const trimPatch = { trims: [...trims, trimLevel], peakPct: String(peak), stopStage: newStop >= 0 ? 2 : 1 };
    await db.update(positionState).set(trimPatch).where(eq(positionState.contractSymbol, p.symbol)); // critical — immediate
    mem.posState.set(p.symbol, { ...st, ...trimPatch });
    const sym = occ?.underlying ?? p.symbol;
    const stopWord = newStop === 0 ? "breakeven" : `${newStop > 0 ? "+" : ""}${Math.round(newStop * 100)}%`;
    const d = `trimmed ${trimQty} of ${st.entryQty} at +${Math.round(ret * 100)}% (stop → ${stopWord})`;
    out.push({ symbol: sym, direction: occ?.type ?? "call", candidateId: 0, price: bid, placed: true, detail: `SOLD ${sym} — ${d}`, profileId });
    await sendPush(`${profile.label}: Trimmed ${sym} +${Math.round(ret * 100)}%`, d, "/positions").catch(() => {});
  } else {
    // Persist the high-water mark ONLY when it crosses a ratchet threshold — the
    // stop stage depends solely on peak-vs-thresholds, so intermediate peaks don't
    // change behavior and don't need a write. Crossings persist immediately so the
    // ratchet survives any restart EXACTLY (a mid-band peak lost to a crash can
    // never loosen the stop — stage-at-crossing is already durable).
    const stageOf = (pct: number) =>
      L.rungs ? L.rungs.filter((r) => pct >= r.atPct).length : pct >= L.breakevenPct ? 2 : pct >= L.trim1Pct ? 1 : 0;
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

    // LADDER (QQQ Manual, SB15M): trim tranches at premium milestones with a stop that
    // ratchets on the PEAK gain (never loosens). State (original qty, peak, fired
    // trims) lives in the position_state table so it survives serverless ticks.
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

      // Swing PREMIUM take-profit (SBv2 2026-07-21: sell EVERYTHING at +100% —
      // "the option premium target is the exit"). Unset for SBv1 → unchanged.
      const sTp = profile.exit.swingTakeProfit;
      if (!reason && sTp != null && ret >= sTp) {
        reason = `hit +${Math.round(sTp * 100)}% premium target (${Math.round(ret * 100)}%)`;
      }

      // Optional mid-swing premium stop (SBv2: -25% off the actual fill). Unset for
      // SBv1 → no mid-swing stop, unchanged.
      const sStop = profile.exit.swingStopLoss;
      if (!reason && sStop != null && ret <= sStop) {
        reason = `hit swing stop (${Math.round(ret * 100)}% <= ${Math.round(sStop * 100)}%)`;
      }

      if (!reason) {
        const zone = occ ? await cachedZone(p.symbol) : null;
        if (zone && occ) {
          if (profile.exit.invalidateOn4hClose) {
            // SBv2 (2026-07-21): a COMPLETED 4-hour candle closing back inside the
            // daily zone invalidates the breakout immediately — do not wait for the
            // daily close. No underlying-target exit for this profile (premium rules
            // above are the exits, per spec).
            try {
              const raw4h = await getIntradayBars(occ.underlying, "4Hour", 3 * 24 * 60);
              const done = raw4h.filter((b) => Date.parse(b.t) + 4 * 60 * 60_000 <= Date.now());
              const last4h = done.length ? done[done.length - 1] : null;
              if (last4h && ((zone.direction === "call" && last4h.c < zone.top) || (zone.direction === "put" && last4h.c > zone.bottom))) {
                reason = `breakout invalidated — 4h close ${last4h.c} back inside the zone`;
              }
            } catch {
              /* bars unavailable — the premium stop still protects */
            }
          } else {
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
              } else if (profile.exit.swingTakeProfit == null) {
                // Underlying-target exit (SBv1: persisted DB target, else the playbook
                // safe-target). Profiles with a premium take-profit skip this entirely.
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
    // 15min/1h zones refresh every ~5 min; 4h-driven profiles (SB15M zones, SBv2
    // breakout qualification) refresh HOURLY — 4h state only changes when a 4H
    // bar completes mid-session, so a 5-min cadence would be pure API waste.
    const fast = p.zoneTimeframes.some((z) => z.timeframe === "1h" || z.timeframe === "15min");
    const slow = !fast && (p.zoneTimeframes.some((z) => z.timeframe === "4h") || p.setupKind === "breakout");
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
      // SBv2 (2026-07-21 spec): an ACTUAL touch/penetration of the stored boundary,
      // not proximity. The precheck is a small superset (touch OR within the band)
      // so the full evaluation still runs when the touch lands between ticks.
      const b = (c.setup as { flipped_boundary?: number } | null)?.flipped_boundary ?? (c.direction === "call" ? z.top : z.bottom);
      if (b <= 0) return false;
      const touched = c.direction === "call" ? cur <= b : cur >= b;
      return touched || Math.abs(cur - b) / b <= FLIP_TAP_BAND;
    }
    if (p.manualLevels) {
      // SUPERSET of the real touch test (manualApproach): near the level, or price
      // crossed it since the last tick. Never narrower than the real rule.
      if (!inEntryWindow(p)) return false;
      const lvl = (c.setup as { manual?: { level?: number } } | null)?.manual?.level ?? (z.bottom + z.top) / 2;
      if (lvl <= 0) return false;
      const last = mem.lastPrice.get(c.symbol);
      const crossed = last != null && (last - lvl) * (cur - lvl) <= 0;
      return crossed || Math.abs(cur - lvl) / lvl <= LEVEL_PRECHECK_BAND;
    }
    if (p.entryKind === "empty_space_tap") {
      // SUPERSET of the real touch test: anywhere near the FACING boundary.
      if (!inEntryWindow(p)) return false;
      const b = c.direction === "call" ? z.top : z.bottom;
      return b > 0 && Math.abs(cur - b) / b <= TAP_PRECHECK_BAND;
    }
    if (p.confirmation.enabled) return cur >= z.bottom * 0.99 && cur <= z.top * 1.01;
    return true; // tap-crossing profiles need prev-tick state — must run the loop
  });
  // Remember this tick's prices for the NEXT tick's manual-level crossing precheck
  // (read above, written here — order matters).
  for (const [sym, px] of Object.entries(prices)) if (px != null) mem.lastPrice.set(sym, px);

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

    // QQQ Manual takes ONE trade per session; resolved lazily on the first real touch
    // (null = not looked up yet on this tick).
    let manualDone: boolean | null = null;

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

    // Manual-level profiles OVERRIDE this at touch time (the saved direction is only a
    // provisional label; the live 15-minute approach decides the real one).
    let direction = c.direction as "call" | "put";
    const profile = getProfile(c.profileId);

    // Decide whether this candidate triggers NOW.
    let confirmReason = "";
    let execScore = 0;
    let sniperSummaryExtra = ""; // risk-layer verdict text (SBv2), merged into the alert below
    let manualEntry: { level: number; approach: string; barClose: number; barTime: string } | null = null;
    let emptySpaceEntry: { boundary: number; penetration: number } | null = null;
    if (profile.entryKind === "flip_retest") {
      // SBv2 (2026-07-21 spec): enter on the FIRST actual TOUCH (or slight
      // penetration) of the stored breakout boundary — "do not trigger simply
      // because price is near the level". Call: price at/under the broken top;
      // put: price at/over the broken bottom. Deduped via tappedSet so it fires
      // once per candidate per day even when a touch doesn't produce an order.
      if (tappedSet.has(c.id)) continue; // already touched today
      const boundary = (c.setup as { flipped_boundary?: number } | null)?.flipped_boundary ?? (direction === "call" ? z.top : z.bottom);
      if (boundary <= 0) continue;
      const touched = direction === "call" ? cur <= boundary : cur >= boundary;
      if (!touched) continue;
      // "Checking" audit alert: fires the moment the boundary is touched, for ALL
      // watchlist setups. NOT a command — the buy may still be blocked; a second
      // push reports the outcome. Logging the touch adds this candidate to
      // tappedSet on the next tick so it won't re-fire while price sits there.
      if ((await cachedSettings(c.profileId)).autoExecute) {
        await sendPush(`${profile.label}: ${c.symbol} boundary touch ${cur}`, `${direction.toUpperCase()} — checking…`, "/positions").catch(() => {});
      }
      await logActivity([{ profileId: c.profileId, symbol: c.symbol, kind: "tap", direction, price: cur, candidateId: c.id, detail: `breakout boundary ${boundary} touched at ${cur} — checking ${direction.toUpperCase()}` }]);
      confirmReason = " First retest of the 4H breakout boundary.";
    } else if (profile.entryKind === "empty_space_tap") {
      // SB 15M — 15-minute empty-space zone tap. The zone came from the scan (4H HTF
      // order blocks, ATR 50, displacement 1.3, empty-space/clear-runway gated); the
      // TAP of the boundary facing price is the whole trigger. No confirmation candle,
      // no structure read, no score, no model — per spec. `emptySpaceTap` enforces the
      // do-not-enter cases (gap-through / deep inside / accepted through / stale feed).
      if (tappedSet.has(c.id)) continue; // already fired today (no re-entry without a new setup)
      if (!inEntryWindow(profile)) continue; // 9:45am-2:45pm ET
      const tap = await emptySpaceTap(c.symbol, direction, z, cur);
      if (!tap.ok) {
        // reason null = simply not at the level yet (not worth a log row).
        if (tap.reason) fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: `skipped — ${tap.reason}` });
        continue;
      }
      if ((await cachedSettings(c.profileId)).autoExecute) {
        await sendPush(`${profile.label}: ${c.symbol} zone tap ${cur}`, `${direction.toUpperCase()} at the ${direction === "call" ? "top" : "bottom"} boundary ${tap.boundary} — checking…`, "/positions").catch(() => {});
      }
      await logActivity([
        {
          profileId: c.profileId,
          symbol: c.symbol,
          kind: "tap",
          direction,
          price: cur,
          candidateId: c.id,
          detail: `tapped the ${direction === "call" ? "top" : "bottom"} boundary ${tap.boundary} from ${c.approach?.replace("_", " ") ?? (direction === "call" ? "above" : "below")} at ${cur}`,
          meta: { boundary: tap.boundary, penetration: Math.round(tap.penetration * 100) / 100, approach: c.approach, direction, price: cur, zone: z },
        },
      ]);
      emptySpaceEntry = { boundary: tap.boundary, penetration: tap.penetration };
      confirmReason = ` First touch of the ${direction === "call" ? "TOP boundary of the zone below" : "BOTTOM boundary of the zone above"} (${tap.boundary}) approaching from ${direction === "call" ? "above" : "below"} through empty space.`;
    } else if (profile.manualLevels) {
      // QQQ Manual — PURELY MECHANICAL (owner 2026-07-21). Monitoring runs from the
      // 9:30 open; the FIRST level actually touched takes the session's only trade.
      // A touch = price reaching or CROSSING the owner's level (no wide band), and the
      // direction comes from the prior completed 15-minute bar: approaching from above
      // => CALL, from below => PUT. No confirmation candle, no score, no probability
      // floor, no DB target, no catalyst, no EV filter — those were all removed here.
      if (tappedSet.has(c.id)) continue; // this level already fired today
      if (!inEntryWindow(profile)) continue; // 9:30 open → before the EOD flatten window
      const level = (c.setup as { manual?: { level?: number } } | null)?.manual?.level ?? (z.bottom + z.top) / 2;
      if (level <= 0) continue;
      const touch = await manualApproach(c.symbol, level, cur);
      if (!touch.touched) continue;
      // One trade per session: only a PLACED order consumes the day (a level that
      // couldn't find a contract leaves the rest of the list eligible).
      if (manualDone ?? (manualDone = await enteredToday(c.profileId))) {
        fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: `level ${level} touched — ignored, this session's trade is already taken` });
        continue;
      }
      direction = touch.direction; // decided at TOUCH time, not when the levels were saved
      manualEntry = { level, ...touch };
      if ((await cachedSettings(c.profileId)).autoExecute) {
        await sendPush(`${profile.label}: ${c.symbol} level ${level} touched at ${cur}`, `${touch.approach.replace("_", " ")} → ${direction.toUpperCase()} — checking…`, "/positions").catch(() => {});
      }
      await logActivity([
        {
          profileId: c.profileId,
          symbol: c.symbol,
          kind: "tap",
          direction,
          price: cur,
          candidateId: c.id,
          detail: `level ${level} touched at ${cur} — prior 15m bar ${touch.barTime} closed ${touch.barClose} (${touch.approach.replace("_", " ")}) → ${direction.toUpperCase()}`,
          meta: { level, barClose: touch.barClose, barTime: touch.barTime, approach: touch.approach, direction, price: cur },
        },
      ]);
      confirmReason = ` Level ${level} touched at ${cur}; prior completed 15m bar (${touch.barTime}) closed ${touch.barClose}, i.e. approaching ${touch.approach.replace("_", " ")} → ${direction.toUpperCase()}.`;
    } else if (profile.confirmation.enabled) {
      // Confirmation profiles (SBv1, QQQ 0DTE): fire only when price is AT the zone
      // AND an intraday confirmation candle prints (rejection/engulf/strong close +
      // relative volume) — never on a bare tap.
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

    // Score the setup; only fire if it clears the profile's quality threshold. The
    // mechanical profiles (QQQ Manual, SB 15M) skip this entirely — their entry is the
    // level itself, and a scoring failure must never block a trade already decided.
    const noScoring = profile.manualLevels || profile.entryKind === "empty_space_tap";
    let pb: ReturnType<typeof classifyAndScore> | null = null;
    let bars: Bar[] = [];
    if (!noScoring) {
      try {
        bars = await getStockBars(c.symbol, 400);
        pb = classifyAndScore(bars, z, direction, cur);
      } catch {
        pb = null;
      }
    }

    // SBv2 (2026-07-21 spec) pre-entry guards, in order:
    //  1. scan freshness (a missed nightly scan must not trade ancient candidates);
    //  2. CANCEL if a completed 4h candle has closed back inside the zone since the
    //     qualifying breakout ("if a completed 4-hour candle closes back inside or
    //     below the zone before entry, cancel the setup") — checked live because a
    //     4h candle CAN complete mid-session, unlike the old daily-flip logic;
    //  3. the intel layer in RISK-ONLY mode: session-loss + exposure caps stay as
    //     account protections, but NO market/structure/RS gates (spec removed them).
    if (profile.entryKind === "flip_retest") {
      const scanAgeDays = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${c.runDate}T00:00:00Z`)) / 86_400_000;
      if (scanAgeDays > 3) {
        fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: `breakout scan ${Math.round(scanAgeDays)}d old (missed scan) — skipped` });
        await notifyBlocked(c.profileId, c.symbol, direction, "watchlist scan too old");
        continue;
      }
      const acceptedAt = (c.setup as { accepted_at?: string } | null)?.accepted_at;
      if (acceptedAt) {
        try {
          const raw4h = await getIntradayBars(c.symbol, "4Hour", 4 * 24 * 60);
          const done = raw4h.filter((b) => Date.parse(b.t) + 4 * 60 * 60_000 <= Date.now() && Date.parse(b.t) > Date.parse(acceptedAt));
          const cancelled = done.some((b) => (direction === "call" ? b.c < z.top : b.c > z.bottom));
          if (cancelled) {
            fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: "breakout cancelled — a completed 4h candle closed back inside the zone" });
            await notifyBlocked(c.profileId, c.symbol, direction, "4h candle closed back inside the zone");
            continue;
          }
        } catch {
          /* bars unavailable — execute's live wrong-way check still guards the entry */
        }
      }
      if (intelEnabled(c.profileId)) {
        try {
          const verdict = await evaluateSbv2Intel(c.symbol, direction, { riskOnly: true });
          if (!verdict.allowed) {
            fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: verdict.summary });
            await notifyBlocked(c.profileId, c.symbol, direction, verdict.summary.slice(0, 90));
            continue;
          }
          sniperSummaryExtra = ` ${verdict.summary}`;
        } catch {
          /* risk layer fails OPEN — a data hiccup must not disable the strategy */
        }
      }
    }
    // SBv2 (flip_retest) enters MECHANICALLY on a valid first-retest tap: NO playbook
    // score gate and NO adversarial sniper engine (per sniperbot-daily-swing-v2.md). It
    // keeps only the spec's light gates: a valid DB target (reward/move large enough) +
    // the news-against veto. SBv1/QQQ keep the score gate + sniper engine unchanged.
    const mechanical = profile.entryKind === "flip_retest";
    if (!pb && !noScoring) {
      fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: "could not score; skipped" });
      if (mechanical) await notifyBlocked(c.profileId, c.symbol, direction, "could not read the chart");
      continue;
    }
    // Playbook score gate — skipped for mechanical entries (SBv2 flips per spec) and
    // for the level/tap profiles (QQQ Manual and SB 15M have no score at all: the
    // owner's level, or the zone boundary tap, IS the decision).
    if (pb && !mechanical && !noScoring && pb.score < profile.minScore) {
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

    // Confidence engine (SBv1/QQQ 0DTE/SB15M). Uses the reaction DB for numbers;
    // never lets the model produce a probability/target. SBv2 (2026-07-21 spec) and
    // QQQ Manual are MECHANICAL — no prediction, no news vet, no sniper engine: the
    // setup rule IS the decision, so this whole block is theirs to skip.
    let sniperConfidence = pb ? pb.score / 100 : 0.5;
    let sniperSummary = "";
    if (mechanical) {
      sniperSummary = ` 4H breakout retest — mechanical entry (spec: no confirmation, no news vet, no DB target).${sniperSummaryExtra}`;
    } else if (profile.confirmation.enabled) {
      const marketAlign = ((marketCtx.spy + marketCtx.qqq) / 2) * (direction === "call" ? 1 : -1);
      const pred = await predict(c.symbol, cur, c.timeframe, direction, c.approach ?? "", marketAlign);
      // HARD probability floor (QQQ 0DTE): a ~50% coin flip loses to spread + same-day
      // theta, so below the floor the correct action is NO trade. Only profiles that set
      // minProbability are affected.
      if (profile.minProbability != null && pred.probability < profile.minProbability) {
        fires.push({ symbol: c.symbol, direction, candidateId: c.id, price: cur, placed: false, detail: `skipped — probability ${Math.round(pred.probability)}% < ${profile.minProbability}% floor (coin flip)` });
        continue;
      }
      const isIntraday = profile.exit.style === "intraday"; // 0DTE/day-trade — judge as a same-day scalp
      const ev = evaluateSniper(pb!, bars, direction, execScore, c.clearRunway, marketCtx, pred, isIntraday);
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

    const zoneWord = direction === "call" ? "support" : "resistance";
    const tapBoundary = direction === "call" ? "top" : "bottom"; // call taps top (from above), put taps bottom (from below)
    const tapPrice = direction === "call" ? z.top : z.bottom;
    // QQQ Manual's alert records the auditable facts of the mechanical decision:
    // the level, the prior completed 15-min bar it was judged against, the approach
    // direction, and the resulting call/put. No score, no target — it has neither.
    // SB 15M's alert follows the spec's ALERT FORMAT: every field the owner asked for,
    // in plain text, so a signal can be audited against the chart after the fact.
    const sb15mAlert = () =>
      [
        `${direction.toUpperCase()}S: ${c.symbol} — 15M EMPTY-SPACE ZONE-TAP DAY TRADER.`,
        `Chart 15-minute (HTF for OBs 4 hours, HTF ATR 50, displacement 1.3x ATR).`,
        `Empty space VALID (clear runway in the trade's direction).`,
        `Approach from ${direction === "call" ? "above" : "below"}; zone ${direction === "call" ? "BELOW" : "ABOVE"} price ${z.bottom}-${z.top}.`,
        `Entry boundary ${emptySpaceEntry?.boundary ?? tapPrice} (${tapBoundary} of the zone), stock at ${cur}.`,
        `One weekly contract $1.00-2.00, ATM/slightly ITM.`,
        `Original stop -20% of the fill; at +40% the stop moves to breakeven (hold, do NOT sell); final target +100%; mandatory exit before the close.`,
        `Why: price traded in empty space and tapped the first facing boundary${emptySpaceEntry ? ` (${emptySpaceEntry.penetration >= 0 ? "penetrated" : "reached"} ${Math.abs(emptySpaceEntry.penetration).toFixed(2)})` : ""}.`,
      ].join(" ");
    const alert =
      profile.entryKind === "empty_space_tap"
        ? sb15mAlert()
        : profile.manualLevels && manualEntry
          ? `${direction.toUpperCase()}S: ${c.symbol} — manual level ${manualEntry.level}.${confirmReason} Mechanical entry: 5 same-day contracts at $0.30-0.35, ladder exit (-25% stop; +50% sell 2, stop breakeven; +75% sell 1, stop +25%; +100% sell the rest).`
          : `${direction.toUpperCase()}S: ${c.symbol} — ${pb!.playbook}. ${tapBoundary} zone tapped ${tapPrice} (${zoneWord} zone ${z.bottom}-${z.top}) at ${cur}. Safe target ${pb!.safeTarget ?? "?"}, extended ${pb!.extendedTarget ?? "?"}. Score ${pb!.displayScore}/100.${confirmReason}${sniperSummary}`;
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
          expiryHint: profile.contract.expiryKind === "zeroDte" ? "same_day" : "friday",
          // SniperBot's blended confidence (0-1) for confirmation profiles, else the
          // playbook quality score. Code-computed, NOT a probability of profit.
          confidence: String(sniperConfidence),
          pricedInAssessment: "unclear",
          rationale: `${alert} ${pb?.reason ?? ""}`.trim(),
          plainExplanation: `${
            profile.entryKind === "empty_space_tap"
              ? `${c.symbol} was travelling through empty space and just touched the first zone boundary facing it (${emptySpaceEntry?.boundary ?? tapPrice})`
              : profile.manualLevels && manualEntry
              ? `QQQ came ${manualEntry.approach.replace("_", " ")} into your ${manualEntry.level} level and touched it`
              : profile.entryKind === "flip_retest"
                ? `${c.symbol} broke out of a daily order block on the 4-hour chart and just came back to retest the broken boundary`
                : `${c.symbol} just tapped its zone live (${pb!.playbook})`
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
          if (profile.manualLevels) manualDone = true; // this session's single trade is taken (same-tick guard)
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
          if (profile.entryKind === "flip_retest" || profile.entryKind === "empty_space_tap" || profile.manualLevels)
            await notifyBlocked(c.profileId, c.symbol, direction, friendlyBlock(why));
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
