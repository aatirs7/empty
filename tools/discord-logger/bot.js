/**
 * Discord channel logger — mirrors ONE channel (your general chat) into local files
 * Claude Code can read every session, and auto-downloads attachments (specs, .txt
 * files like the SB-D1 profile) so they never have to be hand-carried again.
 *
 * Scope: only the channel in CHANNEL_ID. It does NOT read your other channels/DMs.
 * Privacy: logs/ and .env are gitignored — chat + token never get committed.
 *
 * Run modes:
 *   npm start            → backfill recent history, then stay live and log new msgs.
 *   npm run sync         → backfill recent history once, then exit (no live listen).
 *
 * Setup steps are in README.md.
 */
import dotenv from "dotenv";
import { mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, GatewayIntentBits, Events } from "discord.js";
import { answerQuestion } from "./answer.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Load .env from THIS folder no matter where the process was launched from, so it
// can be started from the repo root (e.g. Claude running it for you).
dotenv.config({ path: join(HERE, ".env") });
const REPO_ROOT = join(HERE, "..", ".."); // tools/discord-logger → repo root
const LOG_DIR = join(HERE, "logs");
const ATT_DIR = join(LOG_DIR, "attachments");
const JSONL = join(LOG_DIR, "general.jsonl"); // structured, one message per line
const MD = join(LOG_DIR, "general.md"); // human/Claude-readable transcript
const SYNC_ONLY = process.argv.includes("--sync-only");

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const BACKFILL_LIMIT = Number(process.env.BACKFILL_LIMIT ?? 200);

if (!TOKEN || !CHANNEL_ID) {
  console.error("Missing DISCORD_BOT_TOKEN and/or CHANNEL_ID. Copy .env.example to .env and fill them in.");
  process.exit(1);
}

mkdirSync(ATT_DIR, { recursive: true });

// Dedup across restarts: remember which message ids are already logged.
const seen = new Set();
if (existsSync(JSONL)) {
  for (const line of readFileSync(JSONL, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      seen.add(JSON.parse(line).id);
    } catch {
      /* skip a malformed line */
    }
  }
}

async function saveAttachments(msg) {
  const saved = [];
  for (const att of msg.attachments.values()) {
    const safe = `${msg.id}_${(att.name ?? "file").replace(/[^\w.\-]/g, "_")}`;
    const dest = join(ATT_DIR, safe);
    try {
      const res = await fetch(att.url);
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      saved.push({ name: att.name, path: join("logs", "attachments", safe), url: att.url });
    } catch (e) {
      saved.push({ name: att.name, path: null, url: att.url, error: String(e?.message ?? e) });
    }
  }
  return saved;
}

/** Append one message to both the JSONL and the readable Markdown transcript. */
async function logMessage(msg) {
  if (seen.has(msg.id)) return false;
  const attachments = msg.attachments.size ? await saveAttachments(msg) : [];
  const iso = new Date(msg.createdTimestamp).toISOString();
  const rec = {
    id: msg.id,
    ts: msg.createdTimestamp,
    iso,
    author: msg.author?.username ?? "unknown",
    authorId: msg.author?.id ?? null,
    bot: !!msg.author?.bot,
    content: msg.content ?? "",
    attachments,
  };
  appendFileSync(JSONL, JSON.stringify(rec) + "\n");

  let md = `### ${iso} — ${rec.author}\n`;
  if (rec.content) md += `${rec.content}\n`;
  for (const a of attachments) {
    md += a.path ? `📎 **${a.name}** → \`${a.path}\`\n` : `📎 ${a.name} (download failed: ${a.error})\n`;
  }
  md += "\n";
  appendFileSync(MD, md);

  seen.add(msg.id);
  return true;
}

/** Pull the most recent `limit` messages (paginated), oldest-first, into the logs. */
async function backfill(channel, limit) {
  const collected = [];
  let before;
  while (collected.length < limit) {
    const batch = await channel.messages.fetch({ limit: Math.min(100, limit - collected.length), before });
    if (batch.size === 0) break;
    const arr = [...batch.values()]; // newest-first
    collected.push(...arr);
    before = arr[arr.length - 1].id;
    if (batch.size < 100) break;
  }
  collected.reverse(); // write oldest-first so the transcript reads top-to-bottom
  let added = 0;
  for (const m of collected) if (await logMessage(m)) added++;
  return added;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}. Watching channel ${CHANNEL_ID}.`);
  try {
    const channel = await c.channels.fetch(CHANNEL_ID);
    if (!channel?.isTextBased?.()) throw new Error("CHANNEL_ID is not a text channel this bot can see.");
    const added = await backfill(channel, BACKFILL_LIMIT);
    console.log(`Backfilled ${added} new message(s) → ${MD}`);
  } catch (e) {
    console.error("Backfill error:", e?.message ?? e);
  }
  if (SYNC_ONLY) {
    await client.destroy();
    process.exit(0);
  }
  console.log("Live. New messages in that channel will be logged. Ctrl+C to stop.");
});

client.on(Events.MessageCreate, async (msg) => {
  if (msg.channelId !== CHANNEL_ID) return;
  if (msg.author?.id === client.user?.id) return; // don't log our own replies

  // Codebase Q&A: when @mentioned, pull relevant repo context and answer SHORT.
  // Needs Send Messages permission in the channel + ANTHROPIC_API_KEY in .env.
  if (msg.mentions?.has(client.user)) {
    await logMessage(msg); // keep the question in the transcript too
    const question = msg.content.replace(/<@!?\d+>/g, "").trim();
    try {
      await msg.channel.sendTyping();
    } catch {
      /* ignore */
    }
    let answer = await answerQuestion(question, REPO_ROOT);
    if (answer.length > 1900) answer = answer.slice(0, 1900) + " …(truncated)";
    try {
      await msg.reply(answer);
    } catch {
      console.error("Reply failed — does the bot have Send Messages permission in this channel?");
    }
    return;
  }

  // Optional on-demand backfill: type "!sync 300" in the channel.
  const m = msg.content?.match(/^!sync(?:\s+(\d+))?/i);
  if (m) {
    const n = Math.min(1000, Number(m[1] ?? BACKFILL_LIMIT));
    const added = await backfill(msg.channel, n);
    try {
      await msg.reply(`Synced — ${added} new message(s) saved to the local log.`);
    } catch {
      /* missing Send Messages permission is fine; the sync still ran */
    }
    return;
  }
  await logMessage(msg);
});

client.login(TOKEN).catch((e) => {
  console.error("Login failed:", e?.message ?? e);
  console.error("Check DISCORD_BOT_TOKEN, and that 'Message Content Intent' is ON in the Developer Portal.");
  process.exit(1);
});
