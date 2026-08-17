/**
 * Codebase Q&A for the Discord bot — runs on the OWNER'S Claude subscription, NOT
 * the paid pay-per-token API. When someone @mentions the bot, we shell out to the
 * Claude Code CLI in headless print mode (`claude -p`), which explores THIS repo
 * itself (Read/Grep/Glob) and returns a short answer. No API key, no per-call charge.
 *
 * Requirements (already true on the owner's machine): the `claude` CLI is installed
 * and logged in, and the bot runs from a checkout of this repo. It DOES consume the
 * subscription's Claude Code usage (shared with normal dev), so it's "no extra $",
 * not "unlimited".
 */
import { spawn } from "node:child_process";

const TIMEOUT_MS = Number(process.env.BOT_ANSWER_TIMEOUT_MS || 150000);
const MODEL = process.env.BOT_MODEL || ""; // optional --model override (e.g. claude-haiku-4-5-20251001)

const PREAMBLE =
  "You are a Discord helper answering questions about THIS codebase (Vega — a personal, " +
  "PAPER-ONLY options trading learning project; not financial advice). Explore the repo as " +
  "needed, then answer in 2-4 SHORT sentences of plain language for a non-expert. Cite a file " +
  "path when useful. No long code dumps. If the repo doesn't cover it, say so briefly.\n\nQUESTION:\n";

/** Ask the local Claude Code CLI about the repo. Resolves to a short answer string. */
export function answerQuestion(question, repoRoot) {
  return new Promise((resolve) => {
    const q = (question || "").trim();
    if (!q) return resolve("Ask me something about the codebase (e.g. “how does SB-D1 enter a trade?”).");

    const args = ["-p", "--output-format", "text", "--allowedTools", "Read,Grep,Glob"];
    if (MODEL) args.push("--model", MODEL);

    // shell:true so Windows resolves the `claude` command (a .cmd); the prompt is fed
    // via STDIN (not argv), so nothing needs shell-quoting.
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
    const timer = setTimeout(() => finish("That one took too long to look up — try asking something more specific."), TIMEOUT_MS);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => finish(`Couldn't run the Claude CLI (${e?.message ?? e}). Is \`claude\` installed and logged in?`));
    child.on("close", (code) => {
      const text = out.trim();
      if (text) return finish(text);
      finish(code === 0 ? "(no answer)" : `Lookup failed${err ? `: ${err.split("\n")[0]}` : ""}.`);
    });

    child.stdin.write(PREAMBLE + q);
    child.stdin.end();
  });
}
