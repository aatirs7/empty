/**
 * Generate PWA / favicon assets from public/icon-source.png.
 * Run: node scripts/gen-icons.mjs
 */
import sharp from "sharp";
import { mkdirSync } from "node:fs";

const SRC = "public/icon-source.png";
mkdirSync("public/icons", { recursive: true });

const targets = [
  { file: "public/icons/icon-192.png", size: 192 },
  { file: "public/icons/icon-512.png", size: 512 },
  { file: "public/icons/apple-touch-icon.png", size: 180 },
  { file: "src/app/icon.png", size: 256 }, // Next.js app favicon
];

for (const t of targets) {
  await sharp(SRC).resize(t.size, t.size, { fit: "cover" }).png().toFile(t.file);
  console.log(`wrote ${t.file} (${t.size}x${t.size})`);
}
console.log("done.");
