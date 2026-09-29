// Kashier.io payment helpers.
//
// Env vars (add later as secrets):
//   KASHIER_MERCHANT_ID     - e.g. MID-XXXX-XXX
//   KASHIER_API_KEY         - Payment API Key from the Integrations section
//   KASHIER_SECRET_KEY      - Secret Key used in the Payment Sessions Authorization header
//   KASHIER_MODE            - "test" | "live"  (default "test")
//
// Docs: https://developers.kashier.io/payment/payment-sessions

export type KashierMode = "test" | "live";

export type KashierConfig = {
  merchantId: string;
  apiKey: string;
  iframeSecret: string;
  webhookSecret: string;
  mode: KashierMode;
  configured: boolean;
};

export function getKashierConfig(): KashierConfig {
  const merchantId = process.env.KASHIER_MERCHANT_ID || "";
  const apiKey = process.env.KASHIER_API_KEY || "";
  // Payment Sessions use Secret Key for Authorization and Payment API Key for
  // the api-key header. Kashier signs webhook payloads with the Payment API Key.
  const secret =
    process.env.KASHIER_SECRET_KEY ||
    process.env.KASHIER_IFRAME_SECRET ||
    process.env.KASHIER_WEBHOOK_SECRET ||
    "";
  const mode = (process.env.KASHIER_MODE === "live" ? "live" : "test") as KashierMode;
  return {
    merchantId,
    apiKey,
    iframeSecret: secret,
    webhookSecret: apiKey || secret,
    mode,
    configured: Boolean(merchantId && apiKey && secret),
  };
}


// Hex-encoded HMAC-SHA256 using Web Crypto (runs on Workers).
async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  return timingSafeEqual(a, b);
}

// HPP order hash per Kashier docs:
//   path = `/?payment=<MID>.<OrderId>.<Amount>.<Currency>`
//   hash = HMAC_SHA256(iframeSecret, path)  (hex)
export async function buildHppHash(params: {
  merchantId: string;
  orderId: string;
  amount: string;    // e.g. "9.00"
  currency: string;  // "USD" | "EGP"
  iframeSecret: string;
}): Promise<string> {
  const path = `/?payment=${params.merchantId}.${params.orderId}.${params.amount}.${params.currency}`;
  return hmacHex(params.iframeSecret, path);
}

export type BuildCheckoutUrlInput = {
  orderId: string;
  amount: number;         // major units
  currency: "USD" | "EGP";
  merchantRedirect: string;
  serverWebhook: string;
  failureRedirect?: string;
  metaData?: Record<string, string | number>;
  enableRecurring?: boolean;
  shopperReference?: string;   // stable per-user for tokenization
  displayLang?: "en" | "ar";
  customerEmail?: string;
};

type KashierSessionResponse = {
  _id?: string;
  sessionUrl?: string;
  paymentUrl?: string;
  url?: string;
  data?: {
    _id?: string;
    sessionUrl?: string;
    paymentUrl?: string;
    url?: string;
  };
  response?: {
    _id?: string;
    sessionUrl?: string;
    paymentUrl?: string;
    url?: string;
  };
};

function getPaymentSessionUrl(raw: KashierSessionResponse): string {
  return (
    raw.sessionUrl ||
    raw.paymentUrl ||
    raw.url ||
    raw.data?.sessionUrl ||
    raw.data?.paymentUrl ||
    raw.data?.url ||
    raw.response?.sessionUrl ||
    raw.response?.paymentUrl ||
    raw.response?.url ||
    ""
  );
}

export async function buildCheckoutUrl(input: BuildCheckoutUrlInput): Promise<string> {
  const cfg = getKashierConfig();
  if (!cfg.configured) throw new Error("Kashier is not configured");
  const amountStr = input.amount.toFixed(2);
  const endpoint = cfg.mode === "live"
    ? "https://api.kashier.io/v3/payment/sessions"
    : "https://test-api.kashier.io/v3/payment/sessions";
  const expireAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const body: Record<string, unknown> = {
    merchantId: cfg.merchantId,
    order: input.orderId,
    amount: amountStr,
    currency: input.currency,
    expireAt,
    maxFailureAttempts: 3,
    paymentType: "credit",
    type: "one-time",
    merchantRedirect: input.merchantRedirect,
    serverWebhook: input.serverWebhook,
    display: input.displayLang || "en",
    redirectMethod: "get",
    failureRedirect: false,
    brandColor: "#2f6df6",
    description: `OmNote ${String(input.metaData?.plan || "subscription")}`,
    interactionSource: "ECOMMERCE",
    metaData: input.metaData || {},
  };

  if (input.customerEmail || input.shopperReference) {
    body.customer = {
      email: input.customerEmail || undefined,
      reference: input.shopperReference || input.customerEmail || undefined,
    };
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: cfg.iframeSecret,
      "api-key": cfg.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let raw: KashierSessionResponse | string = text;
  try {
    raw = JSON.parse(text) as KashierSessionResponse;
  } catch {
    // Keep raw text for logging below.
  }

  if (!response.ok) {
    const detail = typeof raw === "string" ? raw : JSON.stringify(raw);
    throw new Error(`Kashier session API failed ${response.status}: ${detail.slice(0, 240)}`);
  }

  if (typeof raw === "string") {
    throw new Error("Kashier session API returned a non-JSON response");
  }

  const url = getPaymentSessionUrl(raw);
  if (!url) {
    throw new Error(`Kashier session API response did not include a checkout URL: ${JSON.stringify(raw).slice(0, 240)}`);
  }

  return url;
}


// ---------- Webhook signature verification ----------
//
// Kashier posts a body of shape:
//   { data: { ...fields..., signatureKeys: [ ... ], signature: "<hex>" } }
// The signature is HMAC-SHA256 of a canonical query-string built from the
// listed signature keys joined with `&`, using the merchant API key.
//
// Fallback (older/newer variants): if `signatureKeys` is missing, sign all
// primitive top-level keys sorted alphabetically excluding `signature` and
// `signatureKeys`. We accept either the header `x-kashier-signature` or the
// body `data.signature` field.

type Primitive = string | number | boolean;
type KashierWebhookPayload = {
  data?: Record<string, unknown> & {
    signature?: string;
    signatureKeys?: string[];
  };
  event?: string;
};

function primitiveToString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  return null;
}

export async function verifyKashierWebhook(
  rawBody: string,
  request: Request,
): Promise<{ ok: boolean; payload: KashierWebhookPayload | null; reason?: string }> {
  const cfg = getKashierConfig();
  if (!cfg.webhookSecret) return { ok: false, payload: null, reason: "webhook_secret_missing" };
  let payload: KashierWebhookPayload;
  try { payload = JSON.parse(rawBody) as KashierWebhookPayload; }
  catch { return { ok: false, payload: null, reason: "bad_json" }; }

  const data = payload.data || {};
  const signatureFromBody = typeof data.signature === "string" ? data.signature : "";
  const signatureFromHeader = request.headers.get("x-kashier-signature") || "";
  const providedSig = (signatureFromBody || signatureFromHeader).toLowerCase();
  if (!providedSig) return { ok: false, payload, reason: "no_signature" };

  let keys: string[] = Array.isArray(data.signatureKeys)
    ? data.signatureKeys.filter((k): k is string => typeof k === "string")
    : [];
  if (keys.length === 0) {
    keys = Object.keys(data)
      .filter((k) => k !== "signature" && k !== "signatureKeys")
      .filter((k) => primitiveToString((data as Record<string, unknown>)[k]) !== null)
      .sort();
  }

  const pairs: string[] = [];
  for (const k of keys) {
    const v = primitiveToString((data as Record<string, unknown>)[k]);
    if (v !== null) pairs.push(`${k}=${encodeURIComponent(v).replace(/%20/g, "%20")}`);
  }
  const canonical = pairs.join("&");

  const expected = (await hmacHex(cfg.webhookSecret, canonical)).toLowerCase();
  if (!timingSafeEqualHex(expected, providedSig)) {
    return { ok: false, payload, reason: "bad_signature" };
  }
  return { ok: true, payload };
}

// Verify HPP return URL: Kashier appends `signature` to the query. Rebuild the
// hash from returned fields and compare.
export async function verifyReturnParams(url: URL): Promise<boolean> {
  const cfg = getKashierConfig();
  const signingKey = cfg.webhookSecret || cfg.iframeSecret;
  if (!signingKey) return false;
  const sig = (url.searchParams.get("signature") || "").toLowerCase();
  if (!sig) return false;

  const keys: string[] = [];
  url.searchParams.forEach((_v, k) => {
    if (k !== "signature" && k !== "mode") keys.push(k);
  });
  keys.sort();
  const canonical = keys.map((k) => `${k}=${url.searchParams.get(k) ?? ""}`).join("&");
  const expected = (await hmacHex(signingKey, canonical)).toLowerCase();
  return timingSafeEqualHex(expected, sig);
}

// ---------- Server-side order status lookup ----------
// Best-effort defense-in-depth check on top of HMAC signature verification.
// Kashier's v3 order lookup returns the current authoritative status for a
// merchant order. We accept the result when it returns a clear success state,
// and fall back to signature-only verification if the API call fails (so a
// transient upstream error can't block legitimate activations).
export type OrderStatusCheck =
  | { checked: true; success: boolean; status: string }
  | { checked: false; reason: string };

export async function getKashierOrderStatus(orderId: string): Promise<OrderStatusCheck> {
  const cfg = getKashierConfig();
  if (!cfg.configured) return { checked: false, reason: "not_configured" };
  const base = cfg.mode === "live" ? "https://api.kashier.io" : "https://test-api.kashier.io";
  const url = `${base}/v3/orders/${encodeURIComponent(orderId)}?merchantId=${encodeURIComponent(cfg.merchantId)}`;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: cfg.iframeSecret,
        "api-key": cfg.apiKey,
        Accept: "application/json",
      },
    });
    const text = await resp.text();
    if (!resp.ok) return { checked: false, reason: `http_${resp.status}` };
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { return { checked: false, reason: "bad_json" }; }
    const d = data as { status?: string; response?: { status?: string; state?: string }; state?: string };
    const status = String(
      d.status || d.response?.status || d.state || d.response?.state || "",
    ).toUpperCase();
    const success = ["SUCCESS", "PAID", "CAPTURED", "COMPLETED", "APPROVED"].includes(status);
    return { checked: true, success, status };
  } catch (e) {
    return { checked: false, reason: (e as Error).message };
  }
}

// ---------- Tokenized recurring charge ----------
// Charges a stored card token for a returning subscriber. Uses Kashier's
// tokenized charge endpoint. If the endpoint schema changes, tune here.
export type ChargeInput = {
  orderId: string;
  amount: number;
  currency: "USD" | "EGP";
  cardToken: string;
  shopperReference: string;
  metaData?: Record<string, Primitive>;
};

export type ChargeResult =
  | { ok: true; kashierReference: string; raw: unknown }
  | { ok: false; status: number; error: string; raw: unknown };

export async function chargeWithToken(input: ChargeInput): Promise<ChargeResult> {
  const cfg = getKashierConfig();
  if (!cfg.configured) return { ok: false, status: 500, error: "kashier_not_configured", raw: null };
  const url = "https://api.kashier.io/v3/orders/";
  const body = {
    merchantId: cfg.merchantId,
    orderId: input.orderId,
    amount: input.amount.toFixed(2),
    currency: input.currency,
    cardToken: input.cardToken,
    shopperReference: input.shopperReference,
    metaData: input.metaData || {},
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: cfg.apiKey,
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let raw: unknown = null;
  try { raw = JSON.parse(text); } catch { raw = text; }
  if (!resp.ok) {
    return { ok: false, status: resp.status, error: `charge_failed_${resp.status}`, raw };
  }
  const parsed = raw as { orderReference?: string; response?: { orderReference?: string } };
  const ref = parsed?.orderReference || parsed?.response?.orderReference || input.orderId;
  return { ok: true, kashierReference: ref, raw };
}
