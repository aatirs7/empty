# Vega — Project Handoff

_Last updated: 2026-07-06_

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
- operation-vega.yml — dual-cron (12:30/13:30 UTC) with an ET-window guard; runs the morning research (+ auto-buy/manage when enabled).
- manage.yml — every 30 min during market hours; runs auto-manage (no-op unless enabled).

## Scripts
`npm run vega` (research), `npm run manage` (auto-manage), `npm run smoke` (Alpaca smoke), `npm run inspect` (DB), `npm run seed` (watchlist).

## Current state (2026-07-06)
- All 6 milestones complete + deployed to Vercel.
- Alpaca: now running the **$500 paper account "vega" (PA34D7UCJ09S)** for realism. (Old $100k account PA36XU2UR1ZR no longer used.)
- Position sizing tuned for a small account: cheap OTM contracts (< maxContractPrice), buy multiple to fit perTradeBudget.
- Open direction from owner + a friend (Farrukh): cheap $1-2 contracts (done), $500 account (done), and a future upgrade to read charts/levels/patterns rather than only news (NOT built yet — highest-leverage next step).

## Conventions
Mobile-first, calm decision surface. Plain English for a layman; downside gets equal billing with upside. No em dashes in UI copy (stripDash sanitizes model text). All dollar figures code-computed.
