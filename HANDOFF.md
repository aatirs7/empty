# Vega — Project Handoff

_Last updated: 2026-07-07_

## Zone strategy + measurement (I-series, current focus)
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
