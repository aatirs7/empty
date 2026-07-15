import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { candidates } from "@/db/schema";
import { getUnderlyingPrice } from "@/lib/alpaca";
import { getProfileSettings, setProfileAuto } from "@/lib/profile-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// QQQ Manual (experimental): the owner hand-enters 5m/15m/1h QQQ levels each morning
// and this route turns them into today's qqq_manual candidates. The live monitor then
// treats them exactly like scanned zones: entry requires a 5-MIN CONFIRMATION CANDLE
// at the level (never a bare touch), then the 60% probability floor, EV net of
// spread+theta, and all caps. Session-cookie protected (NOT in the middleware PUBLIC
// list — owner-only). PAPER only, like everything else.

const PROFILE_ID = "qqq_manual";
const SYMBOL = "QQQ";
// Synthetic zone half-width around a manual level (±0.15%): the machinery expects a
// zone with real height (playbook scoring, at-zone band, wrong-way check).
const HALF_BAND = 0.0015;

interface LevelInput {
  tf: "5m" | "15m" | "1h";
  price: number;
}

/** Reaction-DB bucket for a manual level's chart timeframe. The DB has 15min + 1h
 *  intraday reactions; 5m levels borrow the 15min bucket (nearest sampled). */
function dbTimeframe(tf: LevelInput["tf"]): "15min" | "1h" {
  return tf === "1h" ? "1h" : "15min";
}

export async function GET() {
  const runDate = new Date().toISOString().slice(0, 10);
  const rows = await db
    .select()
    .from(candidates)
    .where(and(eq(candidates.runDate, runDate), eq(candidates.profileId, PROFILE_ID)));
  const settings = await getProfileSettings(PROFILE_ID);
  return NextResponse.json({
    ok: true,
    auto: settings.autoExecute,
    // Trades the QQQ paper account (ALPACA_*_2, handed over from the paused qqq_0dte).
    hasOwnAccount: !!process.env.ALPACA_API_KEY_ID2?.trim(),
    levels: rows.map((r) => {
      const manual = (r.setup as { manual?: { tf?: string; level?: number; enteredAt?: string } } | null)?.manual;
      return {
        id: r.id,
        tf: manual?.tf ?? r.timeframe,
        level: manual?.level ?? null,
        direction: r.direction,
        distancePct: r.distanceToEdgePct != null ? Number(r.distanceToEdgePct) : null,
        enteredAt: manual?.enteredAt ?? null,
      };
    }),
  });
}

export async function POST(req: Request) {
  let body: { levels?: LevelInput[]; auto?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }

  // Auto-mode toggle (PAPER auto-buy + auto-manage for this profile only). A
  // toggle-only POST must NOT touch the day's levels — levels are replaced only
  // when a `levels` array is actually sent.
  if (typeof body.auto === "boolean") {
    await setProfileAuto(PROFILE_ID, { autoExecute: body.auto, autoManage: body.auto });
    if (!Array.isArray(body.levels)) {
      return NextResponse.json({ ok: true, auto: body.auto, hasOwnAccount: !!process.env.ALPACA_API_KEY_ID2?.trim() });
    }
  }
  if (!Array.isArray(body.levels)) {
    return NextResponse.json({ ok: false, error: "nothing to save" }, { status: 400 });
  }

  const levels = (body.levels ?? []).filter(
    (l): l is LevelInput => (l?.tf === "5m" || l?.tf === "15m" || l?.tf === "1h") && Number.isFinite(l?.price) && l.price > 0,
  );
  if (levels.length > 24) {
    return NextResponse.json({ ok: false, error: "too many levels (max 24)" }, { status: 400 });
  }

  let spot: number;
  try {
    spot = await getUnderlyingPrice(SYMBOL);
  } catch {
    return NextResponse.json({ ok: false, error: "QQQ quote unavailable — try again in a moment" }, { status: 502 });
  }

  const runDate = new Date().toISOString().slice(0, 10);
  const enteredAt = new Date().toISOString();
  const rows = levels.map((l) => {
    // Direction from where price sits NOW (same stateless-edge rule as the zones):
    // level below spot = support, buy the CALL on a confirmed retest from above;
    // level above spot = resistance, buy the PUT on a confirmed rise into it.
    const direction = l.price < spot ? "call" : "put";
    const approach = direction === "call" ? "from_above" : "from_below";
    const zone = {
      bottom: Math.round(l.price * (1 - HALF_BAND) * 100) / 100,
      top: Math.round(l.price * (1 + HALF_BAND) * 100) / 100,
    };
    const distance = Math.round((Math.abs(spot - l.price) / spot) * 10000) / 100;
    return {
      runDate,
      symbol: SYMBOL,
      direction,
      approach,
      clearRunway: false, // profile has requireClearRunway=false; informational only
      distanceToEdgePct: String(distance),
      setupValid: true,
      price: String(spot),
      zone,
      // Shaped like a ZoneSetup where it matters (execute.ts reads active_zone for the
      // live wrong-way check); `manual` carries the owner's original input for display.
      setup: {
        setup_valid: true,
        active_zone: zone,
        direction,
        approach,
        distance_to_edge_pct: distance,
        price: spot,
        manual: { tf: l.tf, level: l.price, enteredAt },
      },
      score: null,
      playbook: "Manual Level",
      profileId: PROFILE_ID,
      timeframe: dbTimeframe(l.tf),
    };
  });

  // Replace today's manual candidates wholesale (idempotent save). NOTE: a re-save
  // creates fresh candidate ids, so a level that already traded today could re-fire
  // if re-entered — save the day's levels once in the morning, per the owner's flow.
  await db.delete(candidates).where(and(eq(candidates.runDate, runDate), eq(candidates.profileId, PROFILE_ID)));
  if (rows.length) await db.insert(candidates).values(rows);

  return NextResponse.json({
    ok: true,
    saved: rows.length,
    spot,
    levels: rows.map((r) => ({ tf: (r.setup.manual as { tf: string }).tf, level: (r.setup.manual as { level: number }).level, direction: r.direction })),
  });
}
