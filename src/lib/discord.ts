/**
 * Discord webhook delivery. Posts the daily report as a short summary embed plus
 * the FULL detailed report attached as a Markdown file (no length limits, so
 * "literally every activity" fits). Needs DISCORD_WEBHOOK_URL; a missing URL is a
 * safe no-op that reports back so the caller can surface "not configured".
 */
export interface DiscordEmbed {
  title: string;
  description?: string;
  color?: number; // decimal RGB
  fields?: { name: string; value: string; inline?: boolean }[];
}

export interface DiscordResult {
  ok: boolean;
  status: number;
  error?: string;
}

export async function postDiscordReport(embed: DiscordEmbed, fullMarkdown: string, filename: string, content = ""): Promise<DiscordResult> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return { ok: false, status: 0, error: "DISCORD_WEBHOOK_URL not set" };

  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({ username: "Vega", content: content.slice(0, 2000), embeds: [{ ...embed, color: embed.color ?? 0x5865f2 }] }),
  );
  form.append("files[0]", new Blob([fullMarkdown], { type: "text/markdown" }), filename);

  try {
    const r = await fetch(url, { method: "POST", body: form });
    return { ok: r.ok, status: r.status, error: r.ok ? undefined : (await r.text().catch(() => "")).slice(0, 200) };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "post failed" };
  }
}
