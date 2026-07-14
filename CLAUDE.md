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
4. **Position caps, enforced server-side:** per-order contract count is bounded by `MAX_CONTRACTS_PER_ORDER` (hard ceiling, 20) and the user's Settings `maxContracts` (default 5); Vega buys as many contracts as the per-trade budget allows up to that cap. Open positions bounded by the profile's `maxOpenPositions` AND the `MAX_OPEN_POSITIONS` env ceiling (execute takes the min); owner raised SniperBot to 10 on 2026-07-09 (QQQ 0DTE stays 2). The execute endpoint rejects anything over. NOTE: the original 1-contract cap was deliberately relaxed for small-account realism — this is PAPER-ONLY and every order still re-asserts `TRADING_MODE==='paper'`.
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
MAX_OPEN_POSITIONS=10
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

### S-series: strategy PROFILES (SniperBot Master + QQQ 0DTE). Fresh $1000 PAPER acct (PA33FAVNIVA2), DATA_FEED=sip (paid).
The single zone strategy became a PROFILE system. `src/lib/profiles.ts` = code registry: `sniper_swing` (main, auto ON), `qqq_0dte` (off, measured), `zones_legacy` (shelved, shadow-only). Each profile drives universe/zone/confirmation/score/contract/caps/exit. `profile_settings` table = per-profile auto toggles. `profileId` tags candidates/proposals/shadow_outcomes/universe.
- [x] S1: Profile framework — registry + profileId columns + profile_settings; scanner loops profiles; execute reads per-profile caps; resolve parameterized by ContractConfig (OTM window/band/liquidity/expiryKind incl. 0DTE).
- [x] S2: Confirmation engine — `getIntradayBars` (5Min, SIP); `confirm.ts` (rejection wick/engulf/strong close + rel volume → confirmed + Execution-Quality). Confirmation profiles fire only when price is AT the zone AND a confirmation candle prints. Per-profile auto gating (SniperBot on, QQQ off, zones off = cutover).
- [x] S3: SniperBot engine — `sniper.ts`: 3 code scores (Probability/Weekly-Options-Potential/Execution-Quality) + historical-similarity % + empty-space flag + adversarial review; `catalyst.ts` = tiny Claude web-search earnings/Fed check (only model use, fails open). Promotes only setups that clear all + survive adversarial + no catalyst.
- [x] S4: Per-profile contracts — sniper far-OTM cheap weekly (otmPct 12); QQQ 0DTE same-day (resolve now+0 day). NOTE: mega-cap $0.50-$1 weekly selection needs MARKET-HOURS validation (nulls after-hours); widen otmPct if it can't find contracts. Per-profile live exits still global +100/-30 (fine until QQQ trades).
- [x] S5: Scheduling — shadow migrated to `/api/shadow` Vercel cron (15:00 UTC), per-profile; GitHub shadow.yml disabled. Premarket re-eval subsumed by the every-minute confirmation-gated monitor. `/api/scan` (04:00 UTC) now scans all profiles.
- [x] S6: Measurement + UI — per-profile shadow (SPY baseline for swings, QQQ for 0DTE); per-profile `scorecard.ts` + `/scorecard` (never blended); Setups page profile tabs. WhatsNew updated.

### Q-series: QQQ 0DTE additions + Historical-Reaction Database. QQQ on its OWN paper account (ALPACA_*_2). Numbers all from the reaction DB.
- [x] Q1: `reactions` table + `reactions.ts` (computeReactions replays bars recording every tap's approach/edge/outcome/MFE/MAE/move/time/expansion/pattern/fingerprint; `queryReactions` matches a live setup with tiered bucket widening + N=20 min-sample honesty + always returns sample size + Safe/Main/Stretch targets). `npm run backfill` (daily+4H). Backfilled 236k reactions across 130 symbols.
- [x] Q2: multi-timeframe zones — `Profile.zoneTimeframes` (QQQ = Daily 1.7 + 4H 1.3); `candidates.timeframe`; scanner loops timeframes (daily batched, 4H via getIntradayBars).
- [x] Q3: `predict.ts` — bias/probability/confidence/expected move (pts+%)/targets/hold/sample-size from queryReactions. SniperBot's evaluateSniper now derives Probability + move + targets from the DB (falls back to in-memory when no sample).
- [x] Q4: `alpaca.getOptionSnapshots` (greeks+IV via /v1beta1/options/snapshots — greeks work on the free indicative feed, no OPRA needed); `ev.ts selectByEV` ranks contracts by EXPECTED VALUE (P×gain−cost−theta) within the profile price band → Primary/Aggressive/Conservative.
- [x] Q5: per-profile accounts — alpaca AsyncLocalStorage `withAccount`; `getBroker(profileId)` (QQQ→ALPACA_*_2); execute routes through the profile broker + uses selectByEV for confirmation profiles; manageExits per-account + per-profile TP/SL + 0DTE same-day flatten. RESOLVED: the ALPACA_*_2 key was re-pasted (QQQ paper account PA3CHVMZRNSL, $1000), set on Vercel, and qqq_0dte auto flipped ON. Both strategies now trade their own accounts (SniperBot PA33FAVNIVA2, QQQ PA3CHVMZRNSL).
- [x] Q6: Today profile toggle; `QqqPrediction` (Setups QQQ tab: live prediction per TF + 3 EV contracts + sample sizes); WhatsNew + version bump.
- [x] Q6.1 (UI polish): shared `ProfileTabs` (SniperBot/QQQ only — zones_legacy dropped from the UI) on Today/Setups/Positions/Log/P&L; Positions + closed + close + /account + /manage + P&L route per-profile via `getBroker(profileId)` so the QQQ account is visible (close derives the account from the order's proposal). Today shows a profile-specific summary + approaching-setups fallback (QQQ tab no longer blank). BottomNav hides on visualViewport shrink (keyboard no longer shoves it up). WhatsNew content centered.
- [x] Q6.2 (score display): SniperBot candidate scores pinned at 100 because the gate score's two differentiators saturate. Added a UI-only `displayScore` (non-saturating: log R/R, wider history band, playbook-strength weighting); scanner writes it to `candidate.score`. **Live trading unchanged** — monitor.ts still gates auto-buys on `pb.score` and `sniperConfidence` stays on `pb.score`; only display strings use displayScore. Verified spread: 81 candidates now range 40–100, median 65 (was all 100).
- [x] Q6.3 (per-account API cost): new `api_costs` ledger (`src/lib/cost.ts` `logApiCost`/`getProfileCost`/`getAllApiCost`) attributes each Claude call to a profile. `catalyst.ts` (the only ongoing live-path Claude spend; QQQ uses none) accumulates token/search usage and logs it under the triggering profile; `run-vega` research logs as shared (profileId null). P&L subtracts THIS account's own spend (QQQ ≈ $0). Legacy `research_runs` cost sum removed (`getCostTotals` gone) so displayed spend restarts from now; Log MTD + scorecard read the ledger. Migration `0018_same_nick_fury`. **Deploys are CLI-only: `npx vercel --prod --yes` after every push (git push does NOT auto-deploy).**

### Q7: QQQ intraday rework (Farrukh feedback, 2026-07-09) — LIVE
- [x] QQQ profile switched from Daily+4H (multi-day ~5-day holds against same-day options) to INTRADAY: `zoneTimeframes` = 15Min + 1H (same-day 0DTE) + 4H (next-day 1-day swing); Daily dropped. `src/lib/timeframes.ts` (ALPACA_TF/MINUTES_PER_BAR/SCAN_LOOKBACK_MIN/formatHold).
- [x] Per-timeframe contract expiry: new `ExpiryKind "oneDay"` + `ZoneTimeframe.expiryKind` + `contractForTimeframe(profile, tf)`; 15m/1h→zeroDte, 4h→oneDay. Wired through resolve.ts, ev.ts, execute.ts. Verified live: 15m/1h pick today's expiry, 4h picks tomorrow's.
- [x] Hold shown in MINUTES/hours not bars (`formatHold`; predict.expectedHoldLabel; QqqPrediction). Verified: 15m→~60min, 1h→~4h, 4h→~24h.
- [x] Intraday reaction backfill: `scripts/backfill-intraday.ts` (`npm run backfill:intraday`) 15Min+1H for QQQ + 24 liquid comps → 124k(15m)+30k(1h) reactions; reactions tuning added for 15min/1h. QQQ symbol-tier n=2210/644/635.
- [x] 24/7 market-hours scanner: monitor `refreshIntradayScans()` re-scans QQQ intraday every ~5min while open (self-starts at open, stops at close via the market-gated tick). `scanProfile` exported.
- [x] Caps: perTradeBudget 160 (covers a next-day swing at priceCap), maxOpenPositions 2 (0DTE + swing coexist). sameDayExit only flattens contracts expiring TODAY so the next-day swing rides overnight.
- **QQQ account was reset/re-keyed to PA3NPEDZA11B ($1000) mid-session; new ALPACA_*_2 keys set on Vercel prod. QQQ auto ON.**
- FIXED same session: vanishing trades — PositionsView no longer POSTs /api/manage on load (it force-closed near-expiry weeklies unrecorded); autoManagePositions now records exits. Exits are solely the per-minute monitor's job.

### SBv2: parallel strategy (Farrukh logic reset, 2026-07-13) — SHADOW-MEASURED, auto OFF
The current SniperBot was relabeled **SBv1** (id `sniper_swing` UNCHANGED — rules/universe/exits/history intact). A NEW profile **SBv2** (`id: "sbv2"`) runs in PARALLEL for a head-to-head, per `sniperbot-daily-swing-v2.md`.
- **SBv2 strategy** = daily Order-Block **FLIP + FIRST retest** (genuinely different from SBv1's stateless tap). A daily zone that price BROKE and ACCEPTED through (daily close beyond the whole zone — captures the overnight-gap case too) flips role: broke-above ⇒ TOP becomes support ⇒ first tap of the TOP = CALL; broke-below ⇒ BOTTOM becomes resistance ⇒ first tap of the BOTTOM = PUT. Daily TF ONLY qualifies (1D/ATR50/disp1.7); lower TFs only monitor the live retest. 1-2 day swing.
- **New code:** `src/lib/flips.ts` (`detectFlips` — acceptance candle, sessionsSinceFlip ≤2, drops wick-only / closed-back-inside / already-first-retested; all derivable from settled daily bars, NO new state table) + `buildFlipSetups` in `strategy.ts` (parallel to `buildZoneSetups`, same `Bar[]→ZoneSetup[]` shape; stashes `flipped_boundary`/`accepted_at`/`sessions_since_flip`/`setup_kind:"flip"`).
- **Branches (not new pipelines):** `Profile.setupKind`("tap"|"flip") + `entryKind`("tap"|"flip_retest"). scanner.ts picks the builder by setupKind. monitor.ts adds a `flip_retest` entry branch (fires on first live tap of the flipped boundary via the crossing machinery; RE-VALIDATES the flip on fresh settled daily bars — excludes today's forming candle so the live tap doesn't self-invalidate — before ordering). Contract selection reuses the confirmation→predict→horizon-matched `selectByEV` path (confirmation.enabled=true). Exit = swing (mirrors SBv1: ride $2, swing-invalidation, catastrophe floor ≤2d to expiry).
- **Account:** SBv2 trades its OWN paper account via `broker.accountKeysFor` → `ALPACA_API_KEY_ID3`/`ALPACA_API_SECRET_KEY3` (owner added key3). Falls back to default keys (shadow-only) if unset. getBroker still asserts paper.
- **Same ~129 mega-cap universe** as SBv1 (`seed-universe.ts add(SNIPER,"sbv2")`). `UI_PROFILE_TABS` = SBv1 · SBv2 · QQQ (auto-wires scorecard/report/shadow/Setups). Daily report has an "SBv1 vs SBv2 (this week)" head-to-head line + SPY buy-and-hold benchmark; SBv2's auto-off flat line is labeled intentional (not "Main issue").
- **Auto:** ships `autoDefault:false`; **owner turned it ON 2026-07-13** via `npm run profile-auto -- sbv2 on` (script also does off / buy-only; `npm run profile-auto` prints all profiles' state — note: run via `npx tsx scripts/profile-auto.ts <id> <state>` directly, npm `-- ` arg-forwarding is flaky on Windows). Verified: 48 valid SBv2 flip candidates scanned today; geometry + invalidations confirmed.
- **Catalyst upgrade (flip-aware, `catalyst.ts`):** `checkCatalyst(sym,days,pid,{direction})` — for flip setups the ONE Claude call now ALSO does a news-context read (scheduled catalyst + "is there fresh material news pushing AGAINST this accepted breakout / supporting it?"). Monitor skips a flip on `newsAgainst`; SBv1/QQQ keep the plain scheduled check (no direction). BOUNDED by an AbortController deadline (`opts.timeoutMs`, default 40s) so it can't starve the 60s tick — strictly safer than the legacy UNBOUNDED call. FAILS OPEN (checked=false) on abort. Reality: web search takes ~30-57s, so ~1/3 of names complete in-budget and 2/3 fail open — safe but partial. **Follow-up option (not built):** move the flip news-vet to the nightly scan (stored on the candidate, read by the monitor) to eliminate fail-opens.
- **UI order (all pages):** `UI_PROFILE_TABS` = **SBv2 · SBv1 · QQQ** (owner's order); `DEFAULT_UI_PROFILE` = first tab (sbv2) so a no-`?profile=` landing defaults to SBv2. ProfileTabs/PositionsView/resolveUiProfile all key off it.
- **DEVIATION from plan:** skipped the dedicated `/api/scan-sbv2` 4:02pm cron — the existing midnight `/api/scan` (`runScan`) already scans ALL active profiles (incl sbv2) off the settled prior close before each session, and the monitor is market-gated + keys off the latest runDate, so a same-day post-close scan wouldn't feed the next session anyway. SBv2's daily watchlist is built nightly with the others.

### SBv2 owner updates (2026-07-13, second batch) — LIVE
Follow-ups on the shipped SBv2, all branching on `profileId`/`entryKind` so **SBv1 stays byte-identical**:
- **Mechanical entry** (`monitor.ts`): `entryKind==="flip_retest"` now BYPASSES the `pb.score<minScore` gate AND `evaluateSniper` (those are SBv1's; the reset spec enters on the first clean retest). SBv2 keeps only the spec's light gates: a valid reaction-DB target (`pred.targetMain!=null` = reward/move large enough) + the flip-aware news-against veto. `confidence` = `pred.probability`.
- **Zone-tap alerts (SBv2 only)**: right after the `flip_retest` `tapCrossing`, `sendPush("SYM zone tap PRICE","enter DIR now")` + `logActivity(kind:"tap")` (kind is `text`, no migration; `tapCrossing` is a one-tick edge so no repeat-spam). Daily report has a "Zone taps (audit)" section; taps excluded from the buy/sell timeline.
- **DB-target exit**: `execute.ts` persists `pred.targetMain`/`targetSafe` into `proposals.zoneSetup` jsonb at entry (no migration); `manage.zoneOfPosition` returns `predictedTarget`; `manageExits` swing branch sells when the UNDERLYING reaches it (falls back to `classifyAndScore.safeTarget` when absent → SBv1 unchanged). SBv2 `exit.targetPremium` REMOVED (no $2 ride); keeps swing-invalidation + catastrophe floor ($0.10) + expiry salvage.
- **Cheap sizing**: SBV2 `contract` = otmPct 25 / priceFloor 0.15 / priceIdeal 0.30 / priceCap 0.60; `caps.maxContracts 3`, `perTradeBudget 100` (2-3 contracts at ~$0.30). `selectByEV` gained `requireTargetReachable` (SBv2-only via `entryKind==="flip_retest"`): filters the strike pool to strikes the target actually reaches (call ≤ target, put ≥ target) so the cheap OTM contract is ITM/ATM at the target — otherwise selectByEV's linear-delta EV overvalues ultra-deep-OTM junk. **Consequence:** ~16/47 flips find a reachable in-band contract (cheaper/mid names trade; ultra-expensive mega-caps skip as "no contract fits" — logged in the funnel). QQQ/SBv1 pass `false` → unchanged.
- **Flip funnel logging** (`flips.ts` `detectFlipsDetailed` + `FLIP_REJECTION_LABELS`, `strategy.ts` `buildFlipSetupsDetailed`, `scanner.ts`): scan tallies WHY zones weren't promoted (wick_only / closed_back_inside / already_retested / stale / too_far) into the scan run's `marketContext`; daily report surfaces it as "SBv2 scan funnel". Liquidity/reward rejections still log as monitor skips (the two together = full funnel).
- **Display fix**: Today capped its "ready" count at `.slice(0,5)` while Setups showed the uncapped 48 — both now show the same funnel: "Checked N names · V valid setups · T tapped today" (`page.tsx` `readyCount`; `setups/page.tsx` loads `getTodayMonitorTrades` for T).

### SBv2 entry bugs fixed (2026-07-13, market-hours) — CRITICAL
Two stacked bugs meant SBv2 had NEVER placed a trade despite firing tap alerts:
1. **False flip invalidation** (`monitor.ts`): the monitor re-derived the flip from a fresh `getStockBars` fetch that disagreed with the scanner's `getMultiStockBars` data → every tap skipped as "flip invalidated (stale)". Daily flip validity can't change intraday (no new close), so the re-derivation was removed; kept only a >3d-old-scan guard. execute.ts's live price-vs-zone check remains the wrong-way safety.
2. **Tick timeout** (`monitor.ts`): the 40s catalyst/news web-search call ran on the every-minute hot path; when several names tapped in one tick (AMD+SBUX+DELL) it blew the 60s `maxDuration` → nothing committed. REMOVED the catalyst call from SBv2's mechanical path. Also dropped the dead `confirmEntry` call from the flip entry.
   - **News vet moved to the nightly scan** (`src/lib/vet-flips.ts` + `/api/vet-flips`, cron `30 4 * * 1-5` = 30 min after `/api/scan`): bounded+concurrent (LIMIT 18, CONC 6, 85s/call) `checkCatalyst(...,{direction})` over the nearest valid flips; stores the verdict in `candidate.setup.news` (jsonb, no migration). The monitor's mechanical path reads `c.setup.news` at tap time (ZERO Claude cost) and blocks on `catalyst` or `newsAgainst`; un-vetted/fail-open flips trade through. ~half the calls complete in-budget (web search is ~50s); the rest fail open. Manually trigger anytime via `/api/vet-flips`.
   - **Entry trigger = TAP, not crossing** (owner ask): SBv2's `flip_retest` now enters when price is within `FLIP_TAP_BAND` (0.4%) of the flipped boundary — a real touch of the level — instead of a strict two-tick `tapCrossing` (which could miss a fast tap between minute ticks and needed a baseline tick first). Deduped to once/candidate/day via `tappedSet` (built from the `tap` activity rows), since a tap doesn't always create a proposal. SBv1/zones_legacy still use `tapCrossing`.
- **Notifications reworked** (owner ask): tap push now says "SYM zone tap PRICE — DIR checking…" (not "enter now"); a SECOND push reports the outcome — "Bought …" (executeProposal) or "SYM not entered — DIR blocked — <why>" via `notifyBlocked` + `friendlyBlock` (no cheap contract that reaches target / position cap / wrong way / market closed).
- **Setups cards** (`setups/page.tsx` + `setup/[id]`): CALL/PUT badge + live tap time ("Tapped 3:37 PM" / "Awaiting retest") from `getCandidateTaps` (reads the `tap` activity rows).

### QQQ 0DTE loss fix (2026-07-13) — don't touch SBv1/SBv2
QQQ lost -$181 (1-for-12) trading ~50% coin-flip setups that can't beat spread+theta on 0DTE. Fixes (per-profile, QQQ-only):
- `Profile.minProbability` (QQQ=60): HARD floor on the reaction-DB hit rate, gated in `monitor.ts` right after `predict` (`pred.probability < minProbability` → skip "coin flip"). SBv1/SBv2 leave it unset → unchanged.
- `Profile.netContractCosts` (QQQ=true): `selectByEV` gains a `netCosts` param — subtracts the round-trip SPREAD (ask−bid; was only netting theta, never the exit spread) from both the win and the miss, and REJECTS (no contract) if the best EV is still ≤0 after spread+theta. So the expected move must clear the round-trip cost or it's no trade. execute.ts passes `profile.netContractCosts===true`; SBv1/SBv2 pass false → unchanged.
- Positions page: **Today / All-time toggle** on the Closed tab (`PositionsView` `ClosedView`) — realized P&L + trade list filter by ET date.

## Notes for future sessions

- Learning instrument, not a money machine. First month is paper only, measuring whether the "priced in vs mispriced" read beats doing nothing.
- None of this is financial advice.
