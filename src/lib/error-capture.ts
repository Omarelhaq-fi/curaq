// Captures the original Error out-of-band so server.ts can recover the stack
// when h3 has already swallowed the throw into a generic 500 Response.

let lastCapturedError: { error: unknown; at: number } | undefined;
const TTL_MS = 5_000;

// Strip common secret shapes from any string before it lands in Worker logs.
const SECRET_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_\-]{20,}/g,           // Google API keys
  /sk-[A-Za-z0-9_\-]{20,}/g,            // OpenAI-style secrets
  /sk_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe secret keys
  /sb_secret_[A-Za-z0-9_\-]{16,}/g,     // Supabase secret keys
  /gsk_[A-Za-z0-9]{20,}/g,              // Groq keys
  /Bearer\s+[A-Za-z0-9\-_.=]+/gi,       // Bearer tokens
  /eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]+/g, // JWTs
];
function scrub(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}
function scrubError(err: unknown): unknown {
  if (err instanceof Error) {
    const cleaned = new Error(scrub(err.message));
    if (err.stack) cleaned.stack = scrub(err.stack);
    cleaned.name = err.name;
    return cleaned;
  }
  if (typeof err === "string") return scrub(err);
  return err;
}

function record(error: unknown) {
  lastCapturedError = { error: scrubError(error), at: Date.now() };
}

if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("error", (event) => record((event as ErrorEvent).error ?? event));
  globalThis.addEventListener("unhandledrejection", (event) =>
    record((event as PromiseRejectionEvent).reason),
  );
}

export function consumeLastCapturedError(): unknown {
  if (!lastCapturedError) return undefined;
  if (Date.now() - lastCapturedError.at > TTL_MS) {
    lastCapturedError = undefined;
    return undefined;
  }
  const { error } = lastCapturedError;
  lastCapturedError = undefined;
  return error;
}
