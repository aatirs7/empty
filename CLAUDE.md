# Vega — Project Context (CLAUDE.md)

Persistent context for Claude Code. Read at the start of every session. Keep the **Build Status** tracker at the bottom current — tick a box the moment a milestone is done and testable.

## What this is

Vega is a personal, mobile-first web app (PWA) that researches pre-market news with Claude each weekday morning, proposes options trades as structured data, and lets the owner approve/reject each one from their phone. The daily pre-market research run is codenamed **Operation Vega**. (Name note: vega is the options greek for volatility sensitivity; buying long options is being long vega.)

Full requirements: `c:\Users\aatir\Downloads\vega-spec.md`. This file records the deltas from that spec plus the hard rules.

## NON-NEGOTIABLE GUARDRAILS

Never violate these. Never "temporarily" disable them to make a test pass.

1. **Paper trading only.** `ALPACA_BASE_URL` is hardcoded to `https://paper-api.alpaca.markets`. There is NO live-trading code path in this repo. Do not add one.
2. **`TRADING_MODE` must equal `paper`.** The execute endpoint asserts this and throws otherwise.
3. **Human in the loop.** Operation Vega only writes proposals to the database. It NEVER places orders. Orders are placed only when the owner taps Approve on a specific proposal.
4. **Position caps, enforced server-side:** max 1 contract per order (`MAX_CONTRACTS_PER_ORDER`), max 3 open positions (`MAX_OPEN_POSITIONS`). The execute endpoint rejects anything over.
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

## Build status (update as you go)

- [x] M1: Alpaca paper smoke test — plumbing verified live (account/chain/quote/order/read-back). Order rests as `new` when market is closed; re-run `npm run smoke` during 09:30–16:00 ET to watch a fill.
- [x] M2: The Brain in isolation — schema-valid JSON, correct "priced-in" discipline. COST: ~$1.2–1.6/run (input tokens dominate). `MAX_WEB_SEARCHES` default 8; watchlist size is the other lever. Watch monthly spend vs the Anthropic Console cap.
- [x] M3: DB + wiring — 5 tables migrated to Neon, watchlist seeded, run #1 + 5 proposals persisted with cost fields. Inspect with `npm run inspect`.
- [~] M4: Scheduler — workflow authored (`.github/workflows/operation-vega.yml`, dual-cron + ET-window guard + workflow_dispatch). Verify by pushing to GitHub, setting Actions secrets (DATABASE_URL, ANTHROPIC_API_KEY, RESEARCH_MODEL), and running a manual dispatch.
- [ ] M5: Execute endpoint (approved proposal becomes a filled paper order)
- [ ] M6: Dashboard + PWA (installable on phone, approve/reject works)

## Notes for future sessions

- Learning instrument, not a money machine. First month is paper only, measuring whether the "priced in vs mispriced" read beats doing nothing.
- None of this is financial advice.
