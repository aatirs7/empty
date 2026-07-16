/**
 * Scan-time news/catalyst vetting for FLIP profiles (SBv2). PAPER/analysis.
 *
 * The flip news-context read (scheduled earnings/Fed + "is there fresh news pushing
 * AGAINST this accepted breakout?") is a ~40s web-search Claude call. Running it on
 * the every-minute monitor tick blew the 60s budget when several names tapped at once,
 * so it lives HERE instead: after the nightly scan, we vet the day's valid flips
 * (bounded + concurrent) and stash the verdict in the candidate's `setup.news` jsonb.
 * The monitor then reads that verdict at tap time with ZERO latency and zero Claude
 * calls, and blocks a trade on a scheduled catalyst or news-against.
 *
 * GUARDRAIL: the verdict is a yes/no gate only — it never produces a number/target.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { candidates } from "../db/schema";
import { checkCatalyst } from "./catalyst";
import { activeProfiles, type Profile } from "./profiles";

export interface FlipNews {
  catalyst: boolean; // scheduled earnings / Fed within the window
  event: string;
  newsAgainst: boolean; // fresh news contradicts the accepted breakout
  newsFor: boolean;
  summary: string;
  checked: boolean; // whether the Claude call actually completed (fails open if false)
  checkedAt: string; // ISO timestamp
}

export interface VetResult {
  profileId: string;
  candidates: number;
  vetted: number;
  blocked: number; // catalyst OR newsAgainst
  failedOpen: number; // Claude call didn't complete (traded through)
}

// Bounded so the whole job fits a 300s serverless window: at most LIMIT flips, CONC
// at a time, each capped at PER_CALL_MS. LIMIT/CONC waves × PER_CALL_MS ≈ budget.
// Web-search latency varies WILDLY: ~33-70s measured 2026-07-13, but 150s+ (solo!)
// on the night of 2026-07-15 — model-independent (Haiku stalled the same), so the
// tool itself degrades at times. 12 nearest / 6 conc / 120s = 2 waves ≈ 240s: fewer
// names than before but each call gets real headroom. Failed-open (checked=false)
// rows are RETRIED on any later manual /api/vet-flips trigger; an un-vetted flip has
// no verdict → the monitor fails open (trades) on it.
const LIMIT = 12;
const CONC = 6;
const PER_CALL_MS = 120_000;

export async function vetFlipProfile(
  profile: Profile,
  runDate: string,
  // Shared across profiles within one vet run: SBv3 is (for now) an SBv2 clone with
  // identical candidates, and the news read is symbol+direction-level — re-buying the
  // same verdict for each clone would double the spend for nothing.
  verdictCache: Map<string, FlipNews> = new Map(),
): Promise<VetResult> {
  const rows = await db
    .select()
    .from(candidates)
    .where(and(eq(candidates.profileId, profile.id), eq(candidates.runDate, runDate), eq(candidates.setupValid, true)));

  // Nearest-to-retest first (most likely to actually trade). Skip rows whose vet
  // COMPLETED (checked=true) so a re-run is cheap/idempotent — but DO retry rows that
  // failed open (rate-limit 429s / timeouts), so manually re-triggering /api/vet-flips
  // fills in the gaps instead of skipping them.
  const todo = rows
    .filter((r) => (r.direction === "call" || r.direction === "put") && (r.setup as { news?: FlipNews } | null)?.news?.checked !== true)
    .sort((a, b) => Number(a.distanceToEdgePct ?? 999) - Number(b.distanceToEdgePct ?? 999))
    .slice(0, LIMIT);

  let vetted = 0;
  let blocked = 0;
  let failedOpen = 0;
  const checkedAt = new Date().toISOString();

  for (let i = 0; i < todo.length; i += CONC) {
    const chunk = todo.slice(i, i + CONC);
    await Promise.all(
      chunk.map(async (r) => {
        const direction = r.direction as "call" | "put";
        const cacheKey = `${r.symbol}:${direction}`;
        let news = verdictCache.get(cacheKey);
        if (!news || !news.checked) {
          const cat = await checkCatalyst(r.symbol, 5, profile.id, { direction, timeoutMs: PER_CALL_MS });
          news = {
            catalyst: cat.catalyst,
            event: cat.event,
            newsAgainst: !!cat.newsAgainst,
            newsFor: !!cat.newsFor,
            summary: cat.newsSummary ?? "",
            checked: cat.checked,
            checkedAt,
          };
          if (news.checked) verdictCache.set(cacheKey, news);
        }
        const setup = { ...((r.setup as object | null) ?? {}), news };
        try {
          await db.update(candidates).set({ setup }).where(eq(candidates.id, r.id));
        } catch {
          /* best effort — a failed store just means the monitor fails open on this one */
        }
        vetted++;
        if (news.catalyst || news.newsAgainst) blocked++;
        if (!news.checked) failedOpen++;
      }),
    );
  }

  return { profileId: profile.id, candidates: rows.length, vetted, blocked, failedOpen };
}

export async function vetFlips(runDate = new Date().toISOString().slice(0, 10)): Promise<VetResult[]> {
  const results: VetResult[] = [];
  const verdictCache = new Map<string, FlipNews>(); // shared: clones reuse verdicts
  for (const p of activeProfiles()) {
    if (p.setupKind !== "flip" || p.shelved) continue; // flip profiles only, and not shelved (sbv3)
    results.push(await vetFlipProfile(p, runDate, verdictCache));
  }
  return results;
}
