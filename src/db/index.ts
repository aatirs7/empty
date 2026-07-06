/**
 * Neon Postgres client (Drizzle, HTTP driver).
 * Works both in Next.js server code and in standalone tsx scripts.
 */
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set.");
}

const sql = neon(url);
export const db = drizzle(sql, { schema });
export { schema };
