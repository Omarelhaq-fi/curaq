// Shared in-memory caches for QBank metadata — cuts repeated Firestore reads.
//
// NOTE: module state is per worker isolate (same pattern as the existing
// route-local caches). Every entry has a TTL fallback so a missed
// invalidation can only cause bounded staleness.
//
// Cache strategy:
// - QBank list: cached INDEFINITELY (no short TTL). It is invalidated when
//   an admin publishes/mutates a bank (see admin.ts helpers) because every
//   such mutation bumps `qbanks/{id}.updatedAt`. A 30-min safety TTL bounds
//   staleness if an invalidation is ever missed. Clients send their known
//   `maxUpdatedAt` as `?v=`; when it matches the cached version the server
//   answers `{ unchanged: true }` with ZERO Firestore reads.
// - User profile (country + grants): 60s TTL per uid. Grants/country change
//   rarely; admin grant approval explicitly invalidates the target user.

export interface QbankListEntry {
  id: string;
  name: string;
  country: string;
  updatedAt: number;
  isLocked: boolean;
  isPartyLocked: boolean;
  resources: unknown[];
  kind: string;
  college: string;
  year: string;
  storage_provider?: string;
}

interface ListCache {
  banks: QbankListEntry[];
  maxUpdatedAt: number;
  time: number;
}

// Safety TTL only — normal expiry is via invalidateQbankListCache() on publish.
const LIST_SAFETY_TTL_MS = 30 * 60_000;

let listCache: ListCache | null = null;

export function getQbankListCache(): ListCache | null {
  if (!listCache) return null;
  if (Date.now() - listCache.time > LIST_SAFETY_TTL_MS) {
    listCache = null;
    return null;
  }
  return listCache;
}

export function setQbankListCache(banks: QbankListEntry[]): ListCache {
  let maxUpdatedAt = 0;
  for (const b of banks) {
    const v = typeof b.updatedAt === "number" && Number.isFinite(b.updatedAt) ? b.updatedAt : 0;
    if (v > maxUpdatedAt) maxUpdatedAt = v;
  }
  listCache = { banks, maxUpdatedAt, time: Date.now() };
  return listCache;
}

export function invalidateQbankListCache(): void {
  listCache = null;
}

/**
 * Backfill a bank's storage flag in the in-memory list (e.g. after the
 * one-off repair read in resolveBankAccess) so later calls stay at 0 reads.
 * Pass "" when the bank doc has no provider (legacy Firestore-chunks bank)
 * to mark it checked — callers must test `=== undefined` (unchecked) rather
 * than falsiness so checked-legacy banks are not re-fetched every time.
 */
export function patchCachedQbankStorageProvider(id: string, provider: string): void {
  const c = getQbankListCache();
  if (!c) return;
  const b = c.banks.find((x) => x.id === id);
  if (b) b.storage_provider = provider;
}

/** Country/kind/storage lookup for access checks without a Firestore read. */
export function findCachedQbankMeta(
  id: string,
): { id: string; country: string; kind: string; storage_provider?: string } | null {
  const c = getQbankListCache();
  if (!c) return null;
  const b = c.banks.find((x) => x.id === id);
  if (!b) return null;
  return {
    id: b.id,
    country: String(b.country || "global"),
    kind: String(b.kind || "main"),
    storage_provider: typeof b.storage_provider === "string" ? b.storage_provider : undefined,
  };
}

// ---------------------------------------------------------------------------
// Per-user profile cache (users_index country + qbankGrants)
// ---------------------------------------------------------------------------

export interface CachedUserProfile {
  country: string;
  grants: string[];
}

interface ProfileEntry extends CachedUserProfile {
  time: number;
}

const PROFILE_TTL_MS = 60_000;
const MAX_PROFILE_ENTRIES = 1000;

const profileCache = new Map<string, ProfileEntry>();

export function getCachedUserProfile(uid: string): CachedUserProfile | null {
  const e = profileCache.get(uid);
  if (!e) return null;
  if (Date.now() - e.time > PROFILE_TTL_MS) {
    profileCache.delete(uid);
    return null;
  }
  return { country: e.country, grants: e.grants };
}

export function setCachedUserProfile(uid: string, data: CachedUserProfile): void {
  if (profileCache.size >= MAX_PROFILE_ENTRIES) {
    // Evict oldest entries first (Map iterates in insertion order).
    const now = Date.now();
    for (const [k, v] of profileCache) {
      profileCache.delete(k);
      if (profileCache.size < MAX_PROFILE_ENTRIES - 100 || now - v.time < PROFILE_TTL_MS) break;
    }
  }
  profileCache.set(uid, { country: data.country, grants: data.grants, time: Date.now() });
}

export function invalidateUserProfile(uid: string): void {
  profileCache.delete(uid);
}
