// Subscription state — one Firestore doc per user under `subscriptions/{uid}`.
// Kept in sync with `users_index/{uid}` (plan, proUntil) so quota.server.ts
// keeps working without changes.

import { fsGetDoc, fsPatchDoc, toFieldsPatch, resetUserCredits, type Plan } from "./quota.server";
import type { PayablePlan, Currency } from "./pricing.server";

export type SubStatus = "active" | "past_due" | "canceled" | "pending";

export type SubscriptionRecord = {
  uid: string;
  plan: PayablePlan | "free";
  currency: Currency | null;
  amount: number;
  status: SubStatus;
  kashierOrderId: string | null;      // current/latest order
  kashierReference: string | null;    // Kashier's own order reference
  cardToken: string | null;           // for recurring charges
  shopperReference: string | null;    // stable per-user shopper id sent to Kashier
  proUntil: number;                   // ms epoch
  nextRenewalAt: number;              // ms epoch (usually = proUntil - grace)
  lastPaymentAt: number;
  lastFailureAt: number;
  cancelAtPeriodEnd: boolean;
  updatedAt: number;
};

const SUB_PATH = (uid: string) => `subscriptions/${uid}`;

export function shopperRefFor(uid: string): string {
  return `omnote_${uid}`;
}

export async function getSubscription(uid: string): Promise<SubscriptionRecord | null> {
  const doc = await fsGetDoc(SUB_PATH(uid));
  if (!doc) return null;
  const f = doc.fields || {};
  const num = (k: string) => Number(f[k]?.integerValue || 0);
  const str = (k: string) => f[k]?.stringValue || null;
  const bool = (k: string) => !!f[k]?.booleanValue;
  return {
    uid,
    plan: (str("plan") as SubscriptionRecord["plan"]) || "free",
    currency: (str("currency") as Currency | null),
    amount: num("amount"),
    status: (str("status") as SubStatus) || "canceled",
    kashierOrderId: str("kashierOrderId"),
    kashierReference: str("kashierReference"),
    cardToken: str("cardToken"),
    shopperReference: str("shopperReference"),
    proUntil: num("proUntil"),
    nextRenewalAt: num("nextRenewalAt"),
    lastPaymentAt: num("lastPaymentAt"),
    lastFailureAt: num("lastFailureAt"),
    cancelAtPeriodEnd: bool("cancelAtPeriodEnd"),
    updatedAt: num("updatedAt"),
  };
}

export async function upsertSubscription(
  uid: string,
  patch: Partial<Omit<SubscriptionRecord, "uid">>,
): Promise<void> {
  const now = Date.now();
  const payload: Record<string, string | number | null> = { updatedAt: now };
  const keys: string[] = ["updatedAt"];

  type PatchKey = keyof Omit<SubscriptionRecord, "uid">;
  const p = patch as Record<PatchKey, unknown>;
  const strFields: PatchKey[] = [
    "plan", "currency", "status", "kashierOrderId", "kashierReference",
    "cardToken", "shopperReference",
  ];
  for (const k of strFields) {
    if (p[k] !== undefined) {
      const v = p[k];
      payload[k] = v === null ? null : String(v);
      keys.push(String(k));
    }
  }
  const numFields: PatchKey[] = [
    "amount", "proUntil", "nextRenewalAt", "lastPaymentAt", "lastFailureAt",
  ];
  for (const k of numFields) {
    if (p[k] !== undefined) {
      payload[k] = Math.floor(Number(p[k] || 0));
      keys.push(String(k));
    }
  }
  if (patch.cancelAtPeriodEnd !== undefined) {
    // store bool as string "1"/"0" via patchDoc's supported types; simpler: use integerValue 0/1
    payload.cancelAtPeriodEnd = patch.cancelAtPeriodEnd ? 1 : 0;
    keys.push("cancelAtPeriodEnd");
  }

  // Note: fsPatchDoc's toFieldsPatch encodes numbers as integerValue, strings as
  // stringValue, nulls as nullValue. cancelAtPeriodEnd is stored as int 0/1
  // for compatibility with that helper; the getter above will read booleans
  // via the dedicated field if present, so also mirror as booleanValue below.
  const fields = toFieldsPatch(payload);
  if (patch.cancelAtPeriodEnd !== undefined) {
    fields.cancelAtPeriodEnd = { booleanValue: !!patch.cancelAtPeriodEnd };
  }
  await fsPatchDoc(SUB_PATH(uid), fields, keys);
}

// Mirror plan/proUntil onto users_index so quota logic sees the paid state.
export async function mirrorPlanToUserIndex(
  uid: string,
  plan: Plan,
  proUntilMs: number,
): Promise<void> {
  const patch: Record<string, string | number | null> = {
    plan,
    lastSeenIso: new Date().toISOString(),
  };
  // proUntil is a timestamp field on users_index. Use ISO string via
  // toFieldsPatch — but that encodes strings, not timestamps. Firestore accepts
  // ISO for timestampValue only when explicitly typed. So build fields manually.
  const fields = toFieldsPatch(patch);
  fields.proUntil = proUntilMs > 0
    ? { timestampValue: new Date(proUntilMs).toISOString() }
    : { nullValue: null };
  await fsPatchDoc(`users_index/${uid}`, fields, ["plan", "lastSeenIso", "proUntil"]);
}

// Called after a successful Kashier payment (webhook) — activate/extend the
// user's subscription and refill their credits.
export async function activateSubscription(input: {
  uid: string;
  plan: PayablePlan;
  currency: Currency;
  amount: number;
  kashierOrderId: string;
  kashierReference: string;
  cardToken?: string | null;
  shopperReference?: string | null;
  periodDays?: number;
}): Promise<void> {
  const now = Date.now();
  const periodMs = (input.periodDays || 30) * 86400_000;
  // Extend from max(now, current proUntil) so early renewals stack.
  const existing = await getSubscription(input.uid);
  const base = existing && existing.proUntil > now ? existing.proUntil : now;
  const proUntil = base + periodMs;
  const nextRenewalAt = proUntil - 6 * 3600_000; // renew 6h before expiry

  await upsertSubscription(input.uid, {
    plan: input.plan,
    currency: input.currency,
    amount: input.amount,
    status: "active",
    kashierOrderId: input.kashierOrderId,
    kashierReference: input.kashierReference,
    cardToken: input.cardToken ?? existing?.cardToken ?? null,
    shopperReference: input.shopperReference ?? existing?.shopperReference ?? null,
    proUntil,
    nextRenewalAt,
    lastPaymentAt: now,
    cancelAtPeriodEnd: false,
  });

  await mirrorPlanToUserIndex(input.uid, input.plan, proUntil);
  // Reset monthly credits to the paid allotment right away.
  try { await resetUserCredits(input.uid); }
  catch (e) { console.warn("resetUserCredits after activate failed:", (e as Error).message); }
}

export async function markPastDue(uid: string): Promise<void> {
  const now = Date.now();
  await upsertSubscription(uid, {
    status: "past_due",
    lastFailureAt: now,
  });
}

export async function cancelAtPeriodEnd(uid: string): Promise<void> {
  await upsertSubscription(uid, { cancelAtPeriodEnd: true });
}

// ---------- Pending orders (return-URL fallback when webhook doesn't reach us) ----------

const PENDING_PATH = (orderId: string) => `kashier_pending/${orderId}`;
// Reject pending orders older than 1h — prevents replay of stale IDs.
export const PENDING_ORDER_MAX_AGE_MS = 60 * 60 * 1000;

export type PendingStatus = "pending" | "verified" | "activated";

export type PendingOrder = {
  uid: string;
  plan: PayablePlan;
  currency: Currency;
  amount: number;
  createdAt: number;
  status?: PendingStatus;
};

export async function savePendingOrder(orderId: string, p: PendingOrder): Promise<void> {
  const fields = toFieldsPatch({
    uid: p.uid,
    plan: p.plan,
    currency: p.currency,
    amount: Math.round(p.amount * 100),
    createdAt: p.createdAt,
    status: p.status || "pending",
  });
  await fsPatchDoc(PENDING_PATH(orderId), fields, ["uid", "plan", "currency", "amount", "createdAt", "status"]);
}

export async function markPendingStatus(orderId: string, status: PendingStatus): Promise<void> {
  const fields = toFieldsPatch({ status });
  await fsPatchDoc(PENDING_PATH(orderId), fields, ["status"]);
}

export async function getPendingOrder(orderId: string): Promise<PendingOrder | null> {
  const doc = await fsGetDoc(PENDING_PATH(orderId));
  if (!doc) return null;
  const f = doc.fields || {};
  const uid = f.uid?.stringValue;
  const plan = f.plan?.stringValue as PayablePlan | undefined;
  const currency = f.currency?.stringValue as Currency | undefined;
  const amountCents = Number(f.amount?.integerValue || 0);
  if (!uid || !plan || !currency) return null;
  return {
    uid,
    plan,
    currency,
    amount: amountCents / 100,
    createdAt: Number(f.createdAt?.integerValue || 0),
    status: (f.status?.stringValue as PendingStatus) || "pending",
  };
}

export function isPendingOrderFresh(p: PendingOrder): boolean {
  const age = Date.now() - (p.createdAt || 0);
  return age >= 0 && age <= PENDING_ORDER_MAX_AGE_MS;
}
