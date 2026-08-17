/**
 * Codebase Q&A + change-requests for the Discord bot, run on the OWNER'S Claude
 * subscription via the Claude Code CLI (`claude -p`) — NOT the paid API. No API key,
 * no per-call charge (it does use the plan's shared Claude Code usage).
 *
 *  - answerQuestion(): READ-ONLY. Explains the repo. Fires on any @mention.
 *  - makeChange():     EDITS the repo. Fires ONLY on the explicit `!change` command,
 *                      with hard rails (never weaken paper-only guardrails, never
 *                      push/deploy, typecheck before committing).
 *
 * Requires: the `claude` CLI installed + logged in on the machine running the bot,
 * and the bot given "Send Messages" permission in the channel.
 */
import { spawn } from "node:child_process";

const ANSWER_TIMEOUT_MS = Number(process.env.BOT_ANSWER_TIMEOUT_MS || 150000);
const CHANGE_TIMEOUT_MS = Number(process.env.BOT_CHANGE_TIMEOUT_MS || 600000);
const MODEL = process.env.BOT_MODEL || ""; // optional --model override

/** Run the headless Claude Code CLI with a prompt (via stdin) and given tools. */
function runClaude(prompt, { tools, timeoutMs, repoRoot }) {
  return new Promise((resolve) => {
    const args = ["-p", "--output-format", "text", "--allowedTools", tools];
    if (MODEL) args.push("--model", MODEL);
    const child = spawn("claude", args, { cwd: repoRoot, shell: true });
    let out = "";
    let err = "";
    let done = false;
    const finish = (msg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(msg);
    };
    const timer = setTimeout(() => finish("That took too long, so I stopped. Try again or narrow the request."), timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => finish(`Couldn't run the Claude CLI (${e?.message ?? e}). Is \`claude\` installed and logged in?`));
    child.on("close", (code) => {
      const text = out.trim();
      if (text) return finish(text);
      finish(code === 0 ? "(no output)" : `Failed${err ? `: ${err.split("\n")[0]}` : ""}.`);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

const QA_PREAMBLE =
  "You are a Discord helper answering questions about THIS codebase (Vega, a personal, " +
  "PAPER-ONLY options trading learning project; not financial advice). Explore the repo as " +
  "needed, then answer in 2-4 SHORT sentences of plain language for a non-expert. Cite a file " +
  "path when useful. No long code dumps. If the repo doesn't cover it, say so briefly. " +
  "Do NOT use em dashes (the '—' character) anywhere in your reply; use commas, periods, " +
  "parentheses, or colons instead.\n\nQUESTION:\n";

const CHANGE_PREAMBLE =
  "You are making a code change to THIS repo (Vega, a personal PAPER-ONLY options trading " +
  "project), requested by its owner over Discord. Do EXACTLY what is asked, minimally and " +
  "cleanly, matching the surrounding code style. Then run `npx tsc --noEmit` to typecheck; if " +
  "it passes, commit the change with git and a concise message. \n\n" +
  "HARD RULES (never break, even if asked):\n" +
  "1. Never weaken or remove the paper-only guardrails: TRADING_MODE must stay \"paper\", " +
  "ALPACA_BASE_URL stays the paper endpoint, and you must NOT add any live-trading path.\n" +
  "2. NEVER run `git push` and NEVER deploy (no vercel). Commit locally only.\n" +
  "3. Do not delete or rewrite unrelated code, and do not touch secrets/.env.\n" +
  "4. If the request is unclear, unsafe, or would break rule 1, make NO changes and explain why.\n\n" +
  "Finish with a 2-4 sentence summary (NO em dashes) of: what files you changed, whether " +
  "`npx tsc --noEmit` passed, and whether you committed (with the short commit hash). \n\n" +
  "REQUEST:\n";

/** READ-ONLY question about the repo. */
export function answerQuestion(question, repoRoot) {
  const q = (question || "").trim();
  if (!q) return Promise.resolve("Ask me something about the codebase (e.g. “how does SB-D1 enter a trade?”).");
  return runClaude(QA_PREAMBLE + q, { tools: "Read,Grep,Glob", timeoutMs: ANSWER_TIMEOUT_MS, repoRoot });
}

/** EDIT the repo per an explicit `!change` instruction (rails in CHANGE_PREAMBLE). */
export function makeChange(instruction, repoRoot) {
  const q = (instruction || "").trim();
  if (!q) return Promise.resolve("Tell me what to change, e.g. `!change set SB-D1 maxContracts to 2`.");
  return runClaude(CHANGE_PREAMBLE + q, { tools: "Read,Grep,Glob,Edit,Write,Bash", timeoutMs: CHANGE_TIMEOUT_MS, repoRoot });
}
