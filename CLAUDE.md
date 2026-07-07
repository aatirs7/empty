# Vega — Project Context (CLAUDE.md)

Persistent context for Claude Code. Read at the start of every session. Keep the **Build Status** tracker at the bottom current — tick a box the moment a milestone is done and testable.

## What this is

Vega is a personal, mobile-first web app (PWA) that researches pre-market news with Claude each weekday morning, proposes options trades as structured data, and lets the owner approve/reject each one from their phone. The daily pre-market research run is codenamed **Operation Vega**. (Name note: vega is the options greek for volatility sensitivity; buying long options is being long vega.)

Full requirements: `c:\Users\aatir\Downloads\vega-spec.md`. This file records the deltas from that spec plus the hard rules.

## NON-NEGOTIABLE GUARDRAILS

Never violate these. Never "temporarily" disable them to make a test pass.

1. **Paper trading only.** `ALPACA_BASE_URL` is hardcoded to `https://paper-api.alpaca.markets`. There is NO live-trading code path in this repo. Do not add one.
2. **`TRADING_MODE` must equal `paper`.** The execute endpoint asserts this and throws otherwise.
3. **Human in the loop is the DEFAULT.** Operation Vega writes proposals; by default orders are placed only when the owner taps Approve on a specific proposal. **Deliberate exception (not a violation to "fix"):** an explicit, off-by-default, **PAPER-ONLY** auto-execute mode may place orders automatically, bounded by its own caps (`settings.autoMinConfidence`, `settings.maxAutoTradesPerDay`) plus the standard per-order and open-position caps. Auto-execute MUST assert `TRADING_MODE === "paper"` and hard-refuse otherwise. It is off unless the owner turns it on in settings. This does not create a live-trading path (guardrail #1 still holds).
4. **Position caps, enforced server-side:** per-order contract count is bounded by `MAX_CONTRACTS_PER_ORDER` (hard ceiling, 20) and the user's Settings `maxContracts` (default 5); Vega buys as many contracts as the per-trade budget allows up to that cap. Max 3 open positions (`MAX_OPEN_POSITIONS`). The execute endpoint rejects anything over. NOTE: the original 1-contract cap was deliberately relaxed for small-account realism — this is PAPER-ONLY and every order still re-asserts `TRADING_MODE==='paper'`.
5. **The Brain never sees or invents option prices.** It emits strike and expiry HINTS only. A separate step resolves real contracts off the live Alpaca chain.

## Stack

Next.js (App Router) + TypeScript, Tailwind, Neon Postgres + Drizzle, Vercel (app + execute endpoint), GitHub Actions cron (the research script), Alpaca paper API, Anthropic API. PWA installable to the homescreen. All source under `src/` (`@/*` → `./src/*`).

## Decisions (differ from the raw spec)

- **Research model:** `claude-sonnet-5` (via `RESEARCH_MODEL`), not `claude-sonnet-4-6`. Same price tier.
- **Web search tool:** `web_search_20260209` (dynamic filtering), not `web_search_20250305`. Do NOT also declare `code_execution`.
- **Scheduler:** GitHub Actions cron (not Vercel Cron). `CRON_SECRET` unused.
- **Auth:** single-password gate (Next.js middleware + HMAC-signed httpOnly cookie via `APP_PASSWORD` / `AUTH_SECRET`). NO Clerk.

## Key files

- `scripts/alpaca-smoke.ts` — M1 standalone smoke test (places + reads back one paper option order).
- `scripts/operation-vega.ts` — the daily research run (the Brain). Runs in GitHub Actions.
- `src/db/schema.ts` — Drizzle schema (watchlist, research_runs, proposals, orders, positions_snapshots).
- `src/lib/anthropic.ts` — the Claude research call + system prompt + zod validation + cost logging.
- `src/lib/alpaca.ts` — chain fetch, quote, order placement (trading + data base URLs).
- `src/app/api/execute/route.ts` — resolves an approved proposal to a real contract and places the paper order.
- `src/middleware.ts` + `src/app/login/` — password gate.
- `.github/workflows/operation-vega.yml` — the cron workflow.

## Env vars

```
DATABASE_URL
ANTHROPIC_API_KEY
RESEARCH_MODEL=claude-sonnet-5
ALPACA_API_KEY_ID
ALPACA_API_SECRET_KEY
ALPACA_BASE_URL=https://paper-api.alpaca.markets
ALPACA_DATA_URL=https://data.alpaca.markets
APP_PASSWORD
AUTH_SECRET
TRADING_MODE=paper
MAX_CONTRACTS_PER_ORDER=1
MAX_OPEN_POSITIONS=3
```

Never commit `.env`. Keep secrets out of the repo.

## Conventions

- The Brain returns ONLY a single JSON object (schema in `vega-spec.md` §6). Validate with zod. On parse failure, do one retry with a "return valid JSON only" nudge, then mark the run `failed`.
- Cost logging on every run: `(inputTokens/1e6 * INPUT_RATE) + (outputTokens/1e6 * OUTPUT_RATE) + (searchCount * 0.01)`, with rates set to the active Sonnet 5 pricing.
- Mobile-first, dark theme, large tap targets. A calm decision surface, not a hype screen.
- Proposals default to `pending`. Approve → execute → `filled`. Reject → `rejected`. Stale unactioned → `expired`.

## Planned: Auto-execute + Trade explainer (M5/M6)

**Feature A — Auto-execute (M5), PAPER-ONLY, off by default.**
- `settings` table, single row: `autoExecute` bool default false, `autoMinConfidence` numeric default 0.7, `maxAutoTradesPerDay` int default 2 (dashboard-toggleable, no redeploy).
- Refactor execute into a **shared lib function** (`src/lib/execute.ts`) used by BOTH the manual API route and the research script. The paper-only assertion + all caps live INSIDE it, so both paths are protected identically.
- Auto flow: after Operation Vega persists proposals, if `autoExecute` is on, for each real-trade proposal (not `no_trade`) with `confidence >= autoMinConfidence`, place a paper order — up to `maxAutoTradesPerDay`, respecting per-order + open-position caps. Skip the rest.
- `orders.executionMode`: `'auto' | 'manual'` — always know which trades were automated.

**Feature B — Trade explainer (risk math M5, UI M6).**
- Pure risk-math helper (`src/lib/risk.ts`), **code-computed, never model-generated**: `maxLoss = premium × 100 × qty`; breakeven (call: strike + premium; put: strike − premium); 2–3 scenario payoffs (underlying flat / +5% / +10%). Store on the order row at execution time.
- Add `plain_explanation` to the research JSON schema: 2–3 jargon-free sentences, **qualitative only, no numbers** (numbers stay in code).
- Explainer detail page (M6) per proposal/order, plain language, downside gets equal billing with upside: In plain English (from `plain_explanation`) · Why Vega picked it (rationale + priced-in, de-jargoned) · What you can lose (code max loss, big + blunt; can expire worthless) · What you can gain (breakeven, scenarios; calls uncapped, puts capped at strike→0) · The catch (time decay) · Confidence + honest "one idea, not a guarantee" line.
- For a **PENDING** proposal (pre-approval), the page fetches a live indicative quote for the resolved contract and computes max-loss/breakeven LIVE (reuse M5 resolve + quote), so real dollars-at-risk show before Approve.
- Settings screen (M6): auto-execute toggle with a visible "auto is ON" indicator + easy pause/kill switch.

## Build status (update as you go)

- [x] M1: Alpaca paper smoke test — plumbing verified live (account/chain/quote/order/read-back). Order rests as `new` when market is closed; re-run `npm run smoke` during 09:30–16:00 ET to watch a fill.
- [x] M2: The Brain in isolation — schema-valid JSON, correct "priced-in" discipline. COST: ~$1.2–1.6/run (input tokens dominate). `MAX_WEB_SEARCHES` default 8; watchlist size is the other lever. Watch monthly spend vs the Anthropic Console cap.
- [x] M3: DB + wiring — 5 tables migrated to Neon, watchlist seeded, run #1 + 5 proposals persisted with cost fields. Inspect with `npm run inspect`.
- [x] M4: Scheduler — VERIFIED. `workflow_dispatch` on aatirs7/empty wrote run #2 to Neon. CI uses `npm install` (not `npm ci`) due to a Windows→Linux optional-dep lockfile quirk. Cost fix confirmed: cap-8 → single turn, ~$0.82/run.
- [x] M5: Execute endpoint — VERIFIED. Shared `src/lib/execute.ts` (paper assert + caps inside). Manual approve filled a real paper order (TSLA, order #1, $11.25), risk math stored, executionMode=manual, proposal→filled. Live resolve/quote/risk (`/preview`), risk unit-checked, guardrails (not_paper, already_actioned) confirmed. Auto-execute built (settings-gated, off by default) — reuses executeProposal; test via M6 toggle. Routes: approve/reject/preview/positions/settings. `npm run check:m5`, `npm run execute -- <id>`.
- [x] M6: Dashboard + PWA + auth — VERIFIED at runtime. Screens: Today, Positions (w/ close-position), Log, P&L (net = trade P&L − API cost), proposal explainer (honest downside, live dollars-at-risk from /preview for pending), Settings (auto toggle + params + "auto is ON" banner + kill switch). Single-password auth (proxy.ts + HMAC cookie via APP_PASSWORD/AUTH_SECRET). PWA: manifest.ts + sw.js + generated icons. Auth flow, all pages, positions/preview/close/settings APIs verified live. Auto-execute dry-run: AUTO_EXECUTE_DRY_RUN=1.

### I-series: zone strategy + measurement + live-ready architecture (see STRATEGY.md, HANDOFF.md)
- [x] I1: Zone detection core — `src/lib/zones.ts` ports the Pine order-block math (Wilder ATR-50, 1.7x displacement, first-touch, 30/side FIFO). `alpaca.ts` bars → OHLCV + `getMultiStockBars`. `npm run zones-check`. NOTE: zone math NOT yet confirmed vs Farrukh's TradingView — verify + retune displacement/ATR if off. Sparse by design.
- [x] I2: Nightly scanner + candidates — `strategy.ts` (buildZoneSetup: approach/rejection/white-space/tap-validity), `scanner.ts` over a ~200-name `universe` → `candidates`. `npm run scan`/`seed:universe`, scanner.yml after-close cron.
- [x] I3: Zone setups into the Brain — zone_setup fed as highest-weight (direction fixed by setup, news = color); proposals persist `variant`/`zoneSetup`/`zoneRead`. `runZoneResearch`, `npm run vega:zones`, vega-zones.yml. Verified via `npm run zone-demo -- BA --force`.
- [x] I4: Broker abstraction (PAPER-ONLY) — `src/lib/broker.ts` `BrokerAdapter`/`AlpacaBroker`; `getBroker()` is the single execution choke point (asserts paper). execute/manage/positions/close routed through it. No live path; `TRADING_MODE=live` refuses.
- [x] I5: Paper month — `shadow_outcomes` (per VALID setup, `candidateId`) + `shadow.ts` (enter ask, mark bid, exit +50%/-40%/expiry) + SPY baseline; `scorecard.ts` + `/scorecard` reads shadows-vs-SPY ONLY (no proposals/orders join); shadow.yml cron. **ARMED for AUTO-TRADING (frozen config 2026-07-07):** auto-buy top-5 setups by distance (≤2/day, 1 contract, cheap OTM, ≤3 open), auto-manage structural close-through exits. `npm run arm`. PAPER-ONLY. Do NOT change config mid-month (see memory `vega-paper-month-armed`).
- [x] I6: Live intraday monitor — BUILT. `src/lib/monitor.ts` fires on a real boundary-tap CROSSING (prev-tick vs live snapshot) per `SNIPERBOT-RULES.md`, creates a mechanical proposal + auto-buys (paper picker/caps). `scripts/monitor.ts` persistent loop (market-hours gated via Alpaca clock) — run on Railway/Render (Procfile) or locally (`npm run monitor`). It is now the SOLE trading path (research runs are display-only). Feed via DATA_FEED (iex default; sip for real intraday). OPEN: white-space direction conflict (STRATEGY.md approach-side vs SniperBot continuation-side) unresolved.
- [ ] I7: Live enablement — GATED behind I5 + explicit owner call. Adds live half of the broker + rails (TRADING_MODE=live, ALPACA_LIVE_*, dollar caps, confirmations, auto-off-on-switch, LIVE banner). Would flip guardrail #1 to "paper default, live gated." Not built.

## Notes for future sessions

- Learning instrument, not a money machine. First month is paper only, measuring whether the "priced in vs mispriced" read beats doing nothing.
- None of this is financial advice.
