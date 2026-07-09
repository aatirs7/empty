/**
 * Catalyst check — the ONLY Claude use in SniperBot's path. Code can't read the
 * news calendar, so a tiny web-searched call asks whether a known scheduled event
 * (earnings, FOMC/CPI on a rate-sensitive name) lands within the hold window. It
 * never invents numbers or scores — just a yes/no + a short label. Fails OPEN
 * (advisory): if Claude is unavailable, trading proceeds with "catalyst unchecked".
 */
import Anthropic from "@anthropic-ai/sdk";
import { logApiCost } from "./cost";

export interface CatalystResult {
  catalyst: boolean; // a known scheduled catalyst within the window
  event: string; // short description
  checked: boolean; // whether the check actually ran
}

const MODEL = process.env.CATALYST_MODEL ?? process.env.RESEARCH_MODEL ?? "claude-sonnet-5";

// profileId attributes this call's API spend to the account that triggered it
// (the SniperBot profile in practice). QQQ 0DTE never calls this.
export async function checkCatalyst(symbol: string, days = 5, profileId?: string): Promise<CatalystResult> {
  if (!process.env.ANTHROPIC_API_KEY) return { catalyst: false, event: "", checked: false };
  let inputTokens = 0;
  let outputTokens = 0;
  let searchCount = 0;
  try {
    const client = new Anthropic();
    let msgs: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: `Is there a known SCHEDULED catalyst for ${symbol} within the next ${days} US trading days — specifically its next earnings report, or a major macro event that would hit it hard (FOMC/Fed rate decision, CPI on a rate-sensitive name)? Use web search to check the current earnings calendar. Reply with ONLY compact JSON, no prose: {"catalyst": true|false, "event": "<short label or empty>"}.`,
      },
    ];
    let response: Anthropic.Message | undefined;
    for (let i = 0; i < 4; i++) {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 400,
        messages: msgs,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }],
      });
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
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { catalyst: false, event: "", checked: true };
    const j = JSON.parse(m[0]);
    return { catalyst: !!j.catalyst, event: String(j.event ?? "").slice(0, 80), checked: true };
  } catch {
    return { catalyst: false, event: "", checked: false };
  } finally {
    // Log the spend even on partial/failed runs (tokens were still consumed).
    if (inputTokens || outputTokens || searchCount) {
      await logApiCost({ profileId: profileId ?? null, source: "catalyst", symbol, model: MODEL, inputTokens, outputTokens, searchCount });
    }
  }
}
