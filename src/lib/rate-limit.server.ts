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

// IP extraction behind Cloudflare -> Vercel.
// Priority:
//   1. cf-connecting-ip — injected by Cloudflare, cannot be spoofed when the
//      orange cloud is on (authoritative client IP).
//   2. true-client-ip — Cloudflare Enterprise / alternative header.
//   3. x-forwarded-for (first entry) — set by Vercel's edge when requests come
//      direct (pre-cutover) or appended by Cloudflare. Only the leftmost entry
//      added by our trusted edge is used; when behind Cloudflare (1) already
//      won, so this branch mainly serves direct-to-Vercel traffic.
// Falls back to "unknown" (single shared bucket) rather than trusting an
// arbitrary client-supplied value blindly.
export function getClientIp(request: Request): string {
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const tc = request.headers.get("true-client-ip")?.trim();
  if (tc) return tc;
  const xff = request.headers.get("x-forwarded-for")?.trim();
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first && first !== "unknown") return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
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
