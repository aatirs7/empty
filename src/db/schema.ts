/**
 * Drizzle schema (spec §5). Neon Postgres.
 *
 * watchlist -> research_runs -> proposals -> orders, plus positions_snapshots.
 * Fully auditable: every run keeps its full parsed response and reasoning.
 */
import { pgTable, serial, text, boolean, timestamp, date, jsonb, integer, numeric } from "drizzle-orm/pg-core";

// Symbols to research each morning.
export const watchlist = pgTable("watchlist", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  notes: text("notes"), // optional context Claude should know
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per Operation Vega run.
export const researchRuns = pgTable("research_runs", {
  id: serial("id").primaryKey(),
  runDate: date("run_date").notNull(),
  status: text("status").notNull(), // running | complete | failed
  model: text("model"),
  marketContext: text("market_context"), // Claude's overall read
  rawResponse: jsonb("raw_response"), // full parsed JSON from Claude, kept for audit
  searchCount: integer("search_count"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costEstimate: numeric("cost_estimate"), // computed from tokens + search fees
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Individual trade ideas from a run.
export const proposals = pgTable("proposals", {
  id: serial("id").primaryKey(),
  runId: integer("run_id")
    .notNull()
    .references(() => researchRuns.id),
  symbol: text("symbol").notNull(),
  direction: text("direction"), // call | put | none
  strategy: text("strategy"), // long_call | long_put | no_trade
  strikeHint: text("strike_hint"), // "ATM", "~5% OTM", etc. NOT a real price
  expiryHint: text("expiry_hint"), // "nearest weekly", "2-4 weeks"
  confidence: numeric("confidence"), // 0.0 - 1.0
  pricedInAssessment: text("priced_in_assessment"), // priced_in | underdone | overdone | unclear
  rationale: text("rationale"), // <= 2 sentences
  plainExplanation: text("plain_explanation"), // jargon-free 2-3 sentences (qualitative only, no numbers)
  sources: jsonb("sources").$type<string[]>(), // array of URLs
  status: text("status").notNull().default("pending"), // pending | approved | rejected | filled | expired
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Scenario payoff computed by code (never model-generated).
export interface Scenario {
  label: string; // e.g. "flat", "+5%", "+10%"
  underlyingPrice: number;
  payoff: number; // per contract, net of premium
}

// Actual paper orders placed after approval (manual) or by auto-execute.
export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  proposalId: integer("proposal_id")
    .notNull()
    .references(() => proposals.id),
  alpacaOrderId: text("alpaca_order_id"),
  contractSymbol: text("contract_symbol"), // the real OCC option symbol chosen
  side: text("side"), // buy
  qty: integer("qty"),
  limitPrice: numeric("limit_price"),
  filledPrice: numeric("filled_price"),
  status: text("status"), // submitted | filled | canceled | rejected
  executionMode: text("execution_mode"), // manual | auto
  // resolved-contract context + code-computed risk math (Feature B)
  direction: text("direction"), // call | put
  strike: numeric("strike"),
  expiry: date("expiry"),
  underlyingPrice: numeric("underlying_price"), // spot at execution
  maxLoss: numeric("max_loss"), // premium * 100 * qty
  breakeven: numeric("breakeven"),
  scenarios: jsonb("scenarios").$type<Scenario[]>(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  filledAt: timestamp("filled_at", { withTimezone: true }),
});

// Single-row app settings. PAPER-ONLY; automation off by default.
export const settings = pgTable("settings", {
  id: serial("id").primaryKey(),
  autoExecute: boolean("auto_execute").notNull().default(false),
  autoMinConfidence: numeric("auto_min_confidence").notNull().default("0.7"),
  maxAutoTradesPerDay: integer("max_auto_trades_per_day").notNull().default(2),
  // Goal-driven auto-management of open positions.
  autoManage: boolean("auto_manage").notNull().default(false),
  weeklyGoal: numeric("weekly_goal").notNull().default("100"), // $ profit target per week
  riskTolerance: text("risk_tolerance").notNull().default("balanced"), // conservative | balanced | aggressive
  // Position sizing for a small, realistic account (cheap OTM contracts).
  perTradeBudget: numeric("per_trade_budget").notNull().default("150"), // $ to spend per trade
  maxContracts: integer("max_contracts").notNull().default(5), // cap on contracts per order
  maxContractPrice: numeric("max_contract_price").notNull().default("2.5"), // only buy options cheaper than this per share
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// The nightly scanner universe (editable list of symbols to scan for zones).
export const universe = pgTable("universe", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  active: boolean("active").notNull().default(true),
  rank: integer("rank"), // optional market-cap rank
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Nightly scanner output: symbols with a zone setup for the next session.
export const candidates = pgTable("candidates", {
  id: serial("id").primaryKey(),
  runDate: date("run_date").notNull(),
  symbol: text("symbol").notNull(),
  direction: text("direction"), // call | put (implied by the rejection rule)
  approach: text("approach"), // from_above | from_below | inside
  clearRunway: boolean("clear_runway").notNull().default(false),
  distanceToEdgePct: numeric("distance_to_edge_pct"),
  setupValid: boolean("setup_valid").notNull().default(false), // daily-scan tap fired
  price: numeric("price"),
  zone: jsonb("zone").$type<{ type: string; bottom: number; top: number }>(),
  setup: jsonb("setup"), // full ZoneSetup (code-computed)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Periodic P&L snapshots for history/charts.
export const positionsSnapshots = pgTable("positions_snapshots", {
  id: serial("id").primaryKey(),
  snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb("payload"), // Alpaca positions + computed P&L
});

export type Watchlist = typeof watchlist.$inferSelect;
export type ResearchRun = typeof researchRuns.$inferSelect;
export type ProposalRow = typeof proposals.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type UniverseRow = typeof universe.$inferSelect;
export type CandidateRow = typeof candidates.$inferSelect;
