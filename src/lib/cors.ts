// CORS helpers — origin allowlist instead of wildcard.
// Allows: production/custom domain, any own preview host, localhost in dev only.

const PROJECT_ID = "2674650f-a53a-451a-b7b9-fd9a364016d0";
const STATIC_ORIGINS: string[] = [
  `https://id-preview--${PROJECT_ID}.lovable.app`,
  `https://project--${PROJECT_ID}.lovable.app`,
  `https://project--${PROJECT_ID}-dev.lovable.app`,
  "https://omnote.online",
  "https://www.omnote.online",
];

// Localhost is a dev convenience only — in production it becomes an attack
// surface (malicious local pages / extensions can call the API cross-origin).
// Toggle via NODE_ENV; default fail-closed if unset in prod build.
function isDev(): boolean {
  try {
    if (typeof process !== "undefined" && process.env?.NODE_ENV) {
      return process.env.NODE_ENV !== "production";
    }
  } catch { /* ignore */ }
  // Vite injects import.meta.env.DEV in dev bundles
  try { return Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV); }
  catch { return false; }
}

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  if (STATIC_ORIGINS.includes(origin)) return true;
  if (!isDev()) return false;
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;
  } catch { /* ignore */ }
  return false;
}

export function getCorsHeaders(
  request: Request,
  opts: { methods?: string; headers?: string } = {},
): Record<string, string> {
  const origin = request.headers.get("origin") || "";
  const allowed = isAllowedOrigin(origin);
  const h: Record<string, string> = {
    "access-control-allow-methods": opts.methods || "GET, POST, OPTIONS",
    "access-control-allow-headers": opts.headers || "content-type, authorization, x-firebase-appcheck",
    "access-control-max-age": "86400",
    "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "pragma": "no-cache",
    "expires": "0",
    vary: "Origin",
  };
  if (allowed) h["access-control-allow-origin"] = origin;
  return h;
}
