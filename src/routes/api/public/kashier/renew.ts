// Cron endpoint — charges stored card tokens for subscribers approaching
// their renewal date. Guard with header `x-cron-secret: $CRON_SECRET`.
//
// pg_cron example (call once per hour):
//   select net.http_post(
//     url:='https://project--<id>.lovable.app/api/public/kashier/renew',
//     headers:='{"Content-Type":"application/json","x-cron-secret":"..."}'::jsonb,
//     body:='{}'::jsonb
//   );

import { createFileRoute } from "@tanstack/react-router";
import { getServiceAccount, getGoogleAccessToken } from "@/lib/firebase.server";
import { getClientIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit.server";
import { chargeWithToken, getKashierConfig, timingSafeEqual } from "@/lib/kashier.server";
import { activateSubscription, markPastDue } from "@/lib/subscriptions.server";
import { isCurrency, isPayablePlan, type Currency, type PayablePlan } from "@/lib/pricing.server";

type FSValue = {
  stringValue?: string;
  integerValue?: string;
  booleanValue?: boolean;
  timestampValue?: string;
};
type FSDoc = { name: string; fields?: Record<string, FSValue> };

async function listDueSubscriptions(nowMs: number, limit = 100): Promise<
  Array<{
    uid: string; plan: PayablePlan; currency: Currency; amount: number;
    cardToken: string; shopperReference: string;
    cancelAtPeriodEnd: boolean;
  }>
> {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/subscriptions?pageSize=${limit}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Firestore list failed: ${resp.status}`);
  const data = (await resp.json()) as { documents?: FSDoc[] };
  const out: Array<{
    uid: string; plan: PayablePlan; currency: Currency; amount: number;
    cardToken: string; shopperReference: string;
    cancelAtPeriodEnd: boolean;
  }> = [];
  for (const d of data.documents || []) {
    const uid = d.name.split("/").pop() || "";
    const f = d.fields || {};
    const status = f.status?.stringValue || "";
    if (status !== "active") continue;
    const nextRenewalAt = Number(f.nextRenewalAt?.integerValue || 0);
    if (nextRenewalAt === 0 || nextRenewalAt > nowMs) continue;
    const plan = f.plan?.stringValue || "";
    const currency = f.currency?.stringValue || "";
    const cardToken = f.cardToken?.stringValue || "";
    const shopperReference = f.shopperReference?.stringValue || "";
    if (!isPayablePlan(plan) || !isCurrency(currency) || !cardToken) continue;
    out.push({
      uid,
      plan,
      currency,
      amount: Number(f.amount?.integerValue || 0),
      cardToken,
      shopperReference,
      cancelAtPeriodEnd: !!f.cancelAtPeriodEnd?.booleanValue,
    });
  }
  return out;
}

export const Route = createFileRoute("/api/public/kashier/renew")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const ip = getClientIp(request as unknown as Request);
        const secret = process.env.CRON_SECRET;
        const provided = request.headers.get("x-cron-secret") || "";
        if (!secret || !timingSafeEqual(secret, provided)) {
          const rl = rateLimit(`cron-fail:${ip}`, 60_000, 10);
          if (!rl.ok) return rateLimitResponse(rl.retryAfter, {});
          return new Response("Unauthorized", { status: 401 });
        }
        const cfg = getKashierConfig();
        if (!cfg.configured) {
          return new Response(JSON.stringify({ skipped: "not_configured" }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        }

        const now = Date.now();
        const due = await listDueSubscriptions(now);
        const results: Array<{ uid: string; ok: boolean; reason?: string }> = [];

        for (const s of due) {
          if (s.cancelAtPeriodEnd) {
            await markPastDue(s.uid).catch(() => {});
            results.push({ uid: s.uid, ok: false, reason: "canceled_at_period_end" });
            continue;
          }
          const orderId = `renew_${s.uid.slice(0, 8)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
          const charge = await chargeWithToken({
            orderId,
            amount: s.amount,
            currency: s.currency,
            cardToken: s.cardToken,
            shopperReference: s.shopperReference,
            metaData: { uid: s.uid, plan: s.plan, kind: "renewal" },
          });
          if (charge.ok) {
            await activateSubscription({
              uid: s.uid,
              plan: s.plan,
              currency: s.currency,
              amount: s.amount,
              kashierOrderId: orderId,
              kashierReference: charge.kashierReference,
              cardToken: s.cardToken,
              shopperReference: s.shopperReference,
            });
            results.push({ uid: s.uid, ok: true });
          } else {
            await markPastDue(s.uid).catch(() => {});
            results.push({ uid: s.uid, ok: false, reason: charge.error });
          }
        }

        return new Response(JSON.stringify({ processed: results.length, results }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
