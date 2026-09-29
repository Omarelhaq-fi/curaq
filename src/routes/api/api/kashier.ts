// Auth-gated Kashier endpoints: quote, create-session, cancel, status.

import { createFileRoute } from "@tanstack/react-router";
import { verifyFirebaseIdToken } from "@/lib/firebase.server";
import { getCorsHeaders } from "@/lib/cors";
import { getClientIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit.server";
import {
  detectCurrencyFromRequest,
  getPrice,
  isCurrency,
  isPayablePlan,
  listPrices,
  type Currency,
  type PayablePlan,
} from "@/lib/pricing.server";
import { buildCheckoutUrl, getKashierConfig } from "@/lib/kashier.server";
import { cancelAtPeriodEnd, getSubscription, shopperRefFor, savePendingOrder } from "@/lib/subscriptions.server";
import { loadPaymentsSettings } from "@/lib/payments-settings.server";
import { loadAuthSettings } from "@/lib/auth-settings.server";

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

async function requireAuth(request: Request) {
  const auth = request.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Response("Unauthorized", { status: 401 });
  return await verifyFirebaseIdToken(m[1]);
}

function originFromRequest(request: Request): string {
  const origin = request.headers.get("origin");
  if (origin) return origin;
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function newOrderId(uid: string, plan: PayablePlan): string {
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const shortUid = uid.slice(0, 8);
  return `omn_${plan}_${shortUid}_${rand}`;
}

export const Route = createFileRoute("/api/kashier")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, POST, OPTIONS" });
        return new Response(null, { status: 204, headers: cors });
      },

      GET: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, POST, OPTIONS" });
        const url = new URL(request.url);
        const action = url.searchParams.get("action") || "";

        if (action === "quote") {
          // Public — no auth needed, so landing page can render currency-aware prices.
          const currencyParam = url.searchParams.get("currency");
          const currency: Currency =
            isCurrency(currencyParam) ? currencyParam : detectCurrencyFromRequest(request);
          const settings = await loadPaymentsSettings();
          return json({
            ...listPrices(currency),
            configured: getKashierConfig().configured && settings.enabled,
            paymentsEnabled: settings.enabled,
            paymentsReason: settings.enabled ? "" : settings.reason,
            allowedPlans: settings.allowedPlans,
            allowedCurrencies: settings.allowedCurrencies,
          }, 200, cors);
        }

        if (action === "status") {
          let user;
          try { user = await requireAuth(request); }
          catch { return json({ error: "Unauthorized" }, 401, cors); }
          const sub = await getSubscription(user.sub);
          return json({ subscription: sub, configured: getKashierConfig().configured }, 200, cors);
        }

        return json({ error: "Bad request" }, 400, cors);
      },

      POST: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, POST, OPTIONS" });
        const ip = getClientIp(request);
        const rl = rateLimit(`kashier:ip:${ip}`, 60_000, 30);
        if (!rl.ok) return rateLimitResponse(rl.retryAfter, cors);

        let user;
        try { user = await requireAuth(request); }
        catch { return json({ error: "Unauthorized" }, 401, cors); }

        const userLimit = rateLimit(`kashier:uid:${user.sub}`, 60_000, 10);
        if (!userLimit.ok) return rateLimitResponse(userLimit.retryAfter, cors);

        let body: { action?: string; plan?: string; currency?: string };
        try { body = await request.json() as typeof body; }
        catch { return json({ error: "Bad request" }, 400, cors); }

        const cfg = getKashierConfig();

        if (body.action === "create_session") {
          // Require a verified email before creating a payment session so an
          // attacker can't pay for an account whose email they don't own
          // (and later use the refund/dispute path against the real owner).
          const authPolicy = await loadAuthSettings();
          if (authPolicy.requireEmailVerification && user.email_verified === false) {
            return json({
              error: "Please verify your email address before subscribing. Check your inbox for the verification link (or resend it from your profile).",
              reason: "email_not_verified",
            }, 403, cors);
          }
          const settings = await loadPaymentsSettings();
          if (!settings.enabled) {
            return json({ error: settings.reason || "Payments are disabled.", reason: "disabled" }, 503, cors);
          }
          if (!cfg.configured) {
            return json({
              error: "Payments are not configured yet. Please contact contact@omnote.app.",
              reason: "not_configured",
            }, 503, cors);
          }
          const plan = body.plan;
          if (!isPayablePlan(plan)) return json({ error: "Bad request" }, 400, cors);
          if (!settings.allowedPlans[plan]) {
            return json({ error: `The ${plan === "pro" ? "Supporter" : "Supporter+"} plan is currently unavailable.`, reason: "plan_disabled" }, 503, cors);
          }
          const currency: Currency =
            isCurrency(body.currency) ? body.currency : detectCurrencyFromRequest(request);
          if (!settings.allowedCurrencies[currency]) {
            return json({ error: `Payments in ${currency} are currently unavailable.`, reason: "currency_disabled" }, 503, cors);
          }
          const price = getPrice(plan, currency);
          const orderId = newOrderId(user.sub, plan);
          const origin = originFromRequest(request);

          try {
            // Save pending order so the return-URL handler can activate the plan
            // even if Kashier's server-to-server webhook doesn't reach us
            // (test-mode preview URLs, firewalls, etc). The webhook remains the
            // authoritative path when it does arrive — activation is idempotent.
            try {
              await savePendingOrder(orderId, {
                uid: user.sub,
                plan,
                currency: price.currency,
                amount: price.amount,
                createdAt: Date.now(),
              });
            } catch (e) {
              console.warn("[kashier] savePendingOrder failed:", (e as Error).message);
            }

            const url = await buildCheckoutUrl({
              orderId,
              amount: price.amount,
              currency: price.currency,
              merchantRedirect: `${origin}/api/public/kashier/return?orderId=${encodeURIComponent(orderId)}`,
              failureRedirect: `${origin}/api/public/kashier/return?orderId=${encodeURIComponent(orderId)}&failed=1`,
              serverWebhook: `${origin}/api/public/kashier/webhook`,
              enableRecurring: true,
              shopperReference: shopperRefFor(user.sub),
              customerEmail: user.email || "",
              displayLang: currency === "EGP" ? "ar" : "en",
              metaData: {
                uid: user.sub,
                plan,
                email: user.email || "",
              },
            });
            return json({ url, orderId, price }, 200, cors);
          } catch (e) {
            console.error("[kashier] create_session:", (e as Error).message);
            return json({ error: "Could not start checkout" }, 500, cors);
          }
        }

        if (body.action === "cancel") {
          await cancelAtPeriodEnd(user.sub);
          return json({ ok: true }, 200, cors);
        }

        return json({ error: "Bad request" }, 400, cors);
      },
    },
  },
});
