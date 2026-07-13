/**
 * Catalyst check — the ONLY Claude use in the trading path. Code can't read the
 * news calendar, so a tiny web-searched call asks whether a known scheduled event
 * (earnings, FOMC/CPI on a rate-sensitive name) lands within the hold window.
 *
 * For FLIP setups (SBv2) it ALSO does a flip-aware NEWS-CONTEXT read: a daily
 * order-block flip is an acceptance/continuation bet, and whether the breakout was
 * driven by real news (continues) vs a low-conviction drift or a move that fresh
 * news actively CONTRADICTS (fails the retest) is judgment no reaction-DB number
 * gives you. Pass `opts.direction` to enable it; the gate only ever BLOCKS on news
 * clearly against the trade — it never invents a probability, target, or score.
 *
 * Fails OPEN (advisory): if Claude is unavailable, trading proceeds ("unchecked").
 */
import Anthropic from "@anthropic-ai/sdk";
import { logApiCost } from "./cost";

export interface CatalystResult {
  catalyst: boolean; // a known scheduled catalyst within the window
  event: string; // short description
  checked: boolean; // whether the check actually ran
  newsAgainst?: boolean; // flip only: fresh, material news pushing AGAINST the flip direction
  newsFor?: boolean; // flip only: fresh news supporting the continuation
  newsSummary?: string; // flip only: one-line context (no numbers)
}

export interface CatalystOptions {
  /** When set, also run the flip-aware news-context read for this trade direction. */
  direction?: "call" | "put";
  /** Overall abort deadline (ms). Defaults to 40s — bounds the worst case well under
   *  the 60s monitor tick while giving the web search room to finish (better than the
   *  legacy UNBOUNDED call). Fails OPEN on abort. */
  timeoutMs?: number;
}

const MODEL = process.env.CATALYST_MODEL ?? process.env.RESEARCH_MODEL ?? "claude-sonnet-5";

// profileId attributes this call's API spend to the account that triggered it
// (SBv1 / SBv2 in practice). QQQ 0DTE never calls this.
export async function checkCatalyst(symbol: string, days = 5, profileId?: string, opts?: CatalystOptions): Promise<CatalystResult> {
  if (!process.env.ANTHROPIC_API_KEY) return { catalyst: false, event: "", checked: false };
  const dir = opts?.direction;
  const bias = dir === "call" ? "bullish (a CALL — betting price continues UP)" : dir === "put" ? "bearish (a PUT — betting price continues DOWN)" : "";
  const against = dir === "call" ? "DOWN (against the bullish continuation)" : "UP (against the bearish continuation)";

  const prompt = dir
    ? `You are vetting a ${bias} daily order-block FLIP-continuation trade on ${symbol}: price broke through and accepted beyond a daily zone, and we're buying the first retest. Using web search of the latest news AND the earnings calendar, answer:
1. Is there a SCHEDULED catalyst within the next ${days} US trading days (next earnings report, or FOMC/Fed rate decision / CPI on a rate-sensitive name)?
2. Is there fresh, MATERIAL news in the last ~3 sessions that would push ${symbol} ${against} — i.e. a real reason this breakout is a fakeout likely to FAIL the retest?
3. Is there fresh news that SUPPORTS the continuation in the trade's direction?
Then STOP searching and output ONLY this JSON object as your entire final reply — no explanation, no citations, no markdown: {"catalyst": true|false, "event": "<short label or empty>", "newsAgainst": true|false, "newsFor": true|false, "newsSummary": "<one short line, no numbers>"}.`
    : `Is there a known SCHEDULED catalyst for ${symbol} within the next ${days} US trading days — specifically its next earnings report, or a major macro event that would hit it hard (FOMC/Fed rate decision, CPI on a rate-sensitive name)? Use web search to check the current earnings calendar. Then output ONLY this JSON object as your entire final reply, no prose: {"catalyst": true|false, "event": "<short label or empty>"}.`;

  let inputTokens = 0;
  let outputTokens = 0;
  let searchCount = 0;
  // Hard overall deadline: this runs inside the every-minute monitor tick (60s
  // budget shared with buys + exits), so a slow web search must FAIL OPEN fast
  // rather than starve the tick. On abort the create() rejects → caught → unchecked.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 40_000);
  try {
    const client = new Anthropic({ maxRetries: 1 });
    let msgs: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    let response: Anthropic.Message | undefined;
    for (let i = 0; i < 4; i++) {
      response = await client.messages.create(
        {
          model: MODEL,
          max_tokens: 900,
          messages: msgs,
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }],
        },
        { signal: controller.signal },
      );
      // Accumulate token + search usage across pause_turn continuations.
      inputTokens += response.usage?.input_tokens ?? 0;
      outputTokens += response.usage?.output_tokens ?? 0;
      searchCount += response.usage?.server_tool_use?.web_search_requests ?? 0;
      if (response.stop_reason === "pause_turn") {
        msgs = [...msgs, { role: "assistant", content: response.content as unknown as Anthropic.ContentBlockParam[] }];
        continue;
      }
      break;
    }
    const text = (response?.content ?? [])
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    // Parse the LAST {...} in the text (the model's final JSON, past any prose).
    const matches = text.match(/\{[\s\S]*?\}/g);
    const m = matches ? matches[matches.length - 1] : null;
    if (!m) return { catalyst: false, event: "", checked: true };
    const j = JSON.parse(m);
    return {
      catalyst: !!j.catalyst,
      event: String(j.event ?? "").slice(0, 80),
      checked: true,
      ...(dir
        ? { newsAgainst: !!j.newsAgainst, newsFor: !!j.newsFor, newsSummary: String(j.newsSummary ?? "").slice(0, 120) }
        : {}),
    };
  } catch {
    return { catalyst: false, event: "", checked: false };
  } finally {
    clearTimeout(deadline);
    // Log the spend even on partial/failed runs (tokens were still consumed).
    if (inputTokens || outputTokens || searchCount) {
      await logApiCost({ profileId: profileId ?? null, source: "catalyst", symbol, model: MODEL, inputTokens, outputTokens, searchCount });
    }
  }
}
