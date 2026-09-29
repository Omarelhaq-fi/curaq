// Peer stats settings — admin-controlled threshold for visibility of peer answer statistics.
import { getServiceAccount, getGoogleAccessToken } from "./firebase.server";

export interface PeerStatsSettings {
  threshold: number;
}

const DEFAULT: PeerStatsSettings = { threshold: 50 };

// Firestore REST API returns integerValue as a string
interface FirestoreField {
  booleanValue?: boolean;
  integerValue?: string;
  stringValue?: string;
}

interface FirestoreDoc {
  fields?: Record<string, FirestoreField>;
}

async function fsGet(path: string): Promise<FirestoreDoc | null> {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`fsGet ${path} ${r.status}: ${await r.text()}`);
  return (await r.json()) as FirestoreDoc;
}

async function fsSet(path: string, fields: Record<string, { booleanValue?: boolean; integerValue?: string; stringValue?: string }>) {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  
  // Always use PATCH - creates if doesn't exist, updates if it does
  const mask = Object.keys(fields)
    .map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
    .join("&");
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}?${mask}`;
  
  console.log("[peer-stats] fsSet URL:", url);
  console.log("[peer-stats] fsSet fields:", JSON.stringify(fields));
  
  const r = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  
  const responseText = await r.text();
  console.log("[peer-stats] fsSet response:", r.status, responseText);
  
  if (!r.ok) throw new Error(`fsSet ${path} ${r.status}: ${responseText}`);
}

// In-memory cache: threshold changes only via admin save, which invalidates.
// Without this, every dashboard open + every question render costs 1 read.
let thresholdCache: { data: PeerStatsSettings; exp: number } | null = null;
const THRESHOLD_TTL_MS = 5 * 60_000;

export function invalidatePeerStatsCache(): void {
  thresholdCache = null;
}

export async function loadPeerStatsSettings(): Promise<PeerStatsSettings> {
  const now = Date.now();
  if (thresholdCache && thresholdCache.exp > now) return { ...thresholdCache.data };
  try {
    const doc = await fsGet("admin/peer_stats_settings");
    console.log("[peer-stats] load doc:", JSON.stringify(doc));
    if (!doc) {
      console.log("[peer-stats] doc is null, returning default");
      return { ...DEFAULT };
    }
    const f = doc?.fields || {};
    const rawThreshold = f.threshold?.integerValue;
    console.log("[peer-stats] rawThreshold:", rawThreshold);
    const threshold = rawThreshold !== undefined ? parseInt(rawThreshold, 10) : DEFAULT.threshold;
    const data = { threshold: Math.max(1, isNaN(threshold) ? DEFAULT.threshold : threshold) };
    thresholdCache = { data, exp: Date.now() + THRESHOLD_TTL_MS };
    return { ...data };
  } catch (e) {
    console.error("[peer-stats] load failed:", e);
    return { ...DEFAULT };
  }
}

export async function savePeerStatsSettings(patch: Partial<PeerStatsSettings>): Promise<PeerStatsSettings> {
  const cur = await loadPeerStatsSettings();
  const next: PeerStatsSettings = {
    threshold: typeof patch.threshold === "number" && patch.threshold >= 1 
      ? Math.floor(patch.threshold) 
      : cur.threshold,
  };
  console.log("[peer-stats] saving threshold:", next.threshold);
  // Firestore REST API expects integerValue as a string
  await fsSet("admin/peer_stats_settings", {
    threshold: { integerValue: String(next.threshold) },
  });
  console.log("[peer-stats] saved successfully");
  thresholdCache = { data: { ...next }, exp: Date.now() + THRESHOLD_TTL_MS };
  return next;
}
