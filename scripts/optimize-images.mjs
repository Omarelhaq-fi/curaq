// Build-time image optimization (repo equivalent of "built-in" image CDN:
// responsive WebP variants generated once, served as static files).
// Usage: npm run optimize-images
// Outputs land in public/images/optimized/ and are idempotent
// (skipped when newer than their source).
import { mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "images", "optimized");
mkdirSync(out, { recursive: true });

// [source (relative to public/), stem, widths, webpQuality]
const JOBS = [
  ["images/hero-doctor.jpg", "hero-doctor", [768, 1280, 1920], 78],
  ["images/institutional_doctors_realistic.png", "institutional-doctors", [640, 960], 80],
  ["app/assets/logo.png", "logo", [64, 128], 85],
];

let totalIn = 0;
let totalOut = 0;
for (const [file, stem, widths, quality] of JOBS) {
  const inPath = join(root, "public", ...file.split("/"));
  if (!existsSync(inPath)) {
    console.warn(`[optimize-images] missing ${file}, skipping`);
    continue;
  }
  const inStat = statSync(inPath);
  totalIn += inStat.size;
  const meta = await sharp(inPath).metadata();
  for (const w of widths) {
    if (meta.width && w > meta.width) continue; // never upscale
    const outPath = join(out, `${stem}-${w}.webp`);
    if (existsSync(outPath) && statSync(outPath).mtimeMs >= inStat.mtimeMs) continue;
    const info = await sharp(inPath)
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality, effort: 6 })
      .toFile(outPath);
    totalOut += info.size;
    console.log(`[optimize-images] ${stem}-${w}.webp ${(info.size / 1024).toFixed(0)}kb`);
  }
}
console.log(
  `[optimize-images] done. sources=${(totalIn / 1024).toFixed(0)}kb generated-webp=${(totalOut / 1024).toFixed(0)}kb`,
);
