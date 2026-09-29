// Admin-controlled payment wall settings.
// Stored at Firestore admin/payments. Cached in-memory for 30s.

import { getServiceAccount, getGoogleAccessToken } from "./firebase.server";

export type PaymentsSettings = {
  enabled: boolean;
  reason: string;                       // shown to users when disabled
  allowedPlans: { pro: boolean; aplus: boolean };
  allowedCurrencies: { USD: boolean; EGP: boolean };
};

export const DEFAULT_PAYMENTS_SETTINGS: PaymentsSettings = {
  enabled: true,
  reason: "Payments are temporarily unavailable. Please try again later.",
  allowedPlans: { pro: true, aplus: true },
  allowedCurrencies: { USD: true, EGP: true },
};

let cache: { at: number; value: PaymentsSettings } | null = null;
const TTL_MS = 30_000;

export function invalidatePaymentsSettingsCache() { cache = null; }

async function fsGet(path: string) {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`fsGet ${path} ${r.status}`);
  return (await r.json()) as { fields?: Record<string, any> };
}

async function fsSet(path: string, fields: Record<string, any>) {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const mask = Object.keys(fields)
    .map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
    .join("&");
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}?${mask}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) throw new Error(`fsSet ${path} ${r.status}`);
}

export async function loadPaymentsSettings(): Promise<PaymentsSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  let value = { ...DEFAULT_PAYMENTS_SETTINGS };
  try {
    const doc = await fsGet("admin/payments");
    const f = doc?.fields || {};
    if (typeof f.enabled?.booleanValue === "boolean") value.enabled = f.enabled.booleanValue;
    if (typeof f.reason?.stringValue === "string") value.reason = f.reason.stringValue;
    const ap = f.allowedPlans?.mapValue?.fields || {};
    value.allowedPlans = {
      pro: ap.pro?.booleanValue !== false,
      aplus: ap.aplus?.booleanValue !== false,
    };
    const ac = f.allowedCurrencies?.mapValue?.fields || {};
    value.allowedCurrencies = {
      USD: ac.USD?.booleanValue !== false,
      EGP: ac.EGP?.booleanValue !== false,
    };
  } catch {
    /* keep defaults */
  }
  cache = { at: Date.now(), value };
  return value;
}

export async function savePaymentsSettings(patch: Partial<PaymentsSettings>): Promise<PaymentsSettings> {
  const cur = await loadPaymentsSettings();
  const next: PaymentsSettings = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled,
    reason: typeof patch.reason === "string"
      ? patch.reason.slice(0, 400)
      : cur.reason,
    allowedPlans: {
      pro: patch.allowedPlans?.pro ?? cur.allowedPlans.pro,
      aplus: patch.allowedPlans?.aplus ?? cur.allowedPlans.aplus,
    },
    allowedCurrencies: {
      USD: patch.allowedCurrencies?.USD ?? cur.allowedCurrencies.USD,
      EGP: patch.allowedCurrencies?.EGP ?? cur.allowedCurrencies.EGP,
    },
  };
  await fsSet("admin/payments", {
    enabled: { booleanValue: next.enabled },
    reason: { stringValue: next.reason },
    allowedPlans: { mapValue: { fields: {
      pro: { booleanValue: next.allowedPlans.pro },
      aplus: { booleanValue: next.allowedPlans.aplus },
    } } },
    allowedCurrencies: { mapValue: { fields: {
      USD: { booleanValue: next.allowedCurrencies.USD },
      EGP: { booleanValue: next.allowedCurrencies.EGP },
    } } },
  });
  invalidatePaymentsSettingsCache();
  cache = { at: Date.now(), value: next };
  return next;
}
