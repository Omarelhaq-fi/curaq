// Admin-controlled auth policy toggles.
// Stored at Firestore admin/auth_settings. In-memory cached for 30s.

import { getServiceAccount, getGoogleAccessToken } from "./firebase.server";

export type AuthSettings = {
  requireEmailVerification: boolean;
};

export const DEFAULT_AUTH_SETTINGS: AuthSettings = {
  requireEmailVerification: true,
};

let cache: { at: number; value: AuthSettings } | null = null;
const TTL_MS = 30_000;

export function invalidateAuthSettingsCache() { cache = null; }

async function fsGet(path: string) {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`fsGet ${path} ${r.status}`);
  return (await r.json()) as { fields?: Record<string, { booleanValue?: boolean }> };
}

async function fsSet(path: string, fields: Record<string, { booleanValue?: boolean }>) {
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

export async function loadAuthSettings(): Promise<AuthSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const value: AuthSettings = { ...DEFAULT_AUTH_SETTINGS };
  try {
    const doc = await fsGet("admin/auth_settings");
    const f = doc?.fields || {};
    if (typeof f.requireEmailVerification?.booleanValue === "boolean") {
      value.requireEmailVerification = f.requireEmailVerification.booleanValue;
    }
  } catch {
    /* keep defaults */
  }
  cache = { at: Date.now(), value };
  return value;
}

export async function saveAuthSettings(patch: Partial<AuthSettings>): Promise<AuthSettings> {
  const cur = await loadAuthSettings();
  const next: AuthSettings = {
    requireEmailVerification: typeof patch.requireEmailVerification === "boolean"
      ? patch.requireEmailVerification
      : cur.requireEmailVerification,
  };
  await fsSet("admin/auth_settings", {
    requireEmailVerification: { booleanValue: next.requireEmailVerification },
  });
  invalidateAuthSettingsCache();
  cache = { at: Date.now(), value: next };
  return next;
}
