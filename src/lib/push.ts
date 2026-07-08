/**
 * Web Push helper. Sends notifications to every subscribed device when a trade is
 * placed or sold. VAPID keys come from env; missing keys make this a safe no-op.
 */
import webpush from "web-push";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { pushSubscriptions } from "../db/schema";

let configured = false;
function configure(): boolean {
  if (configured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:vega@example.com", pub, priv);
  configured = true;
  return true;
}

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

/** Send a push to all subscribed devices. Best-effort; prunes dead subscriptions. */
export async function sendPush(title: string, body: string, url = "/"): Promise<number> {
  if (!configure()) return 0;
  const subs = await db.select().from(pushSubscriptions);
  if (subs.length === 0) return 0;
  const payload = JSON.stringify({ title, body, url });
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number })?.statusCode;
        if (code === 404 || code === 410) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, s.endpoint));
        }
      }
    }),
  );
  return sent;
}
