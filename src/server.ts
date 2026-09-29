import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;
  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;
  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch { return false; }
}

// CSP tuned to the CDNs actually loaded by public/app/index.html.
// NOTE: 'unsafe-eval' removed. If pdf.js/tesseract features break in older
// browsers, re-add only for script-src (never worker-src) after confirming.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://www.gstatic.com https://apis.google.com https://www.google.com https://www.googletagmanager.com",
  "worker-src 'self' blob: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://*.firebase.com https://www.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com https://firebaseappcheck.googleapis.com https://content-firebaseappcheck.googleapis.com https://generativelanguage.googleapis.com https://api.groq.com https://www.youtube.com https://video.google.com wss://*.firebaseio.com",
  "frame-src 'self' https://exora-web.firebaseapp.com https://www.youtube.com https://www.youtube-nocookie.com https://www.google.com https://recaptcha.google.com",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const PERMISSIONS_POLICY = [
  "camera=()", "microphone=()", "geolocation=()", "payment=()",
  "accelerometer=()", "gyroscope=()", "magnetometer=()",
  "usb=()", "bluetooth=()", "serial=()", "midi=()", "hid=()",
  "interest-cohort=()",
].join(", ");

const HTML_SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": PERMISSIONS_POLICY,
};

const BASE_SECURITY_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

// ---------------------------------------------------------------------------
// Cloudflare / Vercel edge caching.
//
// Goal: let Cloudflare absorb all anonymous, cache-safe traffic so Vercel
// only renders (a) logged-in HTML, (b) private APIs, (c) first miss per edge.
//
// What is cached at the edge:
//   - Hashed static assets (/assets/*, /_build/*, /images/optimized/*,
//     /app/assets/*) -> 1y immutable.
//   - favicon/robots/sitemap -> 1 day.
//   - Marketing HTML (/, /qbanks/*, /privacy-policy, /terms-of-service,
//     /refund-policy, /contact-us) for ANONYMOUS GET only -> edge 1h +
//     stale-while-revalidate 1 day. Authenticated requests (Cookie /
//     Authorization header) bypass via private no-store.
// NEVER cached: /login, /onboarding, /app/* HTML, /api/* (unless the route
// itself set an explicit public cache-control, e.g. /api/public/qbanks).
// ---------------------------------------------------------------------------

const PUBLIC_HTML_RE = /^\/(?:qbanks(?:\/.*)?|privacy-policy\/?|terms-of-service\/?|refund-policy\/?|contact-us\/?)?$/;
const PRIVATE_PATH_RE = /^\/(?:login|onboarding|app)(?:\/|$)/;
const IMMUTABLE_PREFIX_RE = /^\/(?:assets|_build|images\/optimized|app\/assets)\//;
const SEO_FILE_RE = /^\/(?:favicon\.png|robots\.txt|sitemap\.xml)$/;
const HASHED_FILE_RE = /\.[a-f0-9]{8,}\.(?:js|css|woff2?|ttf|webp|avif|png|jpe?g|svg|ico)$/i;

function getCdnCacheHeaders(request: Request, response: Response): Record<string, string> {
  // Route set its own policy (public APIs, private R2 payloads) — respect it.
  // Just mirror to cdn-cache-control when the route only set cache-control.
  if (response.headers.has("cache-control")) {
    const cc = response.headers.get("cache-control") || "";
    if (!response.headers.has("cdn-cache-control") && /public/i.test(cc)) {
      return { "cdn-cache-control": cc };
    }
    return {};
  }

  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "cdn-cache-control": "no-store",
    };
  }

  let pathname = "/";
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return {};
  }

  // Error responses are never edge-cached (except 404 HTML falls through to
  // no-store below anyway).
  if (response.status >= 400) {
    return {
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "cdn-cache-control": "no-store",
    };
  }

  // Private APIs + private pages: never CDN-cache.
  if (pathname.startsWith("/api/") || PRIVATE_PATH_RE.test(pathname)) {
    // /api/public/* routes that want caching set their own cache-control and
    // returned early above — reaching here means "do not cache".
    return {
      "cache-control": "private, no-cache, no-store, must-revalidate",
      "cdn-cache-control": "no-store",
    };
  }

  if (IMMUTABLE_PREFIX_RE.test(pathname) || HASHED_FILE_RE.test(pathname)) {
    return {
      "cache-control": "public, max-age=31536000, immutable",
      "cdn-cache-control": "public, max-age=31536000",
    };
  }

  if (SEO_FILE_RE.test(pathname)) {
    return {
      "cache-control": "public, max-age=86400, stale-while-revalidate=86400",
      "cdn-cache-control": "public, max-age=86400",
    };
  }

  const ct = response.headers.get("content-type") || "";
  if (ct.includes("text/html") && PUBLIC_HTML_RE.test(pathname)) {
    // Only cache anonymous renders. Any session cookie / auth header means
    // personalised HTML — bypass the edge.
    const hasCookie = (request.headers.get("cookie") || "").trim() !== "";
    const hasAuth = (request.headers.get("authorization") || "").trim() !== "";
    if (hasCookie || hasAuth) {
      return {
        "cache-control": "private, no-cache, no-store, must-revalidate",
        "cdn-cache-control": "no-store",
      };
    }
    return {
      // Browser revalidates every time (max-age=0) but Cloudflare serves
      // stale-while-revalidate for up to a day — Vercel renders at most
      // once per hour per edge.
      "cache-control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
      "cdn-cache-control": "public, max-age=3600",
      vary: "Cookie, Accept-Encoding",
    };
  }

  return {};
}

function withSecurityHeaders(response: Response, request?: Request): Response {
  const ct = response.headers.get("content-type") || "";
  const isHtml = ct.includes("text/html");
  const extras = isHtml ? HTML_SECURITY_HEADERS : BASE_SECURITY_HEADERS;
  // Return a new response so headers can be added even if original was immutable.
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(extras)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  if (request) {
    const cacheHeaders = getCdnCacheHeaders(request, response);
    for (const [k, v] of Object.entries(cacheHeaders)) {
      if (k === "vary" && headers.has(k)) {
        const existing = headers.get(k) || "";
        const merged = new Set(
          [...existing.split(","), ...v.split(",")].map((s) => s.trim()).filter(Boolean),
        );
        headers.set(k, [...merged].join(", "));
      } else if (!headers.has(k)) {
        headers.set(k, v);
      }
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      const normalized = await normalizeCatastrophicSsrResponse(response);
      return withSecurityHeaders(normalized, request);
    } catch (error) {
      console.error(error);
      return withSecurityHeaders(
        new Response(renderErrorPage(), {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
        request,
      );
    }
  },
};
