# Vega — Project Handoff

_Last updated: 2026-07-20_

## Backtesting engine (Stage 1, 2026-07-20)
`src/lib/backtest/{clock,data,random,outcomes,engine,report}.ts` + `scripts/backtest.ts` + `scripts/backtest-selftest.ts` + tables `backtest_runs`/`backtest_signals`/`backtest_trades`. Point-in-time replay of SBv1/SBv2 with ZERO lookahead: `PointInTimeData` owns an `asOf`, strategy code gets a narrowed `StrategyView` (no today/future bars), `queryReactions` filters `asOf` at the source, and a 19-assertion self-test (deliberate future read, zone-formation timing, determinism, isolation) guards it. Reuses the live setup/gate code unchanged (`buildZoneSetups`/`buildFlipSetupsDetailed`/`classifyAndScore`/`evaluateSniper`/`predict`); Claude gates stubbed fail-open + labeled. Stage 1 = underlying-signal metrics (hit rate, probability calibration, MAE, random-entry + SPY baselines); **Stage 2 (options P&L) is gated on a Stage 1 review**. CLI: `npm run backtest -- --profile SBv2 --from ... --to ... --stage 1`. UI: `/backtest` (runs list) + `/backtest/[id]` (full report incl. honest-limitations footer), linked from P&L and Settings. Backtests never touch live trade tables.

## Current state (S-series + Q-series — READ FIRST)
The single zone strategy below (I-series) became a **strategy PROFILE system**. See `CLAUDE.md` build status for the authoritative, milestone-by-milestone log; the essentials:
- **Profiles** (`src/lib/profiles.ts`): `sniper_swing` (main, auto ON), `qqq_0dte` (auto ON, 0DTE EV-selected), `zones_legacy` (shelved, shadow-only, **hidden from the UI**). Each profile drives its own universe/zone-timeframes/confirmation/score/contract/caps/exit. `profile_settings` table = per-profile auto toggles. `profileId` tags candidates/proposals/shadow_outcomes/universe.
- **Per-profile ACCOUNTS**: each strategy trades its own $1000 paper account. `alpaca.ts` uses `AsyncLocalStorage` (`withAccount`); `getBroker(profileId)` binds keys (qqq_0dte → `ALPACA_*_2`, else default) and asserts paper. SniperBot = PA33FAVNIVA2; QQQ = PA3CHVMZRNSL. Positions/close/account/manage/P&L all route by `?profile=`.
- **Historical-reaction DB** (`reactions` table, `src/lib/reactions.ts`): 236k backfilled per-tap reactions (daily+4H, 130 symbols). `queryReactions` matches a setup with tiered bucket-widening + N=20 min-sample honesty + always returns sample size. Powers `predict.ts` (bias/probability/expected-move/targets) and SniperBot's numbers. `ev.ts selectByEV` ranks option contracts by expected value (greeks via `getOptionSnapshots`, free indicative feed).
- **The live monitor is the sole trading path** (research runs are display-only): fires on a confirmation-gated boundary-tap crossing (SIP 5-min), per-profile auto gating. `DATA_FEED=sip` (paid).
- **UI**: shared `ProfileTabs` switcher (SniperBot/QQQ) on every main page. SniperBot `candidate.score` is a UI-only non-saturating `displayScore`; the live auto-buy gate still uses the original `pb.score` in `monitor.ts` (do not conflate them).

## Zone strategy + measurement (I-series — now generalized into profiles above)
Vega now has a real, testable strategy on top of the news engine: **Farrukh's order-block "zone" strategy** (ported from a TradingView Pine indicator; see `STRATEGY.md`). Highest-weight signal, above news.
- **zones.ts** — daily order-block detection (Wilder ATR-50, 1.7x displacement, first-touch, 30/side FIFO).
- **strategy.ts** — `buildZoneSetup`: STATELESS edge-based model. Direction = which side price is on relative to the tapped edge (above => call, below => put), so the flip-on-close-through is automatic. `trigger_edge='first_touch'` + `tapped_edge` exposed; demand/supply labels never drive direction. White-space hard gate. Zones use FULL history + split-adjusted bars.
- **scanner.ts** — nightly scan over a ~200-name `universe` -> `candidates` table for the next session.
- Brain integration: valid zone setups feed the Brain as the driver (direction fixed by the setup, news is confirm/caution), proposals carry `variant`, code-computed `zoneSetup`, and a model `zoneRead`.
- **broker.ts** — `BrokerAdapter`/`AlpacaBroker` (paper-only) is the single execution choke point; a future live adapter plugs in here. **No live path exists** (guardrail #1 holds).
- **shadow.ts + scorecard.ts** — paper-month measurement: every real-trade proposal gets a mechanical shadow (enter ask, mark bid, exit +50%/-40%/expiry) + a daily SPY baseline; `/scorecard` + `npm run scorecard` compute the go/no-go metrics.
- Live monitor (I6) + live enablement (I7) are **gated behind the paper month** and NOT built.

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
