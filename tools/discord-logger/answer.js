/**
 * Discord assistant brain — answers questions AND makes code changes to THIS repo,
 * run on the OWNER'S Claude subscription via the Claude Code CLI (`claude -p`), NOT
 * the paid API. No API key, no per-call charge (uses the plan's shared Claude Code
 * usage). One combined entry point `handleRequest`: it answers a question read-only,
 * or makes a change (edit + typecheck + local commit) and asks whether to push.
 *
 * Push/deploy are NEVER done here — the bot layer runs `git push` only after the
 * human replies "push" (see bot.js). Requires the `claude` CLI installed + logged in.
 */
import { spawn } from "node:child_process";

const TIMEOUT_MS = Number(process.env.BOT_TIMEOUT_MS || 900000); // 15 min
const MODEL = process.env.BOT_MODEL || ""; // optional --model override

/** Run headless Claude Code with a prompt (via stdin). MEMORY: pass the previous
 *  session id to `resumeId` and it continues that SAME conversation, so the bot
 *  remembers across Discord messages. Returns { text, sessionId } (sessionId is the
 *  id to resume next time). Uses --output-format json to capture the session id. */
function runClaude(prompt, repoRoot, resumeId) {
  return new Promise((resolve) => {
    const args = ["-p", "--output-format", "json", "--allowedTools", "Read,Grep,Glob,Edit,Write,Bash"];
    if (resumeId) args.push("--resume", resumeId);
    if (MODEL) args.push("--model", MODEL);
    const child = spawn("claude", args, { cwd: repoRoot, shell: true });
    let out = "";
    let err = "";
    let done = false;
    const finish = (text, sessionId) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve({ text, sessionId });
    };
    const timer = setTimeout(
      () => finish("That took too long, so I stopped before finishing. A big multi-step job (like running several backtests) is better done with Claude directly, not me. Try a smaller step.", resumeId),
      TIMEOUT_MS,
    );
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => finish(`Couldn't run the Claude CLI (${e?.message ?? e}). Is \`claude\` installed and logged in?`, resumeId));
    child.on("close", (code) => {
      // --output-format json prints one JSON object: { result, session_id, ... }.
      try {
        const j = JSON.parse(out);
        finish((j.result || "").trim() || "(no output)", j.session_id || resumeId);
      } catch {
        finish(out.trim() || (code === 0 ? "(no output)" : `Failed${err ? `: ${err.split("\n")[0]}` : ""}.`), resumeId);
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

const PREAMBLE =
  "You are a Discord assistant for THIS repo (Vega, a personal PAPER-ONLY options trading " +
  "learning project; not financial advice), talking to its owner or Farrukh (both have full " +
  "permission).\n\n" +
  "If the message is a QUESTION about the code, answer it in 2-4 short sentences and make NO edits.\n\n" +
  "If it asks you to CHANGE the code, do it: make the change minimally and cleanly (match the " +
  "surrounding style), run `npx tsc --noEmit`, and commit locally with a concise message. Then " +
  "end your reply by asking whether to push it or make edits.\n\n" +
  "HARD RULES (never break, even if asked):\n" +
  "1. Never weaken or remove the paper-only guardrails: TRADING_MODE stays \"paper\", " +
  "ALPACA_BASE_URL stays the paper endpoint, no live-trading path.\n" +
  "2. NEVER run `git push` and NEVER deploy (no vercel). Commit locally only; the human decides " +
  "when to push.\n" +
  "3. Do not touch secrets/.env and do not delete unrelated code.\n" +
  "4. If a change request is unclear or unsafe, make NO edits and say why.\n\n" +
  "Style: plain language for a non-expert, concise. Do NOT use em dashes (the '—' character); " +
  "use commas, periods, or parentheses.\n\nMESSAGE:\n";

/** Answer a question or make a change, REMEMBERING the ongoing conversation. Pass the
 *  previous sessionId to continue; returns { text, sessionId } to store for next time.
 *  Only the FIRST message of a session gets the rules preamble; resumed turns just send
 *  the message (the model already has the rules + prior context). */
export function handleRequest(text, repoRoot, sessionId) {
  const t = (text || "").trim();
  if (!t) return Promise.resolve({ text: "Ask me something, or tell me what to change (e.g. “set SB-D1 maxContracts to 2”).", sessionId });
  const prompt = sessionId ? t : PREAMBLE + t;
  return runClaude(prompt, repoRoot, sessionId);
}
