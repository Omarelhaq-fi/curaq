// Rate limiting.
//
// `rateLimit()` is a fast in-memory sliding window. It is scoped per Worker
// isolate, so it is only a first line of defense: an attacker spreading
// requests across isolates can multiply the effective limit by the number of
// isolates.
//
// `rateLimitGlobal()` adds a cross-isolate fixed-window counter in Firestore
// (one tiny doc per key, reused every window and TTL-expired via `expiresAt`).
// It is used for the high-value choke points where a per-isolate limit is not
// enough: DRM key issuance, onboarding, AI calls, payments and support-ticket
// creation. The in-memory check still runs first, so abusive bursts are
// rejected without touching Firestore.
//
// Kill switch: set RATE_LIMIT_GLOBAL=off in the Worker environment to fall
// back to the per-isolate limiter only (useful during a Firestore incident).

import { getServiceAccount, getGoogleAccessToken } from "./firebase.server";

type Bucket = { hits: number[] };
const store = new Map<string, Bucket>();

// Cheap GC to keep the map bounded.
let lastGc = 0;
function maybeGc(now: number) {
  if (now - lastGc < 60_000) return;
  lastGc = now;
  const cutoff = now - 10 * 60_000;
  for (const [k, b] of store) {
    b.hits = b.hits.filter((t) => t >= cutoff);
    if (b.hits.length === 0) store.delete(k);
  }
}

export type RateResult = { ok: true } | { ok: false; retryAfter: number };

export function rateLimit(key: string, windowMs: number, max: number): RateResult {
  const now = Date.now();
  maybeGc(now);
  const cutoff = now - windowMs;
  let b = store.get(key);
  if (!b) {
    b = { hits: [] };
    store.set(key, b);
  }
  b.hits = b.hits.filter((t) => t >= cutoff);
  if (b.hits.length >= max) {
    const retryAfter = Math.max(1, Math.ceil((b.hits[0] + windowMs - now) / 1000));
    return { ok: false, retryAfter };
  }
  b.hits.push(now);
  return { ok: true };
}

// Only trust cf-connecting-ip (Cloudflare-injected, cannot be spoofed by the
// client). x-forwarded-for and x-real-ip are client-controllable when the
// request reaches the origin — never use them for rate-limit keys.
export function getClientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

// Convenience: check multiple limits at once. Returns first failing result.
export function checkLimits(
  ...limits: Array<{ key: string; windowMs: number; max: number }>
): RateResult {
  for (const l of limits) {
    const r = rateLimit(l.key, l.windowMs, l.max);
    if (!r.ok) return r;
  }
  return { ok: true };
}

export function rateLimitResponse(retryAfter: number, corsHeaders: Record<string, string>): Response {
  return new Response(
    JSON.stringify({ error: "Too many requests. Please slow down.", retryAfter }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(retryAfter),
        ...corsHeaders,
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Cross-isolate limiter (Firestore fixed window)
// ---------------------------------------------------------------------------

// Total time budget for one global check (token + read + retries). Keeps a
// Firestore slowdown from stalling user requests.
const GLOBAL_DEADLINE_MS = 3_000;
const GLOBAL_FETCH_TIMEOUT_MS = 1_500;
const GLOBAL_MAX_ATTEMPTS = 3;
const GLOBAL_COLLECTION = "rate_limits";

type GlobalWriteResult = "ok" | "conflict";

function timeoutSignal(deadline: number): AbortSignal {
  const remaining = Math.max(1, deadline - Date.now());
  return AbortSignal.timeout(Math.min(GLOBAL_FETCH_TIMEOUT_MS, remaining));
}

function globalLimiterDisabled(): boolean {
  try {
    return String(process.env.RATE_LIMIT_GLOBAL || "").toLowerCase() === "off";
  } catch {
    return false;
  }
}

async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 40);
}

function writeBucket(
  documentsBase: string,
  token: string,
  docId: string,
  precondition: Record<string, unknown>,
  windowStart: number,
  windowMs: number,
  count: number,
  deadline: number,
): Promise<GlobalWriteResult> {
  const expiresAt = new Date(windowStart + windowMs + 5 * 60_000).toISOString();
  return fetch(`${documentsBase}:commit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      writes: [
        {
          update: {
            name: `${documentsBase}/${GLOBAL_COLLECTION}/${docId}`,
            fields: {
              windowStart: { integerValue: String(windowStart) },
              count: { integerValue: String(count) },
              // Firestore TTL can delete idle counters if a TTL policy is set
              // on the `rate_limits` collection group for this field. Without
              // one, docs are reused every window and storage stays bounded by
              // the number of distinct keys.
              expiresAt: { timestampValue: expiresAt },
            },
          },
          updateMask: { fieldPaths: ["windowStart", "count", "expiresAt"] },
          currentDocument: precondition,
        },
      ],
    }),
    signal: timeoutSignal(deadline),
  }).then((res) => {
    if (res.ok) return "ok";
    // 400/409/412 = the doc changed between our read and write (or a
    // precondition failed). Retry with a fresh read.
    if (res.status === 400 || res.status === 409 || res.status === 412) return "conflict";
    throw new Error(`rate-limit write failed (${res.status})`);
  });
}

async function checkGlobal(key: string, windowMs: number, max: number): Promise<RateResult | null> {
  const deadline = Date.now() + GLOBAL_DEADLINE_MS;
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const documentsBase = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
  const docId = `rl_${await hashKey(key)}`;

  for (let attempt = 0; attempt < GLOBAL_MAX_ATTEMPTS; attempt++) {
    if (Date.now() >= deadline) return null;
    const now = Date.now();
    // Fixed window start: shared by every isolate, so all of them count
    // against the same bucket.
    const windowStart = Math.floor(now / windowMs) * windowMs;

    const read = await fetch(`${documentsBase}/${GLOBAL_COLLECTION}/${docId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: timeoutSignal(deadline),
    });

    if (read.status === 404) {
      const written = await writeBucket(documentsBase, token, docId, { exists: false }, windowStart, windowMs, 1, deadline);
      if (written === "conflict") continue;
      return { ok: true };
    }
    if (!read.ok) throw new Error(`rate-limit read failed (${read.status})`);

    const doc = (await read.json()) as {
      fields?: Record<string, { integerValue?: string }>;
      updateTime?: string;
    };
    const fields = doc.fields || {};
    const currentStart = parseInt(fields.windowStart?.integerValue || "0", 10) || 0;
    const count = parseInt(fields.count?.integerValue || "0", 10) || 0;
    const updateTime = String(doc.updateTime || "");

    if (!updateTime || currentStart !== windowStart) {
      // First hit of a new window (or a legacy/clock-skewed doc): reset.
      const precondition = updateTime ? { updateTime } : { exists: true };
      const written = await writeBucket(documentsBase, token, docId, precondition, windowStart, windowMs, 1, deadline);
      if (written === "conflict") continue;
      return { ok: true };
    }

    if (count >= max) {
      return {
        ok: false,
        retryAfter: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)),
      };
    }

    const written = await writeBucket(documentsBase, token, docId, { updateTime }, windowStart, windowMs, count + 1, deadline);
    if (written === "conflict") continue;
    return { ok: true };
  }

  // Contention persisted: let the caller fall back to the local result
  // instead of locking a legitimate user out.
  return null;
}

/**
 * Globally-consistent rate limit (best effort).
 *
 * Runs the in-memory limiter first, then a Firestore-backed fixed-window
 * counter shared by every Worker isolate. Call this with `await` for
 * high-value endpoints. If Firestore is unavailable or the global env flag
 * RATE_LIMIT_GLOBAL=off is set, the in-memory result is used.
 */
export async function rateLimitGlobal(key: string, windowMs: number, max: number): Promise<RateResult> {
  const local = rateLimit(key, windowMs, max);
  if (!local.ok) return local;
  if (globalLimiterDisabled()) return local;

  try {
    const global = await checkGlobal(key, windowMs, max);
    return global ?? local;
  } catch (e) {
    console.warn(
      "[rate-limit] global check unavailable; using per-isolate fallback:",
      (e as Error)?.message || e,
    );
    return local;
  }
}
