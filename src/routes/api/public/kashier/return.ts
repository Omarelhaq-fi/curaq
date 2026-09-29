// Browser return URL from Kashier HPP. Activates the subscription from the
// stored pending-order record when payment succeeds AND:
//   1. HMAC signature on the return URL verifies
//   2. Pending order exists, is fresh (< 1h old), and not already activated
//   3. Kashier's order-status API confirms success (best-effort; falls back
//      to signature-only verification when the API is unreachable)
// The signed server-to-server webhook remains the authoritative path.
// Activation is idempotent so double-firing is safe.

import { createFileRoute } from "@tanstack/react-router";
import {
  getPendingOrder,
  getSubscription,
  activateSubscription,
  isPendingOrderFresh,
  markPendingStatus,
} from "@/lib/subscriptions.server";
import { verifyReturnParams, getKashierOrderStatus } from "@/lib/kashier.server";


function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { location: to } });
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  const failed = url.searchParams.get("failed") === "1";
  const status = (
    url.searchParams.get("paymentStatus") ||
    url.searchParams.get("status") ||
    ""
  ).toUpperCase();
  const explicitlyFailed =
    failed ||
    status === "FAILED" ||
    status === "FAILURE" ||
    status === "DECLINED" ||
    status === "CANCELLED" ||
    status === "CANCELED";
  const explicitlySuccess = status === "SUCCESS" || status === "PAID" || status === "CAPTURED";

  const orderId = url.searchParams.get("orderId") || url.searchParams.get("merchantOrderId") || "";
  const kashierRef = url.searchParams.get("orderReference") || url.searchParams.get("transactionId") || orderId;
  const cardToken = url.searchParams.get("cardDataToken") || null;

  let flag = explicitlyFailed ? "checkout_failed=1" : "upgraded=1";
  let activatedPlan: string | null = null;

  if (!explicitlyFailed && explicitlySuccess && orderId) {
    try {
      // 1. Signature must verify — non-negotiable.
      const sigOk = await verifyReturnParams(url);
      if (!sigOk) {
        console.warn("[kashier:return] signature verification failed for", orderId);
        return redirect(`${origin}/#checkout_pending=1`);
      }

      // 2. Pending order must exist, be fresh, and not already activated.
      const pending = await getPendingOrder(orderId);
      if (!pending) {
        console.warn("[kashier:return] no pending order for", orderId);
        return redirect(`${origin}/#checkout_pending=1`);
      }
      if (!isPendingOrderFresh(pending)) {
        console.warn("[kashier:return] pending order expired for", orderId);
        return redirect(`${origin}/#checkout_failed=1`);
      }
      if (pending.status === "activated") {
        // Already handled (webhook or a previous return hit) — just show success.
        activatedPlan = pending.plan;
      } else {
        // 3. Best-effort server-side status confirmation.
        const statusCheck = await getKashierOrderStatus(orderId);
        if (statusCheck.checked && !statusCheck.success) {
          console.warn(
            "[kashier:return] Kashier status API says not-success:",
            statusCheck.status,
            "for",
            orderId,
          );
          return redirect(`${origin}/#checkout_failed=1`);
        }
        if (!statusCheck.checked) {
          console.warn(
            "[kashier:return] status API unreachable, relying on signature only:",
            statusCheck.reason,
          );
        }

        activatedPlan = pending.plan;
        const existing = await getSubscription(pending.uid);
        const alreadyActivated =
          existing &&
          existing.kashierOrderId === orderId &&
          existing.status === "active";
        if (!alreadyActivated) {
          await activateSubscription({
            uid: pending.uid,
            plan: pending.plan,
            currency: pending.currency,
            amount: pending.amount,
            kashierOrderId: orderId,
            kashierReference: kashierRef,
            cardToken,
            shopperReference: `omnote_${pending.uid}`,
          });
        }
        // Mark pending record as activated so replay attempts are noticed.
        try { await markPendingStatus(orderId, "activated"); }
        catch (e) { console.warn("[kashier:return] markPendingStatus failed:", (e as Error).message); }
      }
    } catch (e) {
      console.error("[kashier:return] activation error:", (e as Error).message);
      flag = "checkout_pending=1";
    }
  }

  if (!explicitlyFailed && explicitlySuccess && activatedPlan) {
    const params = new URLSearchParams();
    params.set("plan", activatedPlan);
    if (orderId) params.set("orderId", orderId);
    return redirect(`${origin}/app/welcome-pro.html?${params.toString()}`);
  }

  return redirect(`${origin}/#${flag}`);
}

export const Route = createFileRoute("/api/public/kashier/return")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});
