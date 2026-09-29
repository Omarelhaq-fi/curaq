// Kashier server-to-server webhook.
// Verifies HMAC signature, then activates / marks past_due based on event.
// Idempotent via order ID: repeat events for the same order won't stack days.

import { createFileRoute } from "@tanstack/react-router";
import { verifyKashierWebhook } from "@/lib/kashier.server";
import { activateSubscription, markPastDue, getSubscription } from "@/lib/subscriptions.server";
import { isPayablePlan, isCurrency, type PayablePlan, type Currency } from "@/lib/pricing.server";

export const Route = createFileRoute("/api/public/kashier/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        const verified = await verifyKashierWebhook(raw, request);
        if (!verified.ok) {
          console.warn("[kashier:webhook] rejected:", verified.reason);
          return new Response("Invalid signature", { status: 401 });
        }
        const data = (verified.payload?.data || {}) as Record<string, unknown>;
        const event = String(verified.payload?.event || data.status || "").toLowerCase();

        const meta =
          (data.metaData as Record<string, unknown> | undefined) ||
          (data.metadata as Record<string, unknown> | undefined) ||
          {};
        const uid = typeof meta.uid === "string" ? meta.uid : "";
        const planRaw = typeof meta.plan === "string" ? meta.plan : "";
        if (!uid || !isPayablePlan(planRaw)) {
          console.warn("[kashier:webhook] missing uid/plan in metaData; ignoring");
          return new Response("ok"); // don't retry
        }
        const plan: PayablePlan = planRaw;
        const currencyRaw = data.currency;
        const currency: Currency = isCurrency(currencyRaw) ? currencyRaw : "USD";
        const amount = Number(data.amount || 0);
        const orderId = String(data.orderReference || data.orderId || data.merchantOrderId || "");
        const kashierRef = String(data.kashierOrderId || data.orderReference || orderId);
        const cardToken =
          typeof data.cardToken === "string" ? data.cardToken :
          typeof (data.card as Record<string, unknown> | undefined)?.token === "string"
            ? String((data.card as Record<string, unknown>).token)
            : null;
        const shopperReference = typeof data.shopperReference === "string" ? data.shopperReference : null;

        const isSuccess =
          event.includes("success") || event === "paid" || event === "captured" ||
          String(data.status || "").toUpperCase() === "SUCCESS";
        const isFailure =
          event.includes("fail") || event.includes("declin") ||
          String(data.status || "").toUpperCase() === "FAILED";

        try {
          if (isSuccess) {
            // Idempotency: if we already activated this exact orderId, skip.
            const existing = await getSubscription(uid);
            if (existing && existing.kashierOrderId === orderId && existing.status === "active") {
              return new Response("ok");
            }
            await activateSubscription({
              uid, plan, currency, amount,
              kashierOrderId: orderId,
              kashierReference: kashierRef,
              cardToken,
              shopperReference,
            });
          } else if (isFailure) {
            await markPastDue(uid);
          }
        } catch (e) {
          console.error("[kashier:webhook] handler error:", (e as Error).message);
          return new Response("Server error", { status: 500 });
        }

        return new Response("ok");
      },
    },
  },
});
