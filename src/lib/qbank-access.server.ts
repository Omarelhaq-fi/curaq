// Edge-style access cache for QBank authorization.
//
// Goal: /api/qbank_static (and list_categories / qbank_key) must enforce the
// SAME country+grant rule as /api/qbank?action=get_questions, but with
// 0 Firestore reads on the hot path.
//
// Production shape (Vercel Edge + Upstash/Vercel KV):
//   verifyIdToken (cached JWKS, no DB) -> KV GET uid -> { mainIds, prepIds,
//   grants, country } -> miss? Firestore once, KV SETEX 5m -> 403 or allow.
//
// This file implements that shape on the current runtime with a per-isolate
// in-memory map standing in for KV (same TTL semantics: 5m). Swapping the
// Map for Upstash/Vercel KV later is a drop-in change inside get/set only â€”
// callers stay identical. R2 stays private; no public CDN cache.
//
// Cost: hot path = 0 Firestore reads (profile bundle + bank list both
// cached). Cold/miss = ~2 reads (1 user doc + shared list, the latter
// amortized across all users via the publish-invalidated list cache).

import {
  getQbankListCache,
  setQbankListCache,
  findCachedQbankMeta,
  patchCachedQbankStorageProvider,
  getCachedUserProfile,
  setCachedUserProfile,
  invalidateUserProfile,
  type QbankListEntry,
} from "@/lib/qbank-cache.server";
import {
  collegeBankIds,
  loadAcademicStructure,
  type AcademicStructure,
} from "@/lib/academic.server";

export interface AccessBundle {
  profileCountry: string;
  profileMajor?: string;
  profileCollege?: string;
  collegeId?: string;
  mainIds: string[];
  prepIds: string[];
  grants: string[];
  legacy: boolean;
}

type UserProfile = {
  country: string;
  grants: string[];
  collegeId?: string;
  major?: string;
  college?: string;
};

interface BundleEntry extends AccessBundle {
  time: number;
}

// 5-minute KV TTL. College catalogue assignments are now access-authoritative
// and admins need them reflected promptly; profile/bank/structure caches mean
// a refresh is still essentially 0 Firestore reads. Individual grants are
// covered sooner too. Stale-deny retry still exists for immediate grant checks.
const BUNDLE_TTL_MS = 5 * 60_000;
const MAX_BUNDLE_ENTRIES = 2000;

const bundleCache = new Map<string, BundleEntry>();

function getBundleCached(uid: string): AccessBundle | null {
  const e = bundleCache.get(uid);
  if (!e) return null;
  if (Date.now() - e.time > BUNDLE_TTL_MS) {
    bundleCache.delete(uid);
    return null;
  }
  return e;
}

function setBundleCached(uid: string, b: AccessBundle): void {
  if (bundleCache.size >= MAX_BUNDLE_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of bundleCache) {
      bundleCache.delete(k);
      if (bundleCache.size < MAX_BUNDLE_ENTRIES - 200 || now - v.time < BUNDLE_TTL_MS) break;
    }
  }
  bundleCache.set(uid, { ...b, time: Date.now() });
}

export function invalidateAccessBundle(uid: string): void {
  bundleCache.delete(uid);
  try {
    invalidateUserProfile(uid);
  } catch {
    /* best-effort */
  }
}

export function invalidateAllAccessBundles(): void {
  bundleCache.clear();
}

async function fetchUserProfileFresh(
  sa: { project_id: string },
  token: string,
  uid: string,
): Promise<UserProfile> {
  const uRef = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users_index/${uid}`;
  const uRes = await fetch(uRef, { headers: { Authorization: `Bearer ${token}` } });
  let country = "";
  let grants: string[] = [];
  let collegeId = "";
  let major = "";
  let college = "";
  if (uRes.ok) {
    const ud = await uRes.json();
    country = String(ud.fields?.country?.stringValue || "").toLowerCase();
    const gv = ud.fields?.qbankGrants?.arrayValue?.values || [];
    grants = gv.map((v: any) => String(v.stringValue || "")).filter(Boolean);
    collegeId = String(ud.fields?.collegeId?.stringValue || "");
    major = String(ud.fields?.major?.stringValue || "");
    college = String(ud.fields?.college?.stringValue || "");
  }
  const profile: UserProfile = { country, grants, collegeId, major, college };
  try {
    setCachedUserProfile(uid, profile);
  } catch {
    /* best-effort */
  }
  return profile;
}

async function loadUserProfile(
  sa: { project_id: string },
  token: string,
  uid: string,
): Promise<UserProfile> {
  const cached = getCachedUserProfile(uid);
  if (cached) return cached;
  return fetchUserProfileFresh(sa, token, uid);
}

export async function loadAllBanks(
  sa: { project_id: string },
  token: string,
): Promise<QbankListEntry[]> {
  const cached = getQbankListCache();
  if (cached) return cached.banks;

  const indexUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/sys/qbank_index`;
  const indexRes = await fetch(indexUrl, { headers: { Authorization: `Bearer ${token}` } });

  if (indexRes.ok) {
    const indexData = await indexRes.json();
    const jsonStr = indexData.fields?.data?.stringValue;
    if (jsonStr) {
      try {
        const qbanks: QbankListEntry[] = JSON.parse(jsonStr);
        setQbankListCache(qbanks);
        return qbanks;
      } catch (e) {
        console.error("[qbank-access] Failed to parse qbank_index:", e);
      }
    }
  }

  const qbanks: QbankListEntry[] = [];
  let pageToken = "";
  while (true) {
    const params = new URLSearchParams({ pageSize: "300" });
    if (pageToken) params.set("pageToken", pageToken);
    const listRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks?${params}`,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
    );
    if (!listRes.ok && listRes.status !== 404) throw new Error("Failed to load qbanks");
    if (listRes.status === 404) break;
    const data = await listRes.json();
    if (data && Array.isArray(data.documents)) {
      for (const doc of data.documents) {
        const id = doc.name.split("/").pop();
        const name = doc.fields?.name?.stringValue || id;
        const country = doc.fields?.country?.stringValue || "global";
        const updatedAtStr = doc.fields?.updatedAt?.integerValue || doc.fields?.updatedAt?.doubleValue;
        const updatedAt = updatedAtStr ? parseInt(String(updatedAtStr), 10) : 0;
        const isLocked = doc.fields?.isLocked?.booleanValue || doc.fields?.isLocked?.stringValue === "true" || false;
        const isPartyLocked =
          doc.fields?.isPartyLocked?.booleanValue || doc.fields?.isPartyLocked?.stringValue === "true" || false;
        let resources = [];
        try {
          resources = JSON.parse(doc.fields?.resources?.stringValue || "[]");
        } catch {}
        const kind = doc.fields?.kind?.stringValue || "main";
        const college = doc.fields?.college?.stringValue || "";
        const year = doc.fields?.year?.stringValue || "";
        const storage_provider = doc.fields?.storage_provider?.stringValue || "";
        qbanks.push({ id, name, country, updatedAt, isLocked, isPartyLocked, resources, kind, college, year, storage_provider });
      }
    }
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }
  setQbankListCache(qbanks);
  return qbanks;
}

export function buildAccessBundle(
  profile: UserProfile,
  allBanks: QbankListEntry[],
  structure?: AcademicStructure | null,
): AccessBundle {
  const country = profile.country;
  const grants = profile.grants;
  const collegeId = profile.collegeId || "";
  const college = collegeId && structure
    ? structure.colleges.find((c) => c.id === collegeId) || null
    : null;
  const major = college && structure
    ? structure.majors.find((m) => m.id === college.majorId) || null
    : null;
  const legacy = !country && !collegeId;
  const bankCountry = (b: { country: string }) => String(b.country || "global").toLowerCase();
  const byId = new Map(allBanks.map((b) => [b.id, b]));
  const base: AccessBundle = {
    profileCountry: country,
    profileMajor: major?.name || profile.major || "",
    profileCollege: college?.name || profile.college || "",
    collegeId,
    mainIds: [],
    prepIds: [],
    grants,
    legacy,
  };

  const addGranted = (main: Set<string>, prep: Set<string>, id: string) => {
    const bank = byId.get(id);
    if (!bank) return;
    (bank.kind === "exam_prep" ? prep : main).add(id);
  };

  if (legacy) {
    for (const b of allBanks) (b.kind === "exam_prep" ? base.prepIds : base.mainIds).push(b.id);
    return base;
  }

  const main = new Set<string>();
  const prep = new Set<string>();

  if (collegeId && structure) {
    // A known college is authoritative: only its attached banks (plus
    // individually granted banks) are available. An empty attachment list
    // deliberately means no banks, not "fall back to country".
    if (college) {
      const attached = collegeBankIds(structure, collegeId);
      for (const id of attached.mainIds) {
        const bank = byId.get(id);
        if (bank && bank.kind !== "exam_prep") main.add(id);
      }
      for (const id of attached.prepIds) {
        const bank = byId.get(id);
        if (bank && bank.kind === "exam_prep") prep.add(id);
      }
    }
  } else if (!collegeId) {
    // Legacy country-scoped accounts (or a missing catalogue entry).
    for (const b of allBanks) {
      if (bankCountry(b) === country) (b.kind === "exam_prep" ? prep : main).add(b.id);
    }
  } else {
    // College selected but the catalogue could not be loaded: keep the
    // legacy country fallback rather than locking the student out.
    for (const b of allBanks) {
      if (bankCountry(b) === country) (b.kind === "exam_prep" ? prep : main).add(b.id);
    }
  }
  for (const id of grants) addGranted(main, prep, id);

  base.mainIds = [...main];
  base.prepIds = [...prep];
  return base;
}

/** Hot-path bundle: 5m KV-style cache, Firestore fallback once on miss. */
export async function getAccessBundleCached(
  sa: { project_id: string },
  token: string,
  uid: string,
): Promise<AccessBundle> {
  const hit = getBundleCached(uid);
  if (hit) return hit;
  const profile = await loadUserProfile(sa, token, uid);
  const allBanks = await loadAllBanks(sa, token).catch(() => []);
  const structure = profile.collegeId
    ? await loadAcademicStructure(sa, token).catch(() => null)
    : null;
  const bundle = buildAccessBundle(profile, allBanks, structure);
  setBundleCached(uid, bundle);
  return bundle;
}

export function bankAccessAllowed(
  profile: UserProfile,
  meta: { country: string; kind: string },
  qbankId: string,
  bundle?: AccessBundle | null,
): boolean {
  if (bundle) {
    if (bundle.legacy) return true;
    return (
      bundle.grants.includes(qbankId) ||
      bundle.mainIds.includes(qbankId) ||
      bundle.prepIds.includes(qbankId)
    );
  }
  if (!profile.country && !profile.collegeId) return true; // legacy
  if (profile.grants.includes(qbankId)) return true;
  return meta.country.toLowerCase() === profile.country;
}

export interface BankAccessResult {
  ok: boolean;
  status: 200 | 403 | 404;
  profile: UserProfile;
  meta: { country: string; kind: string; storage_provider?: string } | null;
  bundle: AccessBundle | null;
}

/**
 * Edge-style per-bank check with 0 Firestore reads when warm:
 * bank meta from the shared publish-invalidated list cache, caller bundle
 * from the 5m access cache. On DENY exactly one fresh profile read before
 * giving up (covers a grant approved seconds ago on another isolate).
 */
export async function resolveBankAccessEdge(
  sa: { project_id: string },
  token: string,
  uid: string,
  qbankId: string,
): Promise<BankAccessResult> {
  let bundle = await getAccessBundleCached(sa, token, uid).catch(() => null);
  let profile: UserProfile = bundle
    ? {
        country: bundle.profileCountry,
        grants: bundle.grants,
        collegeId: bundle.collegeId,
        major: bundle.profileMajor,
        college: bundle.profileCollege,
      }
    : await loadUserProfile(sa, token, uid);

  const hit = findCachedQbankMeta(qbankId);
  let meta: { country: string; kind: string; storage_provider?: string } | null = hit
    ? { country: hit.country, kind: hit.kind, storage_provider: hit.storage_provider }
    : null;

  if ((!meta || meta.storage_provider === undefined) && /^[a-zA-Z0-9_-]+$/.test(qbankId)) {
    try {
      const bRef = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}`;
      const bRes = await fetch(bRef, { headers: { Authorization: `Bearer ${token}` } });
      if (bRes.ok) {
        const bd = await bRes.json();
        const freshProvider = bd.fields?.storage_provider?.stringValue
          ? String(bd.fields.storage_provider.stringValue)
          : "";
        try {
          patchCachedQbankStorageProvider(qbankId, freshProvider);
        } catch {
          /* best-effort */
        }
        const fresh = {
          country: String(bd.fields?.country?.stringValue || "global"),
          kind: String(bd.fields?.kind?.stringValue || "main"),
          storage_provider: freshProvider || undefined,
        };
        meta = meta ? { ...meta, storage_provider: fresh.storage_provider } : fresh;
      }
    } catch {
      /* keep cached meta */
    }
  }
  if (!meta) return { ok: false, status: 404, profile, meta: null, bundle };
  if (bankAccessAllowed(profile, meta, qbankId, bundle)) {
    return { ok: true, status: 200, profile, meta, bundle };
  }
  // Stale-cache retry: drop both caches and read fresh once.
  invalidateAccessBundle(uid);
  profile = await fetchUserProfileFresh(sa, token, uid);
  try {
    const allBanks = await loadAllBanks(sa, token).catch(() => []);
    const structure = profile.collegeId
      ? await loadAcademicStructure(sa, token).catch(() => null)
      : null;
    bundle = buildAccessBundle(profile, allBanks, structure);
    setBundleCached(uid, bundle);
  } catch {
    bundle = null;
  }
  if (bankAccessAllowed(profile, meta, qbankId, bundle)) {
    return { ok: true, status: 200, profile, meta, bundle };
  }
  return { ok: false, status: 403, profile, meta, bundle };
}

/** Filter a bank list to what this bundle may see. Never leaks other IDs. */
export function filterBanksForBundle(banks: QbankListEntry[], bundle: AccessBundle): QbankListEntry[] {
  if (bundle.legacy) return banks;
  const allowed = new Set([...bundle.mainIds, ...bundle.prepIds, ...bundle.grants]);
  return banks.filter((b) => allowed.has(b.id));
}

/**
 * Best-effort App Check gate. The compat SDK is loaded on the client but
 * never initialized, so enforcement is opt-in: set APP_CHECK_ENFORCE=true
 * once the client ships tokens. Until then we only log presence (no extra
 * cost, no breakage).
 */
export function checkAppCheck(request: Request): { present: boolean; enforced: boolean } {
  const tok = request.headers.get("x-firebase-appcheck") || "";
  const present = tok.trim().length > 10;
  const enforced = String(process.env.APP_CHECK_ENFORCE || "").toLowerCase() === "true";
  return { present, enforced };
}
