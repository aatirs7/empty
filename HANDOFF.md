# Vega — Project Handoff

_Last updated: 2026-07-21_

## Current state (READ FIRST)

Vega is a **strategy PROFILE system**: four live strategy tracks, each with its own paper account, entry logic, exits, log/P&L/scorecard/shadow track and UI tab — never blended. The live minute-cron **monitor** (`src/lib/monitor.ts`, Vercel `/api/monitor`) is the SOLE trading path; the Claude research runs are display-only. `CLAUDE.md`'s build status is the milestone-by-milestone log; **`docs/strategies/{sbv1,sbv2,qqq-manual,sb15m}.md` are LIVING per-profile docs that state every gate/number exactly as coded — update them in the same commit as any strategy change.**

| Profile (tab) | Strategy (one line) | Account | Auto |
|---|---|---|---|
| `sbv2` (SBv2) | **4H Empty-Space Breakout & Retest** (2026-07-21, replaced the daily-flip logic): completed 4h candle closes out of a DAILY zone into empty space → buy the FIRST touch of the broken boundary, no confirmation/news/model/score; weekly $1.00-1.50 ATM-ish, 1 contract; exits +100% TP / −25% stop / 4h close-back-inside. Risk-only intel (3 losses/day, 2 same-direction, 2 per sector). | `ALPACA_*_3` | owner toggle |
| `sniper_swing` (SBv1) | Original SniperBot: daily zone tap + 5-min confirmation candle + score ≥75 + reaction-DB prediction + sniper engine + catalyst check; EV-picked weekly $0.40-1.00; exits DB-target/invalidation/catastrophe/salvage (NO mid-swing stop). | default keys (PA33FAVNIVA2) | ON |
| `qqq_manual` (QQQ Manual) | **Purely mechanical** (2026-07-21): owner-entered levels; from the 9:30 open the FIRST level actually touched takes the session's ONE trade; direction from the prior completed 15-min bar (falling in = CALL, rising in = PUT); exactly 5 same-day contracts $0.30-0.35; rung ladder −25% / +50% sell 2→BE / +75% sell 1→+25% / +100% sell rest; EOD flatten. No floor/target/news/EV/score — all removed. | `ALPACA_*_2` | editor toggle |
| `sb15m` (SB 15M) | **15-minute empty-space zone tap** (2026-07-21 spec v2): 4H-HTF order blocks on the 15-min chart; first facing-boundary tap out of empty space IS the trigger (no confirmation), with gap-through/deep-inside/accepted-through/stale-feed guards; ONE weekly $1.00-2.00 ATM/slightly-ITM contract; stop −20% → breakeven at +40% (no sell) → all out at +100%; EOD flatten, 9:45-14:45 ET entries. | `ALPACA_*_4` (unset ⇒ shadow-only) | OFF (paper-measure first) |

Shelved (code-level no-trade/no-manage, no tabs): `qqq_0dte`, `sbv3`, `zones_legacy`.

Shared machinery:
- **Zones** (`zones.ts`): Pine-port order blocks (Wilder ATR-50; displacement 1.7× daily, 1.3× 4H), pure `(bars, opts) → zones`. **Setups** (`strategy.ts`): stateless facing-boundary rule (price above → top boundary → call; below → bottom → put), white-space gate; `buildBreakoutSetupsDetailed` (SBv2, `breakout.ts`) qualifies off completed 4h candles with a full rejection funnel. `flips.ts` = the RETIRED SBv2 flip logic (kept, unused).
- **Reaction DB** (`reactions` table, ~390k rows incl. intraday): `queryReactions` (tiered widening, N=20 honesty, optional `asOf` for backtests) → `predict.ts`. Used by SBv1 only these days — SBv2/QQQ Manual/SB 15M are deliberately model- and DB-free at entry.
- **Per-profile accounts**: `getBroker(profileId)` binds keys via `AsyncLocalStorage` and asserts paper; profiles without their own keys are HARD-GATED from auto-buy/manage (read-only fallback). **Caps enforced in `executeProposal`**: per-order, open-position, 3 trades/day, `exactContracts` lots.
- **DB-traffic diet**: `/api/monitor` exits before any DB touch outside 9:25-16:05 ET; in-session caches + trigger-first precheck; trades/fills/exits/taps write immediately, only skip-rows batch.
- **Measurement**: shadow tracks + per-profile scorecard + 16:10 ET daily report; per-account API-cost ledger; WhatsNew modal announces every ship.

## Backtesting suite (`src/lib/backtest/`, `/backtest` UI, 2026-07-20/21)

Point-in-time replay with ZERO lookahead: `PointInTimeData` owns `asOf`, strategy code gets a narrowed `StrategyView` (no today/future bars), `queryReactions` filters at the source, monotonic clock; ~33-assertion selftest (`npm run backtest:selftest`) covers deliberate future reads, zone-formation timing, determinism, isolation. Separate `backtest_runs/signals/trades` tables; never touches live trade tables; Claude gates stubbed FAIL-OPEN + labeled; every report prints assumptions + honest limitations.
- **Stage 1** (daily signal replay: hit rate, probability calibration, MAE, random-entry + SPY baselines) + **Stage 2** (options P&L on REAL historical option bars — Alpaca serves expired contracts; NBBO history absent so the spread is MODELED, visible config; portfolio sim with live caps; 1.5×/2× spread sensitivity). SBv1 supported (EV picker approximated by price band, labeled).
- **Intraday engine** (`intraday.ts`): completed-15m-candle replay + ladder sim vs real 15-minute option bars (SB 15M).
- **Guards:** `sbv2` runs are REFUSED (runs #1/#3/#6 measured the retired flip logic; a 4h breakout replay is a follow-up); `qqq_manual` refused (owner levels have no historical record — testing them would be lookahead).
- **Results so far (Apr-Jul 2026, one strong-uptrend regime):** every strategy lost at options level while SPY made +13.8% — SBv2-flip −$1.1k (74% died at the stop; probability calibration FLAT ≈ random), SBv1 −$752 (no stop → 18/38 bled 75-100%), old SB 15M −$81 on 14 fills (ATM-near-$1 band unfillable on $200+ names). Recurring lesson: market-aligned entries measurably outperform opposed ones.

## Historical note (I-series origin)
The original single zone strategy (Pine indicator port, STRATEGY.md/SNIPERBOT-RULES.md) grew into the profile system above. `broker.ts` remains the single execution choke point — **no live-trading path exists** (guardrail #1). The old GitHub-Actions research/scan/shadow workflows are inert; scheduling is Vercel crons (scan 00:00 ET, vet 00:30, levels reminder 8:45, shadow 11:00, report 16:10, monitor every minute).

> Paste this file (or point a chat at it) to bring anyone fully up to speed on Vega's architecture, features, guardrails, and current state. **Keep it updated on every architecture/feature change.**

## What Vega is
A personal, mobile-first PWA that every weekday morning ("Operation Vega") researches pre-market news with Claude, proposes options trades as structured JSON, and lets the owner (a self-described layman, not a trader) approve/reject them from their phone. It can also run on autopilot toward a weekly profit goal. **PAPER TRADING ONLY** — there is no live-trading code path anywhere. Learning instrument, not a money machine. None of it is financial advice.

## Non-negotiable guardrails (never violate)
1. Paper only. `ALPACA_BASE_URL` is pinned to the paper endpoint; `tradingBase()` throws on anything else.
2. `TRADING_MODE` must equal `paper`; execute + close + manage re-assert this and hard-refuse otherwise.
3. Human-in-the-loop is the default. Auto-buy and auto-manage are OFF by default, paper-only, and bounded by caps.
4. Position caps (server-side): per-order contracts bounded by `MAX_CONTRACTS_PER_ORDER` (hard ceiling 20) and Settings `maxContracts` (default 5); max 3 open positions (`MAX_OPEN_POSITIONS`).
5. The Brain never sees or invents option prices. It emits strike/expiry HINTS only; a separate step resolves real contracts off the live Alpaca chain. All money math is code-computed, never model-generated.

## Stack
Next.js 16 (App Router, Turbopack) + TypeScript + Tailwind v4. Neon Postgres + Drizzle ORM. Anthropic API (`claude-sonnet-5`, `web_search_20260209`). Alpaca paper API. Vercel (app + APIs). GitHub Actions cron (research + management scripts). PWA installable. Single-password auth (HMAC cookie via Next `proxy.ts`). All source under `src/` (`@/*` -> `./src/*`).

## Data model (src/db/schema.ts)
- `watchlist` — symbols to research (active toggle).
- `research_runs` — one per Operation Vega run (market_context, tokens, searchCount, costEstimate, rawResponse).
- `proposals` — trade ideas (direction, strategy, strikeHint, expiryHint, confidence, pricedInAssessment, rationale, plain_explanation, sources[], status).
- `orders` — placed paper orders (contractSymbol, qty, limitPrice, executionMode manual|auto, code-computed maxLoss/breakeven/scenarios).
- `positions_snapshots` — periodic P&L snapshots.
- `settings` — single row: autoExecute, autoMinConfidence, maxAutoTradesPerDay, autoManage, weeklyGoal, riskTolerance, perTradeBudget, maxContracts, maxContractPrice.
- `proposals` also carry: `variant` (news_only | news_plus_zones), `zoneSetup` (jsonb, code-computed), `zoneRead` (model one-liner).
- `universe` — scanner symbol list (~200). `candidates` — nightly scan output (zone, direction, clearRunway, distanceToEdgePct, setupValid, full setup jsonb). `shadow_outcomes` — mechanical shadow per proposal + SPY baseline (entry/mark/exit premiums, returnPct, win, exitReason).

## Key files
- `src/lib/anthropic.ts` — the Brain (system prompt, web search, zod validation, cost logging). `MAX_WEB_SEARCHES` default 8 (keeps cost ~$0.8/run by avoiding pause_turn re-sends).
- `src/lib/resolve.ts` — hint -> concrete contract. Cheap-OTM targeting: scans near-ATM->OTM strikes, picks the priciest one still under `maxContractPrice`; falls back to the strike hint.
- `src/lib/execute.ts` — `executeProposal(id, mode)`. All guardrails inside. Budget sizing: qty = clamp(floor(perTradeBudget / (price*100)), 1, maxContracts). Resolve -> place -> fill -> risk -> persist.
- `src/lib/manage.ts` — `autoManagePositions()`. Goal-driven exits: take-profit / stop-loss / near-expiry per riskTolerance; locks in gains once weekly goal hit.
- `src/lib/risk.ts` — pure risk math (maxLoss, breakeven, scenarios).
- `src/lib/run-vega.ts` — runAndPersist() + maybeAutoExecute() (goal-aware) + autoManage.
- `src/lib/alpaca.ts` — paper-pinned broker client (account, chain, quotes, orders, positions, portfolio history, weekly P&L, stock bars).
- `src/proxy.ts` — password auth gate.

## Risk tolerance thresholds (manage.ts)
- conservative: take-profit +30%, stop-loss -25%, close <=3 days to expiry.
- balanced: +50% / -40% / <=2 days.
- aggressive: +100% / -60% / <=1 day.

## Screens
- Today — plain summary, goal bar, market mood, proposal cards (plain verdict, explanation, confidence), Skip/Approve.
- Positions — total P&L, per-position cards (company name, recommendation, tap-through to detail w/ chart), Close. Opening this screen also runs auto-manage (no-op if off).
- Log — past runs, expandable, "Full breakdown" -> Operation Vega page.
- Operation Vega (/operation-vega/[id]) — per-stock research breakdown: verdict, reasoning, confidence, source hostnames read.
- P&L — total account balance card (equity/cash/in-trades/buying power/today), goal bar, net (trade P&L minus API cost).
- Proposal explainer (/proposal/[id]) — plain English, why Vega picked it, live dollars-at-risk (from /preview), honest downside.
- Settings — weekly goal, risk tolerance, auto-manage toggle, position sizing (budget / max contract price / max contracts), auto-buy toggle + params, watchlist editor, theme, sign out, "auto is ON" banner + kill switch.

## APIs
/api/login, /api/logout, /api/account, /api/goal, /api/manage (POST), /api/settings (GET/POST), /api/watchlist (GET/POST) + /api/watchlist/[id] (PATCH/DELETE), /api/positions, /api/positions/[symbol]/close, /api/proposals/[id]/approve|reject|preview.

## Env vars
DATABASE_URL, ANTHROPIC_API_KEY, RESEARCH_MODEL=claude-sonnet-5, ALPACA_API_KEY_ID, ALPACA_API_SECRET_KEY, ALPACA_BASE_URL=https://paper-api.alpaca.markets, ALPACA_DATA_URL=https://data.alpaca.markets, APP_PASSWORD, AUTH_SECRET, TRADING_MODE=paper, MAX_CONTRACTS_PER_ORDER=20, MAX_OPEN_POSITIONS=3, MAX_WEB_SEARCHES=8. Never commit .env.

## Workflows (GitHub Actions)
- operation-vega.yml — pre-market news research (+ auto-buy/manage when enabled).
- manage.yml — every 30 min market hours; auto-manage (no-op unless enabled).
- scanner.yml — after close (22:00 UTC); nightly zone scan -> candidates.
- vega-zones.yml — pre-market (13:15 UTC); researches the latest scan's valid zone setups.
- shadow.yml — 3x/day market hours; shadow-outcome tracker for the scorecard.

## Scripts
`npm run`: vega (news), vega:zones (zone research), scan, seed:universe, zones-check, zone-demo, manage, shadow, scorecard, smoke, inspect, seed.

## Current state (2026-07-07)
- M1–M6 + I1–I5 complete and deployed. Running the **$500 paper account "vega" (PA34D7UCJ09S)**.
- Zone strategy (I1–I3), broker abstraction (I4, paper-only), paper-month scorecard (I5) all built and verified end-to-end.
- **Zone math NOT yet confirmed against Farrukh's TradingView** — verify zone bounds/density (NVDA ~17 zones full-history split-adjusted) and retune displacement/ATR if off.
- With full history + stateless edge model, a scan yields ~120 candidates / ~40 valid setups/day. OPEN DECISION before arming: 40 setups/day is a lot to research via the Brain (cost) — decide whether vega-zones researches all, caps to top-N, or shadows-only measure. Shadow tracker handles all 40 fine.
- **PAPER MONTH ARMED (config frozen 2026-07-07) — REAL-TEST, CAPS OFF.** AUTO-TRADING the $500 paper account off zone setups: auto-buy the top-25 valid setups by distance (cheap OTM ≤$2.50) until buying power runs out; trading caps (per-day / positions / contracts) removed — the $500 is the only limiter. auto-manage exits ZONE positions on a daily close-through (structural) + near-expiry. The PAPER-ONLY guardrail is KEPT (paper URL / assertPaper / no live path). `/strategy` explains the strategy in plain English. Shadow tracker runs on ALL valid setups; `/scorecard` reads shadows-vs-SPY ONLY. DO NOT change config/universe/rules mid-month — see memory `vega-paper-month-armed`.
- After the month: read `/scorecard`, then decide on I6 (live monitor) / I7 (live enablement) — both gated + NOT built.
- Position sizing tuned for a small account: cheap OTM contracts (< maxContractPrice), buy multiple to fit perTradeBudget.

## Conventions
Mobile-first, calm decision surface. Plain English for a layman; downside gets equal billing with upside. No em dashes in UI copy (stripDash sanitizes model text). All dollar figures code-computed.

## Update 2026-07-13 — SBv2 parallel strategy (see CLAUDE.md build status for the authoritative, current architecture; this HANDOFF's "Current state" above is pre-S/Q-series and stale)
The single strategy became a PROFILE registry (`src/lib/profiles.ts`): SBv1 (`sniper_swing`, main, auto ON), SBv2 (`sbv2`, NEW, auto OFF), QQQ 0DTE (`qqq_0dte`, own account, auto ON), zones_legacy (shelved). Each profile trades its OWN paper account (`broker.accountKeysFor`: SBv1=default, QQQ=`ALPACA_*_2`, SBv2=`ALPACA_*_3`); P&L/log/shadow/scorecard never blend.
- **SBv2** = daily Order-Block FLIP + FIRST retest (Farrukh's `sniperbot-daily-swing-v2.md` reset). New `src/lib/flips.ts` (`detectFlips`) + `buildFlipSetups` (strategy.ts); scanner/monitor branch on `Profile.setupKind`/`entryKind`. No new DB table — flip state re-derived from settled daily bars each scan. Contract via the horizon-matched `selectByEV`. Auto OFF until `npm run profile-auto -- sbv2 on`.
- Env add: `ALPACA_API_KEY_ID3` / `ALPACA_API_SECRET_KEY3` (SBv2's paper account).
- New scripts: `npm run profile-auto [-- <profile> on|off|buy-only]` (per-profile auto toggle; there is no UI toggle).

## Update 2026-07-15 — Jul-14 audit fixes (CLAUDE.md "Jul-14 audit fixes" is the authoritative detail)
- **Catalyst cache**: `checkCatalyst` results now cached ONE per symbol/profile/day as a `kind:"catalyst"` activity_log row (meta jsonb) — uncached repeats on the minute loop burned ~65 QQQ web-search calls on 7/13 and drained the Anthropic credits. The "QQQ never calls this" comment was wrong: the shared SBv1/QQQ confirmation branch calls it.
- **`/api/vet-flips` unblocked**: it was missing from the middleware `PUBLIC` list, so the password gate 401'd Vercel's cron and NO flip was ever news-vetted. Fixed. NOTE: `CRON_SECRET` IS set on Vercel prod (sensitive-marked, so `vercel env pull` omits it).
- **`syncPendingBuyFills`** (monitor.ts, every tick, before `reconcileClosedPositions`): records limit-buy fills that land after execute's short fill-wait (a fill 13 min late previously left the order `status=new`/`filledPrice=null` forever).
- **Vet resilience**: web-search latency is VOLATILE (33-70s on 7/13; 150s+ solo on the night of 7/15, model-independent). Vet budget now 12 nearest × 120s (2 waves in the 300s route); `maxRetries 4` (bounded by the abort deadline); re-triggering `/api/vet-flips` RETRIES failed-open (`checked=false`) rows instead of skipping them.
- **OPEN (owner decision pending)**: SBv2 contract selection skips ~all expensive names — "$0.15-0.60 + reachable strike + next-week expiry" only coexists on cheap underlyings (21/22 taps skipped on 7/14; only F traded). Options on the table: scale the price cap with the underlying / cheap-names-only as-is / (rejected) drop reachability.
