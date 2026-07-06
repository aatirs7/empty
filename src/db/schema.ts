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
  sources: jsonb("sources").$type<string[]>(), // array of URLs
  status: text("status").notNull().default("pending"), // pending | approved | rejected | filled | expired
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Actual paper orders placed after approval.
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
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  filledAt: timestamp("filled_at", { withTimezone: true }),
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
