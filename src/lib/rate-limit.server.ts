// In-memory sliding-window rate limiter.
// NOTE: scoped per Worker isolate — not globally consistent. Sufficient as a
// first line of defense against casual abuse; upgrade to Durable Objects or
// Firestore-backed counters if determined abuse persists.

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
