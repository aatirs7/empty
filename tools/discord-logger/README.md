# Discord channel logger

It also answers questions when @mentioned and accepts `!change` commands to edit the code from Discord.

A tiny bot that mirrors **one** Discord channel (your general chat) into local files
so Claude Code always has the history, and **auto-downloads attachments** (like the
SB-D1 `.txt`) into `logs/attachments/`.

- Scope: only the channel you point it at. It does **not** read your other channels or DMs.
- Privacy: `.env` and `logs/` are gitignored — your token and chat never get committed.
- TOS-safe: it's a real bot in your server, not your personal account.

## One-time setup (~5 min, Discord side)

1. **Create the bot app:** https://discord.com/developers/applications → **New Application** → name it (e.g. "Vega Logger").
2. Left sidebar → **Bot** → **Reset Token** → copy the token (you'll paste it into `.env`). Keep it private.
3. Same **Bot** page → scroll to **Privileged Gateway Intents** → turn **Message Content Intent** ON. *(Required, or message text comes through empty.)*
4. Left sidebar → **OAuth2 → URL Generator** → scope **`bot`** → bot permissions: **View Channel**, **Read Message History** (and **Send Messages** if you want `!sync` replies). Copy the generated URL, open it, and add the bot to your server.
5. Move the bot into (or give it access to) your **general** channel.
6. In Discord: **Settings → Advanced → Developer Mode** ON. Right-click the general channel → **Copy Channel ID**.

## Configure + run (this folder)

```bash
cd tools/discord-logger
cp .env.example .env        # then paste your token + channel id into .env
npm install
npm start                   # backfills recent history, then logs live
```

- `npm start` — backfill the last ~200 messages, then stay running and log new ones.
- `npm run sync` — backfill once and exit (good before a Claude session; no need to leave it running).
- In the channel, typing `!sync 300` pulls the last 300 on demand.

## Command cheat sheet

**In the terminal (to run the bot):**
| Command | What it does |
|---|---|
| `npm start` | Start the bot: logs messages live, answers questions, makes changes. Leave it open. |
| `npm run sync` | Backfill recent messages into the log, then exit (no live listen). |
| `Ctrl + C` | Stop the bot. |

**In Discord — you must @mention the bot each time (including follow-ups):**
| You type | What happens |
|---|---|
| `@bot how does X work?` | Short answer from the code. No changes. |
| `@bot add/change/fix/do X` | Edits the code, typechecks, commits **locally**, then asks "push or edits?" |
| `@bot push` | Pushes the pending change to GitHub. (also: "ship it", "deploy", "go ahead", "lgtm") |
| `@bot undo` | Reverts the pending change, nothing pushed. (also: "cancel", "revert", "scrap", "nvm") |
| `@bot <more edits>` | After a change, any other reply = make those extra edits, then ask again. |
| `!sync 300` | (no @ needed) Backfill the last 300 messages into the log on demand. |

Notes: it decides "question vs change" from your wording (no exact keyword needed). A
change takes ~1-3 min; it posts "👀 On it…" first. It never pushes/deploys on its own
and never weakens the paper-only guardrails.

## Ask it questions (@mention)

@mention the bot with a question and it answers from **this codebase**, e.g.:

> @Vega Assistant how does SB-D1 decide to enter a trade?

Under the hood it runs the **Claude Code CLI** (`claude -p`) on **your Claude
subscription** — it explores the repo itself and replies in 2–4 sentences. **No API
key, no per-message charge** (it does use your plan's Claude Code usage, shared with
normal dev — so it's "no extra $", not unlimited).

Requirements:
- The `claude` CLI installed and logged in on the machine running the bot (already
  true if you use Claude Code here).
- The bot has **Send Messages** permission in the channel (add it in the channel's
  permissions if replies fail).
- The bot must be **running** (`npm start`) to answer live.

## What Claude reads

- `logs/general.md` — readable transcript (newest appended at the bottom).
- `logs/general.jsonl` — same data, one JSON object per message (for querying).
- `logs/attachments/` — every file posted, saved as `<messageId>_<filename>`.

Point me at `tools/discord-logger/logs/general.md` (or an attachment path) any session.

## Notes

- To capture messages in real time, leave `npm start` running (a terminal, or a
  process manager). If you'd rather not keep it on, just run `npm run sync` before a
  session — it grabs whatever's new since last time.
- It has its own `package.json`, so `discord.js` never touches the main app or the
  Vercel build.
