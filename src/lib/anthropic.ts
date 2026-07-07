/**
 * The Brain, one Claude call with web search, forced to return only JSON.
 *
 * Model: claude-sonnet-5 (via RESEARCH_MODEL). Web search: web_search_20260209
 * (dynamic filtering). The Brain never sees or invents option prices, it emits
 * strike/expiry HINTS only.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ZoneSetup } from "./strategy";

// ---------- Output schema (spec §6.4) ----------

export const ProposalSchema = z.object({
  symbol: z.string(),
  direction: z.enum(["call", "put", "none"]),
  strategy: z.enum(["long_call", "long_put", "no_trade"]),
  strike_hint: z.string(),
  expiry_hint: z.string(),
  confidence: z.number().min(0).max(1),
  priced_in_assessment: z.enum(["priced_in", "underdone", "overdone", "unclear"]),
  rationale: z.string(),
  plain_explanation: z.string(),
  sources: z.array(z.string()),
  zone_read: z.string().nullable().optional(),
});

export const ResearchOutputSchema = z.object({
  as_of: z.string(),
  market_context: z.string(),
  proposals: z.array(ProposalSchema),
});

export type Proposal = z.infer<typeof ProposalSchema>;
export type ResearchOutput = z.infer<typeof ResearchOutputSchema>;

export interface WatchlistItem {
  symbol: string;
  notes?: string | null;
  zoneSetup?: ZoneSetup | null;
}

export interface ResearchResult {
  output: ResearchOutput;
  model: string;
  inputTokens: number;
  outputTokens: number;
  searchCount: number;
  costEstimate: number;
  rawText: string;
}

export class ResearchParseError extends Error {
  constructor(
    public rawText: string,
    public cause: unknown,
  ) {
    super(`The Brain returned output that failed schema validation. ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ResearchParseError";
  }
}

// ---------- Prompt (spec §6.1, verbatim) ----------

const SYSTEM_PROMPT = `You are a pre-market equity-options research assistant. Your job runs about one
hour before the US market open. You are given a watchlist of stock symbols.

For each symbol:
1. Use web search to find overnight and pre-market news, earnings, guidance,
   analyst actions, sector moves, and any pre-market price action.
2. Do NOT simply label news "good" or "bad." Assess whether the likely move is
   ALREADY PRICED IN, UNDERDONE, or OVERDONE relative to the pre-market reaction
   you can observe. Obvious good news is usually already reflected in a gap-up
   before the open, so a naive "good news = buy calls" read is often a trap.
3. Only propose a trade when you have a specific, defensible reason to think the
   market's pre-market reaction is wrong in a direction you can name. If you have
   no edge on a symbol, propose "no_trade." A day with zero proposals is a fine
   and expected outcome.

ZONE SETUPS (highest-weight signal):
Some symbols carry a code-computed ZONE SETUP, a supply/demand order-block setup.
When a symbol has a zone setup, it is the PRIMARY driver, above news:
- The trade DIRECTION is fixed by the setup's "direction" (call or put). Do not
  override it with a news-based direction. The strategy fades the approach into a
  zone: price falling into a zone => call (expect a bounce up), price rising into a
  zone => put (expect a rejection down).
- Use news only as confirmation or caution: does it support or threaten that bounce/
  rejection? Reflect it in confidence. Strong opposing news lowers confidence a lot.
- If "clear_runway" is false or "setup_valid" is false, do NOT force a zone trade;
  prefer "no_trade" unless news alone independently justifies one.
- Match the expiry hint to the setup horizon. A daily-scan zone tap is a short swing,
  so "1-2 weeks" fits; never justify it with a long-term trend.
- Provide "zone_read": one plain sentence on what the zone setup implies. For symbols
  with no zone setup, leave zone_read empty and proceed on news as usual.

Hard rules:
- You never see live option prices and you must never invent them. Express strikes
  as hints only ("ATM", "~5% OTM") and expiries as hints only ("nearest weekly",
  "2-4 weeks"). A separate system picks the real contract later.
- Keep each rationale to two sentences maximum.
- Also include a "plain_explanation": 2-3 sentences in plain, jargon-free English
  describing what the trade is and why you picked it, written for someone who does
  not trade options. QUALITATIVE ONLY, do NOT put any numbers, prices, strikes, or
  percentages in it (a separate system computes the numbers). For a "no_trade",
  briefly say in plain English why there's no clear opportunity.
- Include the source URLs you relied on.
- Be honest about confidence. Low confidence is normal.
- Output ONLY a single JSON object matching the schema. No preamble, no markdown
  code fences, no commentary before or after.

Schema:
{
  "as_of": "<ISO 8601 timestamp>",
  "market_context": "<1-2 sentence read of the overall tape this morning>",
  "proposals": [
    {
      "symbol": "<TICKER>",
      "direction": "call" | "put" | "none",
      "strategy": "long_call" | "long_put" | "no_trade",
      "strike_hint": "<e.g. ATM, ~5% OTM, or empty for no_trade>",
      "expiry_hint": "<e.g. nearest weekly, 2-4 weeks, or empty for no_trade>",
      "confidence": <number 0.0 to 1.0>,
      "priced_in_assessment": "priced_in" | "underdone" | "overdone" | "unclear",
      "rationale": "<two sentences max>",
      "plain_explanation": "<2-3 jargon-free sentences, NO numbers>",
      "sources": ["<url>", "..."],
      "zone_read": "<one sentence on the zone setup, or empty if none>"
    }
  ]
}`;

function buildUserMessage(watchlist: WatchlistItem[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = watchlist
    .map((w) => {
      const base = `${w.symbol}, ${w.notes?.trim() || "no extra context"}`;
      const z = w.zoneSetup;
      if (z && z.active_zone) {
        return `${base}\n   ZONE SETUP: direction=${z.direction} approach=${z.approach} ${z.active_zone.type} zone [${z.active_zone.bottom}-${z.active_zone.top}] price=${z.price} distance_to_edge=${z.distance_to_edge_pct}% clear_runway=${z.clear_runway} setup_valid=${z.setup_valid} (${z.tap_granularity})`;
      }
      return base;
    })
    .join("\n");
  return `Today is ${today}. Research the following watchlist for pre-market opportunities.
Return one proposal object per symbol (use "no_trade" when there is no edge).

Watchlist:
${lines}`;
}

// ---------- Pricing (Sonnet 5) ----------
// Standard: $3 / $15 per 1M tokens (intro $2 / $10 through 2026-08-31).
// Web search: $0.01 per request. Standard rates used as a conservative estimate.
const INPUT_RATE = 3;
const OUTPUT_RATE = 15;
const SEARCH_RATE = 0.01;

// Cap web searches per run to bound cost. The dominant cost is INPUT tokens:
// search results re-enter the context on every model turn, and when the server
// web-search loop exceeds ~10 internal iterations it emits `pause_turn`, forcing
// a continuation that re-bills the whole accumulated context. Keeping this under
// ~10 tends to keep the run to a single billed pass. Higher = deeper research,
// more $. Tune via MAX_WEB_SEARCHES; watchlist size is the other big lever.
const MAX_WEB_SEARCHES = Number(process.env.MAX_WEB_SEARCHES ?? 8);

// The web search tool literal may be newer than the installed SDK's typed union.
const TOOLS = [
  { type: "web_search_20260209", name: "web_search", max_uses: MAX_WEB_SEARCHES },
] as unknown as Anthropic.Messages.ToolUnion[];
const MAX_TOKENS = 16000;

interface Totals {
  input: number;
  output: number;
  searches: number;
}

function accumulate(totals: Totals, response: Anthropic.Message): void {
  totals.input += response.usage.input_tokens ?? 0;
  totals.output += response.usage.output_tokens ?? 0;
  const reported = response.usage.server_tool_use?.web_search_requests;
  if (typeof reported === "number") {
    totals.searches += reported;
  } else {
    totals.searches += response.content.filter((b) => b.type === "web_search_tool_result").length;
  }
}

function textOf(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** This turn's web searches + their query strings (for the cost diagnostic). */
function turnSearches(response: Anthropic.Message): { count: number; queries: string[] } {
  const queries: string[] = [];
  for (const b of response.content) {
    if (b.type === "server_tool_use" && b.name === "web_search") {
      const q = (b.input as { query?: string } | null | undefined)?.query;
      if (q) queries.push(q);
    }
  }
  const reported = response.usage.server_tool_use?.web_search_requests;
  return { count: typeof reported === "number" ? reported : queries.length, queries };
}

/** Runs one turn, transparently continuing across web-search `pause_turn` stops. */
async function converse(
  client: Anthropic,
  model: string,
  messages: Anthropic.MessageParam[],
  totals: Totals,
): Promise<string> {
  let msgs = [...messages];
  let response: Anthropic.Message | undefined;
  for (let i = 0; i < 6; i++) {
    response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: msgs,
      tools: TOOLS,
    });
    accumulate(totals, response);

    // Per-turn cost diagnostic. Each pause_turn continuation re-sends the full
    // accumulated context (including prior search results) and re-bills it as
    // input, watch `in=` climb across turns to see the re-send amplification.
    const t = turnSearches(response);
    console.log(
      `[brain] turn ${i + 1}: stop=${response.stop_reason} in=${response.usage.input_tokens} out=${response.usage.output_tokens} searches=${t.count}`,
    );
    if (t.queries.length) console.log(`[brain]   queries: ${t.queries.join(" | ")}`);

    if (response.stop_reason === "pause_turn") {
      msgs = [...msgs, { role: "assistant", content: response.content as unknown as Anthropic.ContentBlockParam[] }];
      continue;
    }
    break;
  }
  return textOf(response!);
}

function tryParse(text: string): { ok: true; value: ResearchOutput } | { ok: false; error: unknown } {
  try {
    const clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    const value = ResearchOutputSchema.parse(JSON.parse(clean));
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Runs the research call for a watchlist. On a first-pass parse/validation
 * failure, retries once with a "return valid JSON only" nudge before giving up
 * (throws ResearchParseError so the caller can mark the run failed + store raw).
 */
export async function runResearch(watchlist: WatchlistItem[]): Promise<ResearchResult> {
  if (watchlist.length === 0) throw new Error("Watchlist is empty.");
  const model = process.env.RESEARCH_MODEL ?? "claude-sonnet-5";
  const client = new Anthropic();
  const userMessage = buildUserMessage(watchlist);
  const totals: Totals = { input: 0, output: 0, searches: 0 };

  let text = await converse(client, model, [{ role: "user", content: userMessage }], totals);
  let parsed = tryParse(text);

  if (!parsed.ok) {
    // one automatic retry, continuing the conversation with a nudge
    const retryMessages: Anthropic.MessageParam[] = [
      { role: "user", content: userMessage },
      { role: "assistant", content: text || "(no text)" },
      {
        role: "user",
        content:
          "Your previous reply did not parse as the required JSON object. Reply with ONLY the single JSON object matching the schema, no preamble, no commentary, no markdown code fences.",
      },
    ];
    text = await converse(client, model, retryMessages, totals);
    parsed = tryParse(text);
  }

  if (!parsed.ok) {
    throw new ResearchParseError(text, parsed.error);
  }

  const costEstimate =
    (totals.input / 1e6) * INPUT_RATE + (totals.output / 1e6) * OUTPUT_RATE + totals.searches * SEARCH_RATE;

  return {
    output: parsed.value,
    model,
    inputTokens: totals.input,
    outputTokens: totals.output,
    searchCount: totals.searches,
    costEstimate,
    rawText: text,
  };
}
