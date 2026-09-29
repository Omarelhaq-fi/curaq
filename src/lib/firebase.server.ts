// Firebase admin utilities for Cloudflare Workers (no firebase-admin SDK).
// - Verifies Firebase ID tokens via JWKS
// - Mints Google service account access tokens (RS256 JWT)
// - Reads/writes Firestore via REST

import { createRemoteJWKSet, jwtVerify, SignJWT, importPKCS8, type JWTPayload } from "jose";
import { AsyncLocalStorage } from "node:async_hooks";

export const dbStats = new AsyncLocalStorage<{reads: number, writes: number}>();

const origFetch = globalThis.fetch;
globalThis.fetch = async function(...args) {
    const res = await origFetch.apply(this, args);
    const store = dbStats.getStore();
    if (store && args[0] && args[0].toString().includes("firestore.googleapis.com")) {
        try {
            const urlStr = args[0].toString();
            const clone = res.clone();
            const data = await clone.json().catch(() => null);
            let r = 0;
            let w = 0;
            
            const method = (args[1]?.method || "GET").toUpperCase();
            if (urlStr.includes(":runAggregationQuery")) {
                // Aggregation (count/sum/avg) bills 1 document read.
                if (res.ok) r = 1;
            } else if (urlStr.includes(":runQuery")) {
                // Structured query: 1 billed read per returned document,
                // minimum 1 per query even when empty.
                if (res.ok && Array.isArray(data)) {
                    const docs = data.filter((el: any) => el && el.document).length;
                    r = Math.max(1, docs);
                } else if (res.ok) {
                    r = 1;
                }
            } else if (method === "GET") {
                if (data && Array.isArray((data as any).documents)) r = (data as any).documents.length;
                else if (data && (data as any).fields) r = 1;
                else if (res.ok || res.status === 404) r = 1; // lookup billed even on miss/empty
            } else if (method === "POST") {
                if (data.writeResults) w = data.writeResults.length;
                else if (args[0].toString().includes(":commit")) {
                    const bodyStr = args[1]?.body;
                    if (typeof bodyStr === "string") {
                        const body = JSON.parse(bodyStr);
                        w = body.writes ? body.writes.length : 1;
                    } else {
                        w = 1;
                    }
                } else w = 1;
            } else if (method === "PATCH" || method === "DELETE") {
                w = 1;
            }
            store.reads += r;
            store.writes += w;
        } catch(e) {}
    }
    return res;
};

const JWKS = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  ),
);

type ServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
};

let saCache: ServiceAccount | null = null;
export function getServiceAccount(): ServiceAccount {
  if (saCache) return saCache;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not set");
  const parsed = JSON.parse(raw) as ServiceAccount;
  if (!parsed.private_key || !parsed.client_email || !parsed.project_id) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing required fields");
  }
  // Handle escaped newlines when JSON was stringified twice
  parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  saCache = parsed;
  return parsed;
}

export type FirebaseUser = JWTPayload & {
  sub: string;
  email?: string;
  user_id?: string;
};

export async function verifyFirebaseIdToken(token: string): Promise<FirebaseUser> {
  const sa = getServiceAccount();
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: `https://securetoken.google.com/${sa.project_id}`,
    audience: sa.project_id,
  });
  return payload as FirebaseUser;
}

const accessTokenCache: Record<string, { token: string; exp: number }> = {};

const DEFAULT_SCOPE = "https://www.googleapis.com/auth/datastore";

export async function getGoogleAccessToken(scope: string = DEFAULT_SCOPE): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const cached = accessTokenCache[scope];
  if (cached && cached.exp > now + 60) return cached.token;
  const sa = getServiceAccount();
  const pk = await importPKCS8(sa.private_key, "RS256");
  const assertion = await new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(pk);

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error("Google token exchange failed: " + t);
  }
  const data = (await resp.json()) as { access_token: string; expires_in: number };
  accessTokenCache[scope] = { token: data.access_token, exp: now + data.expires_in };
  return data.access_token;
}

// Last sign-in / token-refresh times straight from Firebase Auth.
// A user can sign in and browse without ever triggering a Firestore write,
// so admin "last active" must consider these too.
export async function fetchAuthLastLogins(uids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!uids.length) return out;
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken(
    "https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/cloud-platform",
  );
  const url = `https://identitytoolkit.googleapis.com/v1/projects/${sa.project_id}/accounts:lookup`;
  const batches: string[][] = [];
  for (let i = 0; i < uids.length; i += 100) batches.push(uids.slice(i, i + 100));
  await Promise.all(
    batches.map(async (localId) => {
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ localId }),
        });
        if (!resp.ok) {
          console.warn("[auth lookup] failed:", resp.status, await resp.text());
          return;
        }
        const data = (await resp.json()) as {
          users?: Array<{ localId?: string; lastLoginAt?: string; lastRefreshAt?: string }>;
        };
        for (const u of data.users || []) {
          if (!u.localId) continue;
          const loginMs = u.lastLoginAt ? Number(u.lastLoginAt) : 0;
          const refreshMs = u.lastRefreshAt ? new Date(u.lastRefreshAt).getTime() : 0;
          const best = Math.max(loginMs || 0, refreshMs || 0);
          if (best > 0) out[u.localId] = new Date(best).toISOString();
        }
      } catch (e) {
        console.warn("[auth lookup] error:", (e as Error).message);
      }
    }),
  );
  return out;
}

export type AuthUserRecord = {
  uid: string;
  email: string;
  createdIso: string | null;
  lastLoginIso: string | null;
  disabled: boolean;
};

// Full Firebase Auth roster. Users who signed in but never wrote anything to
// Firestore have no users_index doc, so admin must start from Auth, not Firestore.
export async function fetchAuthUsers(max = 2000): Promise<AuthUserRecord[]> {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken(
    "https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/cloud-platform",
  );
  const out: AuthUserRecord[] = [];
  let nextPageToken = "";
  for (let page = 0; page < 20 && out.length < max; page++) {
    const params = new URLSearchParams({ maxResults: "1000" });
    if (nextPageToken) params.set("nextPageToken", nextPageToken);
    const url = `https://identitytoolkit.googleapis.com/v1/projects/${sa.project_id}/accounts:batchGet?${params}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) {
      console.warn("[auth list] failed:", resp.status, await resp.text());
      break;
    }
    const data = (await resp.json()) as {
      users?: Array<{
        localId?: string;
        email?: string;
        createdAt?: string;
        lastLoginAt?: string;
        lastRefreshAt?: string;
        disabled?: boolean;
      }>;
      nextPageToken?: string;
    };
    for (const u of data.users || []) {
      if (!u.localId) continue;
      const loginMs = u.lastLoginAt ? Number(u.lastLoginAt) : 0;
      const refreshMs = u.lastRefreshAt ? new Date(u.lastRefreshAt).getTime() : 0;
      const best = Math.max(loginMs || 0, refreshMs || 0);
      out.push({
        uid: u.localId,
        email: u.email || "",
        createdIso: u.createdAt ? new Date(Number(u.createdAt)).toISOString() : null,
        lastLoginIso: best > 0 ? new Date(best).toISOString() : null,
        disabled: !!u.disabled,
      });
    }
    nextPageToken = data.nextPageToken || "";
    if (!nextPageToken) break;
  }
  return out;
}



export type Maintenance = { global: boolean; groups: Record<string, boolean> };
export type ApiKeys = { gemini: string[]; groq: string[]; maintenance: Maintenance };

let keysCache: { data: ApiKeys; exp: number } | null = null;

export async function loadApiKeys(): Promise<ApiKeys> {
  const now = Date.now();
  if (keysCache && keysCache.exp > now) return keysCache.data;
  const sa = getServiceAccount();
  const accessToken = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/admin/api_keys`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  let gemini: string[] = [];
  let groq: string[] = [];
  const maintenance: Maintenance = { global: false, groups: {} };
  if (resp.ok) {
    const doc = (await resp.json()) as { fields?: Record<string, unknown> };
    const fields = doc.fields || {};
    const g = fields.gemini as { arrayValue?: { values?: Array<{ stringValue?: string }> } } | undefined;
    if (g?.arrayValue?.values) {
      gemini = g.arrayValue.values.map((v) => v.stringValue || "").filter(Boolean);
    }
    // groq: accept legacy stringValue or new arrayValue
    const gq = fields.groq as
      | { stringValue?: string; arrayValue?: { values?: Array<{ stringValue?: string }> } }
      | undefined;
    if (gq?.arrayValue?.values) {
      groq = gq.arrayValue.values.map((v) => v.stringValue || "").filter(Boolean);
    } else if (gq?.stringValue) {
      groq = [gq.stringValue].filter(Boolean);
    }
    const mt = fields.maintenance as
      | { mapValue?: { fields?: Record<string, unknown> } }
      | undefined;
    const mtFields = mt?.mapValue?.fields || {};
    const mtGlobal = mtFields.global as { booleanValue?: boolean } | undefined;
    if (mtGlobal?.booleanValue) maintenance.global = true;
    const mtGroups = mtFields.groups as
      | { mapValue?: { fields?: Record<string, { booleanValue?: boolean }> } }
      | undefined;
    const grpFields = mtGroups?.mapValue?.fields || {};
    for (const [k, v] of Object.entries(grpFields)) {
      if (v?.booleanValue) maintenance.groups[k] = true;
    }
  } else if (resp.status !== 404) {
    const t = await resp.text();
    console.warn("Firestore admin/api_keys read failed:", resp.status, t);
  }
  const data: ApiKeys = { gemini, groq, maintenance };
  keysCache = { data, exp: now + 30_000 };
  return data;
}

export function invalidateKeyCache() {
  keysCache = null;
}

// Firestore read/write helpers (for settings stored in admin/ collection)
export async function fsGet(path: string) {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`fsGet ${path} ${r.status}`);
  return (await r.json()) as { fields?: Record<string, { booleanValue?: boolean; integerValue?: number; stringValue?: string }> };
}

export async function fsSet(path: string, fields: Record<string, { booleanValue?: boolean; integerValue?: number; stringValue?: string }>) {
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
