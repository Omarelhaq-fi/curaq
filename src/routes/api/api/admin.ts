// Admin-only endpoints — gated to admin emails from admin.server.
// All privileged reads (users_index, admin/api_keys, credit config) go
// through this route so no client-SDK read ever touches admin documents.

import { createFileRoute } from "@tanstack/react-router";
import { gzipSync } from "node:zlib";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  verifyFirebaseIdToken,
  getServiceAccount,
  getGoogleAccessToken,
  fetchAuthLastLogins,
  fetchAuthUsers,
  invalidateKeyCache,
  dbStats,
} from "@/lib/firebase.server";
import {
  readCreditConfig,
  writeCreditConfig,
  grantBonusCredits,
  resetUserCredits,
  type Plan,
} from "@/lib/quota.server";
import { isAdminEmail } from "@/lib/admin.server";
import { getCorsHeaders } from "@/lib/cors";
import { getClientIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit.server";
import { loadPaymentsSettings, savePaymentsSettings, type PaymentsSettings } from "@/lib/payments-settings.server";
import { loadAuthSettings, saveAuthSettings, type AuthSettings } from "@/lib/auth-settings.server";
import { loadPeerStatsSettings, savePeerStatsSettings, type PeerStatsSettings } from "@/lib/peer-stats-settings.server";
import { invalidateQbankListCache, invalidateUserProfile } from "@/lib/qbank-cache.server";

// Any write under `qbanks/...` (settings, updatedAt bumps on publish/import,
// question/chunk edits) makes the cached qbank list stale — drop it so the
// next read repopulates. Paths are Firestore document paths like
// `qbanks/abc` or `qbanks/abc/questions/q1`.
function touchQbankListCache(path: string): void {
  if (path === "qbanks" || path.startsWith("qbanks/")) invalidateQbankListCache();
}
import { getKashierConfig } from "@/lib/kashier.server";
import {
  loadProvidersConfig,
  saveProvidersConfig,
  PROVIDER_META,
  MODEL_CATALOG,
  hashKey,
  defaultProvidersConfig,
  invalidateProvidersCache,
  type ProviderConfig,
  type ProvidersConfig,
  type ProviderId,
  loadCustomChains,
  saveCustomChains,
  type CustomChainsConfig,
} from "@/lib/ai-providers.server";
import { getCapacitySnapshot } from "@/lib/ai-capacity.server";
import { testKey } from "@/lib/ai-tester.server";
import { getRecentCalls, probeChainStep, routeRequest } from "@/lib/ai-router.server";
import { TASK_CHAINS, TASK_LABELS, probeFor, resolveChain } from "@/lib/task-chains.server";
import { ensureQIndex, qindexUpsert, qindexRemove } from "@/lib/qindex.server";


function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

type FSValue = {
  stringValue?: string;
  integerValue?: string;
  timestampValue?: string;
  nullValue?: null;
  booleanValue?: boolean;
  arrayValue?: { values?: Array<{ stringValue?: string }> };
  mapValue?: { fields?: Record<string, FSValue> };
};

// ---------- Globally-unique question codes ----------
// Alphabet without ambiguous chars (0/O/1/I). 8 chars => ~32^8 (~1.1e12) space.
const QCODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function generateQuestionCode(): string {
  let s = "";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  for (let i = 0; i < 8; i++) s += QCODE_ALPHABET[bytes[i] % 32];
  return "Q-" + s;
}

async function newUniqueCode(reserved: Set<string>): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateQuestionCode();
    const key = code.toUpperCase();
    if (reserved.has(key)) continue;
    reserved.add(key);
    return code;
  }
  return generateQuestionCode() + Date.now().toString(36).slice(-2).toUpperCase();
}

// ---------- Medical library books ----------
// Accepted import shape (also as an array of books):
//   { "title", "subject"?, "units": [{ "title", "chapters": [{ "title", "lessons": [{ "title", "body" }] }] }] }
// Shorthands: top-level "chapters" wraps into one unit; top-level "lessons"
// wraps into one unit + one chapter. Re-importing the same title overwrites
// the same book id (idempotent updates).
function libraryBookSlug(title: unknown): string {
  const s = String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return s || "book";
}

function normalizeLibraryBook(raw: any, fallbackTitle: string): { title: string; subject: string; units: any[]; lessonCount: number } {
  const title = String((raw && raw.title) || fallbackTitle || "Untitled Book").slice(0, 120);
  const subject = String((raw && raw.subject) || "").slice(0, 120);
  const r = (raw && typeof raw === "object") ? raw : {};
  const rawUnits = Array.isArray(r.units) ? r.units
    : Array.isArray(r.chapters) ? [{ title: "", chapters: r.chapters }]
    : Array.isArray(r.lessons) ? [{ title: "", chapters: [{ title: "", lessons: r.lessons }] }]
    : [];
  const units: any[] = [];
  let lessonCount = 0;
  for (const u of rawUnits) {
    if (!u || typeof u !== "object") continue;
    const uChapters = Array.isArray(u.chapters) ? u.chapters : (Array.isArray(u.lessons) ? [{ title: u.title, lessons: u.lessons }] : []);
    const chapters: any[] = [];
    for (const c of uChapters) {
      if (!c || typeof c !== "object") continue;
      const lessons = (Array.isArray(c.lessons) ? c.lessons : [])
        .filter((l: any) => l && typeof l === "object")
        .map((l: any) => ({ title: String(l.title || "Untitled lesson").slice(0, 140), body: String(l.body || "") }))
        .filter((l: any) => l.title || l.body);
      lessonCount += lessons.length;
      if (lessons.length) chapters.push({ title: String(c.title || "").slice(0, 140), lessons });
    }
    if (chapters.length) units.push({ title: String(u.title || "").slice(0, 140), chapters });
  }
  return { title, subject, units, lessonCount };
}

function toFields(patch: Record<string, string | number | boolean | Date | null>) {
  const out: Record<string, FSValue> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) out[k] = { nullValue: null };
    else if (typeof v === "boolean") out[k] = { booleanValue: v };
    else if (v instanceof Date) out[k] = { timestampValue: v.toISOString() };
    else if (typeof v === "number") out[k] = { integerValue: String(Math.floor(v)) };
    else out[k] = { stringValue: String(v) };
  }
  return out;
}

async function fsPatch(path: string, patch: Record<string, string | number | Date | null>) {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const mask = Object.keys(patch)
    .map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
    .join("&");
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}?${mask}`;
  const resp = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: toFields(patch) }),
  });
  if (!resp.ok) throw new Error(`Firestore patch failed: ${resp.status}`);
  touchQbankListCache(path);
}

async function fsSetMerge(path: string, fields: Record<string, FSValue>) {  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const mask = Object.keys(fields)
    .map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
    .join("&");
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}?${mask}`;
  const resp = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!resp.ok) throw new Error(`Firestore set failed: ${resp.status}`);
  touchQbankListCache(path);
}

// Concepts embedded into R2 chunk objects at publish time (per-lang map +
// legacy single fields). Served from R2 at 0 reads via get_study_concept's
// R2 map; stripped from client stems at serve time so downloads stay lean.
// Attached only when present — questions without concepts stay untouched.
function extractChunkConcepts(doc: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    const mapFields = doc.fields?.studyConcepts?.mapValue?.fields || {};
    const langs: Record<string, string> = {};
    for (const [k, v] of Object.entries(mapFields)) {
      const s = (v as any)?.stringValue;
      if (typeof s === "string" && s) langs[k] = s;
    }
    if (Object.keys(langs).length > 0) out.studyConcepts = langs;
    const legacy = doc.fields?.studyConcept?.stringValue;
    if (typeof legacy === "string" && legacy) out.studyConcept = legacy;
    const legacyLang = doc.fields?.studyConceptLang?.stringValue;
    if (typeof legacyLang === "string" && legacyLang) out.studyConceptLang = legacyLang;
  } catch { /* concepts are best-effort at publish */ }
  return out;
}

// Rebuilds the single sys/qbank_index document so that list_categories costs
// exactly 1 Firestore read regardless of how many QBanks exist.
// Call this after any admin action that changes QBank metadata (create/delete/edit/publish).
async function rebuildQbankIndex(): Promise<void> {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const qbanks: any[] = [];
  let pageToken = "";
  while (true) {
    const params = new URLSearchParams({ pageSize: "300" });
    if (pageToken) params.set("pageToken", pageToken);
    const listRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks?${params}`,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
    );
    if (!listRes.ok && listRes.status !== 404) break;
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
        const isPartyLocked = doc.fields?.isPartyLocked?.booleanValue || doc.fields?.isPartyLocked?.stringValue === "true" || false;
        let resources = [];
        try { resources = JSON.parse(doc.fields?.resources?.stringValue || "[]"); } catch(e) {}
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
  // Write the whole list as a single JSON blob into sys/qbank_index
  const mask = "updateMask.fieldPaths=data&updateMask.fieldPaths=updatedAt";
  const indexUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/sys/qbank_index?${mask}`;
  await fetch(indexUrl, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        data: { stringValue: JSON.stringify(qbanks) },
        updatedAt: { integerValue: String(Date.now()) },
      }
    }),
  });
  // Also bust the in-memory cache so the current instance re-reads from the index
  invalidateQbankListCache();
}

async function fsGet(path: string) {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Firestore get failed: ${resp.status}`);
  return (await resp.json()) as { fields?: Record<string, FSValue> };
}

type ActivityIsos = {
  lastSeenIso?: string | null;
  lastActiveIso?: string | null;
  lastLoginIso?: string | null;
};

// Most recent of: AI/quota activity, UI heartbeat, Firebase Auth sign-in.
function activityIsoOf(u: ActivityIsos): string {
  return [u.lastActiveIso, u.lastSeenIso, u.lastLoginIso]
    .filter((v): v is string => !!v)
    .sort()
    .pop() || "";
}

async function fsListUsers(_limit = 500) {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  // Page through the whole collection — a single pageSize call silently
  // dropped everyone past the first page.
  const documents: Array<{ name: string; fields?: Record<string, FSValue> }> = [];
  let pageToken = "";
  for (let page = 0; page < 40; page++) {
    const params = new URLSearchParams({ pageSize: "300" });
    if (pageToken) params.set("pageToken", pageToken);
    const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users_index?${params}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`Firestore list failed: ${resp.status}`);
    const data = (await resp.json()) as {
      documents?: Array<{ name: string; fields?: Record<string, FSValue> }>;
      nextPageToken?: string;
    };
    documents.push(...(data.documents || []));
    pageToken = data.nextPageToken || "";
    if (!pageToken || documents.length >= _limit) break;
  }
  
  // Enforce the exact limit
  if (documents.length > _limit) documents.length = _limit;

  const users = documents.map((d) => {
    const uid = d.name.split("/").pop() || "";
    const f = d.fields || {};
    return {
      uid,
      email: f.email?.stringValue || "",
      plan: f.plan?.stringValue || "free",
      proUntil: f.proUntil?.timestampValue || null,
      credits: Number(f.credits?.integerValue ?? "-1"),
      creditsBonus: Number(f.creditsBonus?.integerValue || 0),
      creditsAllotment: Number(f.creditsAllotment?.integerValue || 0),
      creditsUsedThisMonth: Number(f.creditsUsedThisMonth?.integerValue || 0),
      docCount: Number(f.docCount?.integerValue || 0),
      flashcardCount: Number(f.flashcardCount?.integerValue || 0),
      qbankAnswerCount: Number(f.qbankAnswerCount?.integerValue || 0),
      lastSeenIso: f.lastSeenIso?.stringValue || null,
      lastActiveIso: f.lastActiveIso?.stringValue || null,
      lastActionLabel: f.lastActionLabel?.stringValue || null,
      lastLoginIso: null as string | null,
      createdIso: null as string | null,
      noProfile: false,
    };
  });

  // Firebase Auth is the source of truth for "who exists". Users who signed in
  // but never wrote to Firestore have no users_index doc at all.
  try {
    const authUsers = await fetchAuthUsers();
    const byUid = new Map(users.map((u) => [u.uid, u]));
    for (const a of authUsers) {
      const existing = byUid.get(a.uid);
      if (existing) {
        existing.lastLoginIso = a.lastLoginIso;
        existing.createdIso = a.createdIso;
        if (!existing.email) existing.email = a.email;
      } else {
        const row = {
          uid: a.uid,
          email: a.email,
          plan: "free",
          proUntil: null as string | null,
          credits: -1,
          creditsBonus: 0,
          creditsAllotment: 0,
          creditsUsedThisMonth: 0,
          docCount: 0,
          flashcardCount: 0,
          qbankAnswerCount: 0,
          lastSeenIso: null as string | null,
          lastActiveIso: null as string | null,
          lastActionLabel: null as string | null,
          lastLoginIso: a.lastLoginIso,
          createdIso: a.createdIso,
          noProfile: true,
        };
        users.push(row);
        byUid.set(a.uid, row);
      }
    }
  } catch (e) {
    console.warn("[admin] auth roster merge failed:", (e as Error).message);
    try {
      const logins = await fetchAuthLastLogins(users.map((u) => u.uid));
      for (const u of users) u.lastLoginIso = logins[u.uid] || null;
    } catch { /* non-fatal */ }
  }

  users.sort((a, b) => activityIsoOf(b).localeCompare(activityIsoOf(a)));
  return users;
}


async function fsDeleteDoc(path: string) {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}`;
  const resp = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok && resp.status !== 404) throw new Error(`Firestore delete failed: ${resp.status}`);
  touchQbankListCache(path);
  if (path.startsWith("users_index/")) {
    const parts = path.split("/");
    if (parts.length === 2 && parts[1]) invalidateUserProfile(parts[1]);
  }
}

type Body = {
  action:
    | "upgrade" | "upgrade_aplus" | "downgrade" | "reset_quota" | "grant_bonus"
    | "get_credit_config" | "set_credit_config"
    | "list_users" | "delete_user"
    | "get_api_keys" | "set_api_keys" | "set_maintenance"
    | "get_payments_settings" | "set_payments_settings"
    | "get_auth_settings" | "set_auth_settings"
    | "get_peer_stats_settings" | "set_peer_stats_settings"
    | "stats_overview" | "stats_user_detail"
    | "get_ai_providers" | "set_ai_providers" | "test_ai_key"
    | "get_ai_capacity" | "get_ai_recent_calls"
    | "list_ai_functions" | "check_ai_function" | "check_all_ai_functions" | "set_ai_custom_chains"
     | "create_qbank" | "list_qbanks" | "delete_qbank" | "add_qbank_question" | "batch_import_qbank_txt"
     | "list_qbank_questions" | "delete_qbank_question" | "delete_multiple_qbank_questions" | "update_qbank_question" | "rename_qbank_subject" | "rename_qbank_chapter" | "batch_rename_qbank_categories"
     | "list_library_books" | "import_library_json" | "delete_library_book" | "export_study_concepts" | "backfill_concepts_digest"
    | "edit_qbank_settings" | "clear_qbank_question_reports" | "list_reported_questions" | "backfill_qbank_codes"
    | "list_exam_prep" | "save_exam_prep" | "delete_exam_prep"
    | "upload_image"
    | "ai_generate_block"
    | "list_access_requests" | "resolve_access_request"
    | "whoami";
  uid?: string;
  days?: number;
  bonus?: number;
  config?: {
    plans: Record<Plan, number>;
    multipliers: Record<string, number>;
    featureCaps?: Record<Plan, Record<string, { daily: number; monthly: number }>>;
  };

  gemini?: string[];
  groq?: string[];
  groupId?: string;
  on?: boolean;
  payments?: Partial<PaymentsSettings>;
  authSettings?: Partial<AuthSettings>;
  providersConfig?: Partial<ProvidersConfig>;
  provider?: ProviderId;
  keyIndex?: number;
  key?: string;
  model?: string;
  task?: string;
  mode?: "first_success" | "full_chain" | "test_step" | "regenerate" | "missing";
  chains?: any;
  stepIndex?: number;
  
  qbankName?: string;
  qbankId?: string;
  questionId?: string;
  questionIds?: string[];
  questionText?: string;
  dataJson?: string;
  rawText?: string;
  country?: string;
  subcategories?: string;
  isLocked?: boolean;
  isPartyLocked?: boolean;
  resources?: { title: string, url: string, type: string }[];
  fileSubcategory?: string;
  bookTitle?: string;
  bookId?: string;
  chosenSubjects?: string[];
  imageBase64?: string;
  backfillMode?: "missing" | "regenerate";
  kind?: string;
  college?: string;
  year?: string;
  topic?: string;
  blockLang?: string;
  // legacy exam-prep link entries (unused collection, kept for compat)
  title?: string;
  description?: string;
  url?: string;
  type?: string;
  id?: string;
  qbankIds?: string[];
  renames?: any[];
  skipDuplicates?: boolean;
};


async function requireAuth(request: Request) {
  const auth = request.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Response("Unauthorized", { status: 401 });
  return await verifyFirebaseIdToken(m[1]);
}
async function requireAdmin(request: Request) {
  const user = await requireAuth(request);
  // Defense in depth: admin gate requires (a) email on the allowlist AND
  // (b) a verified email on the Firebase token. Prevents an attacker who
  // signed up with a look-alike unverified email from ever satisfying the
  // exact-match check even if the allowlist file is later widened.
  if (user.email_verified === false) {
    throw new Response("Forbidden", { status: 403 });
  }
  if (!(await isAdminEmail(user.email))) {
    throw new Response("Forbidden", { status: 403 });
  }
  return user;
}

function maskKey(k: string) {
  if (!k) return "";
  if (k.length <= 12) return k;
  return k.slice(0, 6) + "…" + k.slice(-4);
}

async function readApiKeysDoc() {
  const doc = await fsGet("admin/api_keys");
  const f = doc?.fields || {};
  const gemini = (f.gemini?.arrayValue?.values || [])
    .map((v) => v.stringValue || "")
    .filter(Boolean);
  let groq: string[] = [];
  if (f.groq?.arrayValue?.values) {
    groq = f.groq.arrayValue.values.map((v) => v.stringValue || "").filter(Boolean);
  } else if (f.groq?.stringValue) {
    groq = [f.groq.stringValue];
  }
  const mFields = f.maintenance?.mapValue?.fields || {};
  const global = !!mFields.global?.booleanValue;
  const grpFields = mFields.groups?.mapValue?.fields || {};
  const groups: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(grpFields)) {
    if (v.booleanValue) groups[k] = true;
  }
  return { gemini, groq, maintenance: { global, groups } };
}

function keysToFSValue(keys: string[]): FSValue {
  return {
    arrayValue: {
      values: keys.filter((k) => typeof k === "string" && k.length > 0).map((k) => ({ stringValue: k })),
    },
  };
}
function maintenanceToFSValue(m: { global: boolean; groups: Record<string, boolean> }): FSValue {
  const groupFields: Record<string, FSValue> = {};
  for (const [k, v] of Object.entries(m.groups)) groupFields[k] = { booleanValue: !!v };
  return {
    mapValue: {
      fields: {
        global: { booleanValue: !!m.global },
        groups: { mapValue: { fields: groupFields } },
      },
    },
  };
}

async function computeStatsOverview() {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  
  let totalUsers = 0, totalDocs = 0, totalFlashcards = 0;
  try {
    const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users_index:runAggregationQuery`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        structuredAggregationQuery: {
          structuredQuery: { from: [{ collectionId: "users_index" }] },
          aggregations: [
            { count: {}, alias: "c" },
            { sum: { field: { fieldPath: "docCount" } }, alias: "d" },
            { sum: { field: { fieldPath: "flashcardCount" } }, alias: "f" }
          ]
        }
      })
    });
    if (resp.ok) {
      const data = await resp.json();
      totalUsers = Number(data[0]?.result?.aggregateFields?.c?.integerValue || 0);
      totalDocs = Number(data[0]?.result?.aggregateFields?.d?.integerValue || data[0]?.result?.aggregateFields?.d?.doubleValue || 0);
      totalFlashcards = Number(data[0]?.result?.aggregateFields?.f?.integerValue || data[0]?.result?.aggregateFields?.f?.doubleValue || 0);
    }
  } catch(e) { console.error("[computeStatsOverview] aggregation error", e); }

  const now = Date.now();
  const day = 86400_000;
  
  const getActiveCount = async (days: number) => {
    try {
      const dateStr = new Date(now - days * day).toISOString();
      const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users_index:runAggregationQuery`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          structuredAggregationQuery: {
            structuredQuery: { 
              from: [{ collectionId: "users_index" }],
              where: {
                fieldFilter: {
                  field: { fieldPath: "lastSeenIso" },
                  op: "GREATER_THAN_OR_EQUAL",
                  value: { stringValue: dateStr }
                }
              }
            },
            aggregations: [{ count: {}, alias: "c" }]
          }
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        return Number(data[0]?.result?.aggregateFields?.c?.integerValue || 0);
      }
    } catch(e) { }
    return 0;
  };

  const [active24h, active7d, active30d] = await Promise.all([
    getActiveCount(1),
    getActiveCount(7),
    getActiveCount(30)
  ]);

  const topUsers: any[] = [];
  try {
    const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users_index:runQuery`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "users_index" }],
          orderBy: [{ field: { fieldPath: "docCount" }, direction: "DESCENDING" }],
          limit: 10
        }
      })
    });
    if (resp.ok) {
      const data = await resp.json();
      for (const d of data) {
        if (d.document) {
           const uid = d.document.name.split("/").pop() || "";
           const f = d.document.fields || {};
           topUsers.push({
             uid,
             email: f.email?.stringValue || "",
             plan: f.plan?.stringValue || "free",
             docCount: Number(f.docCount?.integerValue || 0),
             flashcardCount: Number(f.flashcardCount?.integerValue || 0),
             lastSeenIso: f.lastSeenIso?.stringValue || null,
           });
        }
      }
    }
  } catch(e) { console.error("[computeStatsOverview] query error", e); }

  return {
    totalUsers,
    active24h, active7d, active30d,
    totalDocs,
    totalFlashcards,
    topUsers,
  };
}

async function computeUserDetail(uid: string) {
  const [indexDoc, userDoc, pomoDoc] = await Promise.all([
    fsGet(`users_index/${uid}`),
    fsGet(`users/${uid}`),
    fsGet(`users/${uid}/meta/pomodoro`),
  ]);
  const idx = indexDoc?.fields || {};
  let authLastLogin: string | null = null;
  try {
    authLastLogin = (await fetchAuthLastLogins([uid]))[uid] || null;
  } catch { /* non-fatal */ }
  const raw = userDoc?.fields?.data?.stringValue || "";
  let parsed: Record<string, unknown> = {};
  try { parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { /* ignore */ }
  const docs = Array.isArray(parsed.documents) ? parsed.documents as Array<Record<string, unknown>> : [];
  const rems = Array.isArray(parsed.rems) ? parsed.rems as Array<Record<string, unknown>> : [];

  const flashByDoc: Record<string, number> = {};
  let totalFlashcards = 0;
  for (const r of rems) {
    if (r.isFlashcard) {
      const docId = String(r.docId || "");
      flashByDoc[docId] = (flashByDoc[docId] || 0) + 1;
      totalFlashcards++;
    }
  }

  let totalChunks = 0;
  let totalQuizzes = 0;
  let sectionsSummarized = 0;
  let sectionsExamTaken = 0;
  let sectionsSmartExplained = 0;
  let sectionsAnnotated = 0;
  const documentSummaries = docs.map((d) => {
    const sections = Array.isArray(d.sections) ? d.sections as Array<Record<string, unknown>> : [];
    let quizCount = 0;
    let smartExplainCount = 0;
    let annotatedCount = 0;
    for (const sec of sections) {
      if (sec.summaryCache || sec.summaryRead) sectionsSummarized++;
      const exam = Array.isArray(sec.examCache) ? (sec.examCache as unknown[]).length : 0;
      const mapped = Array.isArray(sec.mappedMcqCache) ? (sec.mappedMcqCache as unknown[]).length : 0;
      quizCount += exam + mapped;
      if (sec.examTaken) sectionsExamTaken++;
      if (sec.smartExplainCache) { sectionsSmartExplained++; smartExplainCount++; }
      if (sec.annotation) { sectionsAnnotated++; annotatedCount++; }
    }
    totalChunks += sections.length;
    totalQuizzes += quizCount;
    const id = String(d.id || "");
    return {
      id,
      name: String(d.title || d.name || "(untitled)"),
      chunkCount: sections.length,
      flashcardCount: flashByDoc[id] || 0,
      quizCount,
      smartExplainCount,
      annotatedCount,
      sourceType: String(d.sourceType || ""),
      createdAt: d.created ? new Date(Number(d.created)).toISOString() : null,
    };
  });

  // Pomodoro from users/{uid}/meta/pomodoro
  const pomoFields = pomoDoc?.fields || {};
  const sessionsJson = pomoFields.sessionsJson?.stringValue || "";
  let sessions: Array<Record<string, unknown>> = [];
  try { if (sessionsJson) sessions = JSON.parse(sessionsJson) as Array<Record<string, unknown>>; } catch { /* ignore */ }
  let totalFocusMinutes = 0;
  let sessionsCompleted = 0;
  for (const s of sessions) {
    if (s.phase === "focus" || s.type === "focus" || !s.phase) {
      const mins = Number(s.minutes || s.durationMin || 0);
      if (mins > 0) totalFocusMinutes += mins;
      sessionsCompleted++;
    }
  }
  let qbankAnswers = 0;
  try {
    const sa = getServiceAccount();
    const token = await getGoogleAccessToken();
    const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users_index/${uid}:runAggregationQuery`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        structuredAggregationQuery: {
          structuredQuery: { from: [{ collectionId: "qbank_progress" }] },
          aggregations: [{ count: {}, alias: "c" }]
        }
      })
    });
    if (resp.ok) {
      const data = await resp.json();
      qbankAnswers = Number(data[0]?.result?.aggregateFields?.c?.integerValue || 0);
    }
  } catch { /* ignore */ }

  return {
    uid,
    email: idx.email?.stringValue || "",
    plan: idx.plan?.stringValue || "free",
    proUntil: idx.proUntil?.timestampValue || null,
    credits: Number(idx.credits?.integerValue ?? "-1"),
    creditsBonus: Number(idx.creditsBonus?.integerValue || 0),
    creditsAllotment: Number(idx.creditsAllotment?.integerValue || 0),
    creditsUsedThisMonth: Number(idx.creditsUsedThisMonth?.integerValue || 0),
    lastSeenIso: idx.lastSeenIso?.stringValue || null,
    lastActiveIso: idx.lastActiveIso?.stringValue || null,
    lastActionLabel: idx.lastActionLabel?.stringValue || null,
    lastLoginIso: authLastLogin,
    docCount: documentSummaries.length,
    documents: documentSummaries.slice(0, 100),
    totalChunks,
    totalFlashcards,
    totalQuizzes,
    sectionsSummarized,
    sectionsExamTaken,
    sectionsSmartExplained,
    sectionsAnnotated,
    qbankAnswers,
    totalFocusMinutes,
    sessionsCompleted,
    hasData: !!raw,
    dataBytes: raw.length,

  };
}

export const Route = createFileRoute("/api/admin")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, POST, OPTIONS" });
        return new Response(null, { status: 204, headers: cors });
      },
      GET: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, POST, OPTIONS" });
        const ip = getClientIp(request);
        const rl = rateLimit(`admin:ip:${ip}`, 60_000, 60);
        if (!rl.ok) return rateLimitResponse(rl.retryAfter, cors);

        const url = new URL(request.url);
        const action = url.searchParams.get("action");

        if (action === "whoami") {
          return dbStats.run({reads: 0, writes: 0}, async () => {
            const store = dbStats.getStore();
            const statsHeaders = {
              "x-firestore-reads": store ? String(store.reads) : "0",
              "x-firestore-writes": store ? String(store.writes) : "0",
              ...cors,
            };
            try {
              await requireAdmin(request);
              return json({ admin: true }, 200, statsHeaders);
            } catch (e) {
              const msg = e instanceof Error ? e.message : "";
              if (msg.includes("FIREBASE_SERVICE_ACCOUNT_JSON")) {
                return json({ error: "Server auth not configured (FIREBASE_SERVICE_ACCOUNT_JSON missing)" }, 503, statsHeaders);
              }
              return json({ admin: false }, 200, statsHeaders);
            }
          });
        }

        try { await requireAdmin(request); }
        catch (e) {
          if (e instanceof Response) return json({ error: e.status === 403 ? "Forbidden" : "Unauthorized" }, e.status, cors);
          return json({ error: "Unauthorized" }, 401, cors);
        }

        try {
          if (action === "get_credit_config") return json(await readCreditConfig(), 200, cors);
          if (action === "list_users") return json({ users: await fsListUsers() }, 200, cors);
          if (action === "get_api_keys") {
            const k = await readApiKeysDoc();
            return json({
              gemini: k.gemini.map(maskKey), groq: k.groq.map(maskKey),
              geminiCount: k.gemini.length, groqCount: k.groq.length,
              maintenance: k.maintenance,
            }, 200, cors);
          }
          if (action === "get_payments_settings") {
            const settings = await loadPaymentsSettings();
            return json({ settings, kashierConfigured: getKashierConfig().configured }, 200, cors);
          }
          if (action === "get_auth_settings") {
            return json({ settings: await loadAuthSettings() }, 200, cors);
          }
          if (action === "get_peer_stats_settings") {
            return json({ settings: await loadPeerStatsSettings() }, 200, cors);
          }
          if (action === "stats_overview") {
            return json(await computeStatsOverview(), 200, cors);
          }
          if (action === "stats_user_detail") {
            const uid = url.searchParams.get("uid") || "";
            if (!uid || uid.length > 128) return json({ error: "Bad request" }, 400, cors);
            return json(await computeUserDetail(uid), 200, cors);
          }
          if (action === "get_ai_providers") {
            const cfg = await loadProvidersConfig(true);
            const meta = Object.fromEntries(
              Object.entries(PROVIDER_META).map(([id, m]) => [
                id,
                {
                  id: m.id,
                  label: m.label,
                  defaultRpd: m.defaultRpd,
                  defaultRpm: m.defaultRpm,
                  rpdByModel: m.rpdByModel || {},
                  catalog: MODEL_CATALOG[m.id] || [],
                  supportsJsonMode: m.supportsJsonMode,
                },
              ]),
            );
            const masked: Record<string, unknown> = {};
            for (const [id, p] of Object.entries(cfg)) {
              masked[id] = {
                enabled: p.enabled,
                priority: p.priority,
                models: p.models,
                keys: p.keys.map((k) => ({ hash: hashKey(k), masked: maskKey(k) })),
              };
            }
            return json({ providers: masked, meta, defaults: defaultProvidersConfig() }, 200, cors);
          }
          if (action === "get_ai_capacity") {
            return json(await getCapacitySnapshot(), 200, cors);
          }
          if (action === "get_ai_recent_calls") {
            return json({ calls: getRecentCalls() }, 200, cors);
          }
          if (action === "list_ai_functions") {
            const cfgFns = await loadProvidersConfig();
            const customChains = await loadCustomChains();
            const tasks = Object.keys(TASK_CHAINS).map((task) => ({
              task,
              label: TASK_LABELS[task] || task,
              chain: resolveChain(task, cfgFns, customChains),
              baseChain: resolveChain(task, cfgFns, {}),
              customChain: customChains[task] || [],
            }));
            return json({ tasks }, 200, cors);
          }
          
          if (action === "list_qbanks") {
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();
            const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks`;
            const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
            if (!resp.ok && resp.status !== 404) throw new Error(`Firestore list qbanks failed: ${resp.status}`);
            if (resp.status === 404) return json({ qbanks: [] }, 200, cors);
            const data = (await resp.json()) as { documents?: Array<{ name: string; fields?: Record<string, FSValue> }> };
            const qbanks = (data.documents || []).map(d => {
              let resources = [];
              try { resources = JSON.parse(d.fields?.resources?.stringValue || "[]"); } catch(e) {}
              return {
                id: d.name.split("/").pop() || "",
                name: d.fields?.name?.stringValue || "(unnamed)",
                country: d.fields?.country?.stringValue || "global",
                subcategories: d.fields?.subcategories?.stringValue || "",
                isLocked: d.fields?.isLocked?.booleanValue || d.fields?.isLocked?.stringValue === "true" || false,
                isPartyLocked: d.fields?.isPartyLocked?.booleanValue || d.fields?.isPartyLocked?.stringValue === "true" || false,
                resources,
                kind: d.fields?.kind?.stringValue || "main",
                college: d.fields?.college?.stringValue || "",
                year: d.fields?.year?.stringValue || ""
              };
            });
            return json({ qbanks }, 200, cors);
          }

          if (action === "get_qbank_question_count") {
            const qbankId = url.searchParams.get("qbankId");
            if (!qbankId) return json({ error: "Missing qbankId" }, 400, cors);
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();
            let count = 0;
            try {
              const qUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}:runAggregationQuery`;
              const resp = await fetch(qUrl, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  structuredAggregationQuery: {
                    structuredQuery: { from: [{ collectionId: "questions" }] },
                    aggregations: [{ count: {}, alias: "c" }]
                  }
                })
              });
              if (resp.ok) {
                const data = await resp.json();
                count = Number(data[0]?.result?.aggregateFields?.c?.integerValue || 0);
              }
            } catch (err) {
              console.error("[get_qbank_question_count] Aggregation failed", err);
            }
            return json({ count }, 200, cors);
          }

          if (action === "list_exam_prep") {
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();
            const items: any[] = [];
            let epToken = "";
            while (true) {
              const params = new URLSearchParams({ pageSize: "300" });
              if (epToken) params.set("pageToken", epToken);
              const r = await fetch(
                `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/exam_prep?${params}`,
                { headers: { Authorization: `Bearer ${token}` } }
              );
              if (!r.ok && r.status !== 404) return json({ error: "Failed to load exam prep entries" }, 500, cors);
              if (r.status === 404) break;
              const d = await r.json();
              for (const doc of (d.documents || [])) {
                const id = doc.name.split("/").pop();
                let qbankIds: string[] = [];
                try {
                  qbankIds = (doc.fields?.qbankIds?.arrayValue?.values || []).map((v: any) => v.stringValue || "").filter(Boolean);
                } catch {}
                items.push({
                  id,
                  title: doc.fields?.title?.stringValue || "(untitled)",
                  description: doc.fields?.description?.stringValue || "",
                  url: doc.fields?.url?.stringValue || "",
                  type: doc.fields?.type?.stringValue || "link",
                  country: doc.fields?.country?.stringValue || "global",
                  college: doc.fields?.college?.stringValue || "",
                  year: doc.fields?.year?.stringValue || "",
                  qbankIds
                });
              }
              epToken = d.nextPageToken || "";
              if (!epToken) break;
            }
            return json({ items }, 200, cors);
          }

          return json({ ok: true }, 200, cors);

        } catch (e) {
          console.error("[admin]", (e as Error).message);
          return json({ error: "Server error" }, 500, cors);
        }
      },
      POST: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, POST, OPTIONS" });
        const ip = getClientIp(request);
        const rl = rateLimit(`admin:ip:${ip}`, 60_000, 30);
        if (!rl.ok) return rateLimitResponse(rl.retryAfter, cors);

        let actor;
        try { actor = await requireAdmin(request); }
        catch (e) {
          if (e instanceof Response) return json({ error: e.status === 403 ? "Forbidden" : "Unauthorized" }, e.status, cors);
          return json({ error: "Unauthorized" }, 401, cors);
        }

        let body: Body;
        try { body = (await request.json()) as Body; }
        catch { return json({ error: "Bad request" }, 400, cors); }

        // Fire-and-forget audit log — writes an append-only record for every
        // admin POST. Non-blocking: audit failures never block the action.
        const MUTATING_ACTIONS = new Set([
          "upgrade", "upgrade_aplus", "downgrade", "reset_quota", "grant_bonus",
          "set_credit_config", "delete_user",
          "set_api_keys", "set_maintenance", "set_payments_settings", "set_auth_settings", "set_peer_stats_settings",
          "create_qbank", "delete_qbank", "add_qbank_question", "batch_import_qbank_txt",
          "import_library_json", "delete_library_book", "backfill_concepts_digest",
          "rename_qbank_subject", "rename_qbank_chapter", "batch_rename_qbank_categories"
        ]);
        if (MUTATING_ACTIONS.has(body.action)) {
          const auditId = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
          const audit: Record<string, string | number | null> = {
            actorUid: actor.sub,
            actorEmail: (actor.email as string) || "",
            action: body.action,
            targetUid: body.uid || "",
            ip,
            ts: Date.now(),
            details: JSON.stringify({
              days: body.days, bonus: body.bonus, groupId: body.groupId, on: body.on,
              geminiCount: Array.isArray(body.gemini) ? body.gemini.length : undefined,
              groqCount: Array.isArray(body.groq) ? body.groq.length : undefined,
              payments: body.payments ? Object.keys(body.payments) : undefined,
              config: body.config ? Object.keys(body.config) : undefined,
            }).slice(0, 2000),
          };
          fsSetMerge(`admin_audit/${auditId}`, toFields(audit)).catch((e) =>
            console.warn("[admin:audit] write failed:", (e as Error).message),
          );
        }

        try {
          if (body.action === "set_credit_config") {
            if (!body.config || !body.config.plans || !body.config.multipliers) {
              return json({ error: "Bad request" }, 400, cors);
            }
            const plans: Record<Plan, number> = {
              free: Math.max(0, Math.min(10_000_000, Math.floor(body.config.plans.free ?? 0))),
              pro: Math.max(0, Math.min(10_000_000, Math.floor(body.config.plans.pro ?? 0))),
              aplus: Math.max(0, Math.min(10_000_000, Math.floor(body.config.plans.aplus ?? 0))),
            };
            const multipliers: Record<string, number> = {};
            for (const [k, v] of Object.entries(body.config.multipliers)) {
              if (typeof v === "number" && v > 0 && v < 1000 && k.length > 0 && k.length < 100) {
                multipliers[k] = v;
              }
            }
            const featureCaps: Record<Plan, Record<string, { daily: number; monthly: number }>> = { free: {}, pro: {}, aplus: {} };
            if (body.config.featureCaps) {
              for (const plan of ["free", "pro", "aplus"] as Plan[]) {
                if (body.config.featureCaps[plan]) {
                  for (const [k, v] of Object.entries(body.config.featureCaps[plan])) {
                    if (!k || k.length > 40 || !v) continue;
                    const daily = Math.max(0, Math.min(100000, Math.floor(Number((v as any).daily) || 0)));
                    const monthly = Math.max(0, Math.min(1000000, Math.floor(Number((v as any).monthly) || 0)));
                    featureCaps[plan][k] = { daily, monthly };
                  }
                }
              }
            }
            await writeCreditConfig({ plans, multipliers, featureCaps });
            return json({ ok: true }, 200, cors);
          }

          if (body.action === "get_credit_config") return json(await readCreditConfig(), 200, cors);
          if (body.action === "list_users") return json({ users: await fsListUsers() }, 200, cors);

          if (body.action === "get_api_keys") {
            const k = await readApiKeysDoc();
            return json({
              gemini: k.gemini.map(maskKey), groq: k.groq.map(maskKey),
              geminiCount: k.gemini.length, groqCount: k.groq.length,
              maintenance: k.maintenance,
            }, 200, cors);
          }
          if (body.action === "set_api_keys") {
            const cur = await readApiKeysDoc();
            const gemini = Array.isArray(body.gemini) ? body.gemini.filter((s) => typeof s === "string" && s.length > 6 && s.length < 500) : cur.gemini;
            const groq = Array.isArray(body.groq) ? body.groq.filter((s) => typeof s === "string" && s.length > 6 && s.length < 500) : cur.groq;
            await fsSetMerge("admin/api_keys", {
              gemini: keysToFSValue(gemini),
              groq: keysToFSValue(groq),
            });
            invalidateKeyCache();
            return json({ ok: true, geminiCount: gemini.length, groqCount: groq.length }, 200, cors);
          }
          if (body.action === "set_maintenance") {
            const cur = await readApiKeysDoc();
            const m = { global: cur.maintenance.global, groups: { ...cur.maintenance.groups } };
            if (body.groupId === "__global__") m.global = !!body.on;
            else if (typeof body.groupId === "string" && body.groupId.length > 0 && body.groupId.length < 40) {
              m.groups[body.groupId] = !!body.on;
            } else return json({ error: "Bad request" }, 400, cors);
            await fsSetMerge("admin/api_keys", { maintenance: maintenanceToFSValue(m) });
            invalidateKeyCache();
            return json({ ok: true, maintenance: m }, 200, cors);
          }

          if (body.action === "get_payments_settings") {
            const settings = await loadPaymentsSettings();
            return json({ settings, kashierConfigured: getKashierConfig().configured }, 200, cors);
          }
          if (body.action === "set_payments_settings") {
            if (!body.payments || typeof body.payments !== "object") {
              return json({ error: "Bad request" }, 400, cors);
            }
            const settings = await savePaymentsSettings(body.payments);
            return json({ ok: true, settings }, 200, cors);
          }

          if (body.action === "get_auth_settings") {
            return json({ settings: await loadAuthSettings() }, 200, cors);
          }
          if (body.action === "set_auth_settings") {
            if (!body.authSettings || typeof body.authSettings !== "object") {
              return json({ error: "Bad request" }, 400, cors);
            }
            const settings = await saveAuthSettings(body.authSettings);
            return json({ ok: true, settings }, 200, cors);
          }

          if (body.action === "get_peer_stats_settings") {
            return json({ settings: await loadPeerStatsSettings() }, 200, cors);
          }
          if (body.action === "set_peer_stats_settings") {
            if (!body.settings || typeof body.settings !== "object") {
              return json({ error: "Bad request" }, 400, cors);
            }
            const settings = await savePeerStatsSettings(body.settings);
            return json({ ok: true, settings }, 200, cors);
          }

          if (body.action === "set_ai_providers") {
            if (!body.providersConfig || typeof body.providersConfig !== "object") {
              return json({ error: "Bad request" }, 400, cors);
            }
            const current = await loadProvidersConfig(true);
            const next: ProvidersConfig = { ...current };
            const ROLES: ModelRole[] = ["volumeJson", "longContext", "micro", "chat"];
            for (const [id, patch] of Object.entries(body.providersConfig)) {
              if (!(id in current)) continue;
              const cur = current[id as ProviderId];
              const p = patch as { enabled?: boolean; priority?: number; keys?: unknown; models?: Partial<typeof cur.models> };
              let mergedKeys = cur.keys;
              if (Array.isArray(p.keys)) {
                const byHash = new Map(cur.keys.map((k) => [hashKey(k), k]));
                mergedKeys = (p.keys as unknown[])
                  .map((entry): string | null => {
                    if (typeof entry === "string") {
                      if (!entry || entry.includes("…") || entry.includes("•")) return null;
                      return entry.length > 6 && entry.length < 500 ? entry : null;
                    }
                    if (entry && typeof entry === "object") {
                      const e = entry as { hash?: string; raw?: string };
                      if (e.hash && byHash.has(e.hash)) return byHash.get(e.hash) || null;
                      if (typeof e.raw === "string" && e.raw.length > 6 && e.raw.length < 500) return e.raw;
                    }
                    return null;
                  })
                  .filter((k): k is string => !!k)
                  .slice(0, 20);
              }
              next[id as ProviderId] = {
                enabled: typeof p.enabled === "boolean" ? p.enabled : cur.enabled,
                priority: typeof p.priority === "number"
                  ? Math.max(1, Math.min(100, Math.floor(p.priority)))
                  : cur.priority,
                keys: mergedKeys,
                models: {
                  ...cur.models,
                  ...(p.models
                    ? Object.fromEntries(
                        ROLES
                          .filter((r) => typeof p.models?.[r] === "string" && p.models[r].length > 0)
                          .map((r) => [r, p.models![r]]),
                      )
                    : {}),
                } as typeof cur.models,
              };
            }
            await saveProvidersConfig(next);
            invalidateProvidersCache();
            invalidateKeyCache();
            return json({ ok: true }, 200, cors);
          }

          if (body.action === "test_ai_key") {
            if (!body.provider || typeof body.provider !== "string") {
              return json({ error: "Bad request" }, 400, cors);
            }
            const cfg = await loadProvidersConfig(true);
            const p = cfg[body.provider];
            if (!p) return json({ error: "Unknown provider" }, 400, cors);
            // Accept either a raw key (for draft keys not yet saved) or a
            // keyIndex referencing the persisted pool.
            let key: string | undefined;
            if (typeof body.key === "string" && body.key.length > 6 && body.key.length < 500 && !body.key.includes("…") && !body.key.includes("•")) {
              key = body.key;
            } else {
              const idx = typeof body.keyIndex === "number" ? body.keyIndex : 0;
              key = p.keys[idx];
            }
            if (!key) return json({ error: "Key not found — save changes first, then retry Test." }, 404, cors);
            const model = body.model || p.models.chat || p.models.volumeJson;
            const result = await testKey(body.provider, key, model);
            return json(result, 200, cors);
          }

          if (body.action === "create_qbank") {
            if (!body.qbankName) return json({ error: "Missing qbankName" }, 400, cors);
            const id = crypto.randomUUID();
            await fsSetMerge(`qbanks/${id}`, toFields({ 
              name: body.qbankName,
              country: body.country || "global",
              subcategories: body.subcategories || "",
              kind: body.kind === "exam_prep" ? "exam_prep" : "main",
              college: body.college || "",
              year: body.year || "",
              updatedAt: Date.now()
            }));
            rebuildQbankIndex().catch(e => console.error("[index] create_qbank rebuild failed:", e.message));
            return json({ ok: true, id }, 200, cors);
          }

          if (body.action === "delete_qbank") {
            if (!body.qbankId) return json({ error: "Missing qbankId" }, 400, cors);
            await fsDeleteDoc(`qbanks/${body.qbankId}`);
            rebuildQbankIndex().catch(e => console.error("[index] delete_qbank rebuild failed:", e.message));
            return json({ ok: true }, 200, cors);
          }

          if (body.action === "edit_qbank_settings") {
            if (!body.qbankId) return json({ error: "Missing qbankId" }, 400, cors);
            // Only overwrite fields that were explicitly sent (safe partial merge)
            const epPatch: Record<string, FSValue> = { updatedAt: { integerValue: String(Date.now()) } };
            if (typeof body.subcategories === "string") epPatch.subcategories = { stringValue: body.subcategories };
            if (typeof body.isLocked === "boolean") epPatch.isLocked = { booleanValue: body.isLocked };
            if (typeof body.isPartyLocked === "boolean") epPatch.isPartyLocked = { booleanValue: body.isPartyLocked };
            if (body.resources !== undefined) epPatch.resources = { stringValue: JSON.stringify(Array.isArray(body.resources) ? body.resources : []) };
            if (typeof body.college === "string") epPatch.college = { stringValue: body.college };
            if (typeof body.year === "string") epPatch.year = { stringValue: body.year };
            if (typeof body.country === "string" && body.country.trim()) epPatch.country = { stringValue: body.country.trim() };
            if (typeof body.qbankName === "string" && body.qbankName.trim()) epPatch.name = { stringValue: body.qbankName.trim() };
            await fsSetMerge(`qbanks/${body.qbankId}`, epPatch);
            rebuildQbankIndex().catch(e => console.error("[index] edit_qbank_settings rebuild failed:", e.message));
            return json({ ok: true }, 200, cors);
          }

          // ---------- EXAM PREP ----------
          if (body.action === "list_exam_prep") {
            const sa2 = getServiceAccount();
            const token2 = await getGoogleAccessToken();
            const items: any[] = [];
            let epToken = "";
            while (true) {
              const params = new URLSearchParams({ pageSize: "300" });
              if (epToken) params.set("pageToken", epToken);
              const r = await fetch(
                `https://firestore.googleapis.com/v1/projects/${sa2.project_id}/databases/(default)/documents/exam_prep?${params}`,
                { headers: { Authorization: `Bearer ${token2}` } }
              );
              if (!r.ok && r.status !== 404) return json({ error: "Failed to load exam prep entries" }, 500, cors);
              if (r.status === 404) break;
              const d = await r.json();
              for (const doc of (d.documents || [])) {
                const id = doc.name.split("/").pop();
                let qbankIds: string[] = [];
                try {
                  qbankIds = (doc.fields?.qbankIds?.arrayValue?.values || []).map((v: any) => v.stringValue || "").filter(Boolean);
                } catch {}
                items.push({
                  id,
                  title: doc.fields?.title?.stringValue || "(untitled)",
                  description: doc.fields?.description?.stringValue || "",
                  url: doc.fields?.url?.stringValue || "",
                  type: doc.fields?.type?.stringValue || "link",
                  country: doc.fields?.country?.stringValue || "global",
                  college: doc.fields?.college?.stringValue || "",
                  year: doc.fields?.year?.stringValue || "",
                  qbankIds
                });
              }
              epToken = d.nextPageToken || "";
              if (!epToken) break;
            }
            return json({ items }, 200, cors);
          }

          if (body.action === "save_exam_prep") {
            if (!body.title) return json({ error: "Missing title" }, 400, cors);
            const id = body.id || crypto.randomUUID();
            const epFields: Record<string, FSValue> = {
              title: { stringValue: String(body.title) },
              description: { stringValue: String(body.description || "") },
              url: { stringValue: String(body.url || "") },
              type: { stringValue: String(body.type || "link") },
              country: { stringValue: String(body.country || "global") },
              college: { stringValue: String(body.college || "") },
              year: { stringValue: String(body.year || "") },
              updatedAt: { integerValue: String(Date.now()) }
            };
            // qbankIds stored as a real string array for easy querying
            epFields.qbankIds = {
              arrayValue: {
                values: (Array.isArray(body.qbankIds) ? body.qbankIds : []).map((q: string) => ({ stringValue: String(q) }))
              }
            };
            await fsSetMerge(`exam_prep/${id}`, epFields);
            return json({ ok: true, id }, 200, cors);
          }

          if (body.action === "delete_exam_prep") {
            if (!body.id) return json({ error: "Missing id" }, 400, cors);
            await fsDeleteDoc(`exam_prep/${body.id}`);
            return json({ ok: true }, 200, cors);
          }

          // Upload an image (base64 data URL) to imgbb — used by the rich
          // question editor. Key stays server-side via env var.
          if (body.action === "upload_image") {
            const b64: string = typeof body.imageBase64 === "string" ? body.imageBase64 : "";
            if (!b64.startsWith("data:image/")) return json({ error: "Missing imageBase64" }, 400, cors);
            if (b64.length > 10 * 1024 * 1024) return json({ error: "Image too large" }, 413, cors);
            const key = process.env.IMGBB_API_KEY;
            if (!key) return json({ error: "IMGBB_API_KEY not configured on server" }, 503, cors);
            const fd = new URLSearchParams();
            fd.set("image", b64.replace(/^data:[^,]+,/, ""));
            const upRes = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(key)}`, {
              method: "POST",
              body: fd,
            });
            const upData = await upRes.json().catch(() => null) as any;
            if (!upData || !upData.success || !upData?.data?.url) {
              console.error("[imgbb] upload failed:", JSON.stringify(upData)?.slice(0, 300));
              return json({ error: "Image upload failed" }, 502, cors);
            }
            return json({ url: upData.data.url, deleteUrl: upData.data.delete_url || null }, 200, cors);
          }
          // ---------- END EXAM PREP ----------

          if (body.action === "publish_qbank_chunks") {
            const { qbankId } = body;
            if (!qbankId) return json({ error: "Missing qbankId" }, 400, cors);
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();

            // 1. Fetch all questions
            const questions: any[] = [];
            let pageToken = "";
            while (true) {
              const params = new URLSearchParams({ pageSize: "300" });
              if (pageToken) params.set("pageToken", pageToken);
              const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}/questions?${params}`;
              const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
              if (!resp.ok && resp.status !== 404) return json({ error: `Firestore fetch failed: ${resp.status}` }, 500, cors);
              if (resp.status === 404) break;

              const data = await resp.json();
              if (data.documents) {
                for (const doc of data.documents) {
                  const id = doc.name.split("/").pop();
                  const text = doc.fields?.questionText?.stringValue || "";
                  const dataStr = doc.fields?.data?.stringValue;
                  if (dataStr) {
                    try {
                      // Concepts ride along in the R2 snapshot (0-read serving
                      // via get_study_concept's R2 map). Stripped from client
                      // stems at serve time so downloads stay lean.
                      questions.push({ id, text, data: JSON.parse(dataStr), ...extractChunkConcepts(doc) });
                    } catch (e) {}
                  }
                }
              }
              pageToken = data.nextPageToken || "";
              if (!pageToken) break;
            }
            
            // 2. Delete existing chunks (if any)
            let chunkListToken = "";
            while (true) {
              const params = new URLSearchParams({ pageSize: "300" });
              if (chunkListToken) params.set("pageToken", chunkListToken);
              const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}/chunks?${params}`;
              const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
              if (!resp.ok) break;
              const data = await resp.json();
              if (data.documents && data.documents.length > 0) {
                 const writes = data.documents.map((d: any) => ({ delete: d.name }));
                 await fetch(`https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents:commit`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                    body: JSON.stringify({ writes })
                 });
              }
              chunkListToken = data.nextPageToken || "";
              if (!chunkListToken) break;
            }

            // 3. Write new chunks to Cloudflare R2
            const s3Client = new S3Client({
              region: "auto",
              endpoint: process.env.R2_ENDPOINT!,
              forcePathStyle: true,
              credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID!,
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
              },
            });
            const rawJson = JSON.stringify(questions);
            const compressedStr = gzipSync(Buffer.from(rawJson, 'utf-8'));
            
            await s3Client.send(new PutObjectCommand({
              Bucket: process.env.R2_BUCKET_NAME || "curaq",
              Key: `qbanks/${qbankId}/chunks.json.gz`,
              Body: compressedStr,
              ContentType: "application/gzip",
            }));

            // 4. Update qbank metadata
            const metaUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}?updateMask.fieldPaths=chunkCount&updateMask.fieldPaths=updatedAt&updateMask.fieldPaths=storage_provider`;
            await fetch(metaUrl, {
              method: "PATCH",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                fields: {
                  chunkCount: { integerValue: "1" },
                  updatedAt: { integerValue: String(Date.now()) },
                  storage_provider: { stringValue: "r2" }
                }
              })
            });

            rebuildQbankIndex().catch(e => console.error("[index] publish_qbank rebuild failed:", e.message));
            return json({ ok: true, chunksGenerated: 1, totalQuestions: questions.length }, 200, cors);
          }
          if (body.action === "add_qbank_question") {
            if (!body.qbankId || !body.rawText) return json({ error: "Missing qbankId or rawText" }, 400, cors);
            
            let finalSubcategories = body.subcategories;
            if (!finalSubcategories) {
              const qbDoc = await fsGet(`qbanks/${body.qbankId}`);
              if (qbDoc && qbDoc.fields?.subcategories?.stringValue) {
                finalSubcategories = qbDoc.fields.subcategories.stringValue;
              }
            }
            
            // Call AI to format the raw text
            const r = await routeRequest({
              messages: [{
                role: "user",
                content: `You are a medical data extraction bot. Your ONLY job is to extract EVERY SINGLE individual question from the provided text.

CRITICAL RULES - READ CAREFULLY:
1. DO NOT SUMMARIZE. DO NOT GROUP QUESTIONS. If there are 127 questions in the text, you MUST extract exactly 127 distinct questions.
2. DO NOT STOP early. You must process the text until the very end.
3. Look for numbers like "1.", "2.", "QCM 1" to know where a new question starts.
4. Keep the exact original language.
5. Remove the numbering prefixes (e.g. "1.", "QCM 1") from the 'questionText'.
6. CRITICAL: If a group of questions shares a clinical case context (e.g. "Cas clinique 1" followed by a paragraph), you MUST prepend that ENTIRE context paragraph to the 'questionText' of EVERY SINGLE question that belongs to that case. REMOVE prefixes like "Cas clinique 1" or "Cas clinique 2" from the text you prepend. Example 'questionText': "[Context paragraph...] \n\n [Question text]".
7. For clinical cases, set the 'subject' EXACTLY to "Cas cliniques". For others, ${finalSubcategories ? `assign a medical sub-category STRICTLY choosing from this list: [${finalSubcategories}]` : "assign a medical sub-category in the original language"}. If the text specifies a chapter (sub-subcategory), include it in the 'chapter' field.
8. The 'questionText' MUST NOT contain the options themselves. Stop the 'questionText' before the options begin.
9. The 'options' array MUST contain the full descriptive text of each option, NOT just the letters "A", "B", "C". Remove the prefix letter (e.g. "A.") from the option text.
10. CRITICAL: For the 'explanation' field, you MUST extract the ENTIRE, complete text of the explanation exactly as provided. DO NOT summarize it, truncate it, or be lazy.

Provide a JSON object with a "questions" array inside a markdown block.

Example Output:
\`\`\`json
{
  "questions": [
    { "questionText": "What are the first steps?", "options": ["Intubation", "Ventilation au masque"], "correctIndices": [0], "explanation": "...", "subject": "...", "chapter": "..." },
    { "questionText": "Question 2...", "options": ["Option 1", "Option 2", "Option 3"], "correctIndices": [1], "explanation": "...", "subject": "...", "chapter": "..." }
  ]
}
\`\`\`

For multiple correct answers, include all correct zero-based indices (e.g. [0, 1]). 

Text to process:\n${body.rawText}`
              }],
              requireJson: false,
              temperature: 0.2,
              task: "extract_qbank_questions"
            });
            
            // Fetch existing questions to check for duplicates (limit to 1000 to prevent read spikes)
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();
            let existingTexts: string[] = [];
            let pageToken = "";
            let fetchedCount = 0;
            while (fetchedCount < 1000) {
               const params = new URLSearchParams({ pageSize: "300" });
               if (pageToken) params.set("pageToken", pageToken);
               const existingRes = await fetch(`https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${body.qbankId}/questions?${params}`, { headers: { Authorization: `Bearer ${token}` }});
               if (!existingRes.ok && existingRes.status !== 404) break;
               if (existingRes.status === 404) break;
               const exData = await existingRes.json();
               if (exData.documents) {
                  fetchedCount += exData.documents.length;
                  existingTexts.push(...exData.documents.map((d: any) => d.fields?.questionText?.stringValue?.toLowerCase().replace(/[^a-z0-9]/g, "") || ""));
               }
               pageToken = exData.nextPageToken || "";
               if (!pageToken) break;
            }
            
            let parsed;
            try {
              console.log("[QBank Gen] AI Output length:", r.text.length);
              
              let textToParse = r.text;
              // Extract just the JSON block from the output
              const match = textToParse.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
              if (match) {
                 textToParse = match[1];
              } else {
                 // Try finding first { and last }
                 const firstBrace = textToParse.indexOf("{");
                 const lastBrace = textToParse.lastIndexOf("}");
                 if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                    textToParse = textToParse.substring(firstBrace, lastBrace + 1);
                 }
              }
              
              // Handle potential truncation: if it doesn't end with a bracket/brace, it's truncated
              const cleanText = textToParse.trim();
              if (!cleanText.endsWith("]") && !cleanText.endsWith("}")) {
                console.error("[QBank Gen] Output appears truncated!");
                const lastClose = textToParse.lastIndexOf("}");
                if (lastClose !== -1) {
                   textToParse = textToParse.substring(0, lastClose + 1);
                   // Close the array and object assuming format is {"questions": [...]}
                   textToParse += "\n  ]\n}";
                }
              }
              
              parsed = JSON.parse(textToParse);
              console.log("[QBank Gen] Parsed array length:", Array.isArray(parsed) ? parsed.length : 1);
              if (!Array.isArray(parsed)) {
                // If the AI didn't return an array for some reason, check if it wrapped it in an object
                if (parsed.questions && Array.isArray(parsed.questions)) {
                  parsed = parsed.questions;
                } else if (parsed.data && Array.isArray(parsed.data)) {
                  parsed = parsed.data;
                } else {
                  parsed = [parsed];
                }
              }
            } catch {
              return json({ error: "AI failed to output valid JSON", rawOutput: r.text }, 500, cors);
            }
            
            const questionIds: string[] = [];
            let duplicatesSkipped = 0;
            let parseIndex = 0;
            
            // Pre-mint globally-unique codes for this AI batch
            const aiCodePool: string[] = [];
            {
              const reserved = new Set<string>();
              for (let i = 0; i < parsed.length + 5; i++) {
                aiCodePool.push(await newUniqueCode(reserved));
              }
            }
            const importedForIndex: { id: string; code: string }[] = [];

            for (const q of parsed) {
              parseIndex++;
              const text = q.questionText || q.question || q.text || q.q;
              if (!text) continue;
              
              const cleanText = text.toLowerCase().replace(/[^a-z0-9]/g, "");
              if (existingTexts.includes(cleanText)) {
                duplicatesSkipped++;
                continue;
              }
              
              let correctIndices = Array.isArray(q.correctIndices) ? q.correctIndices : (Array.isArray(q.correctIndex) ? q.correctIndex : [Number(q.correctIndex || 0)]);
              correctIndices = correctIndices.map((n: any) => Number(n)).filter((n: number) => !isNaN(n));
              if (correctIndices.length === 0) correctIndices = [0];

              const qId = crypto.randomUUID();
              const minted = aiCodePool.length ? aiCodePool.shift()! : await newUniqueCode(new Set());
              importedForIndex.push({ id: qId, code: minted });
              await fsSetMerge(`qbanks/${body.qbankId}/questions/${qId}`, toFields({
                questionText: text,
                data: JSON.stringify({
                  code: minted,
                  tags: [],
                  options: q.options || q.answers || q.choices || [],
                  correctIndices: correctIndices,
                  explanation: q.explanation || "",
                  subject: q.subject || "",
                  chapter: q.chapter || "",
                  createdAt: Date.now() + parseIndex
                }),
                createdAt: Date.now() + parseIndex
              }));
              questionIds.push(qId);
            }
            
            if (questionIds.length === 0) {
               if (duplicatesSkipped > 0) {
                 return json({ error: `${duplicatesSkipped} duplicate question(s) skipped. No new questions added.` }, 400, cors);
               }
               return json({ error: "Failed to extract questions. AI output: " + r.text }, 400, cors);
            }

            await fsSetMerge(`qbanks/${body.qbankId}`, toFields({ updatedAt: Date.now() }));
            // Surgical index updates — new questions searchable instantly
            for (const item of importedForIndex) qindexUpsert(body.qbankId!, item.id, item.code);
            return json({ ok: true, questionIds, duplicatesSkipped, provider: r.provider, model: r.model }, 200, cors);
          }

          if (body.action === "batch_import_qbank_txt") {
            if (!body.qbankId || !body.rawText) return json({ error: "Missing qbankId or rawText" }, 400, cors);
            
            const lines = body.rawText.split('\n');
            type Option = { text: string; isCorrect: boolean; explanation: string };
            type ParsedQuestion = {
              questionText: string;
              code: string;
              year: string;
              options: Option[];
              generalComment: string;
              subject: string;
              chapter?: string;
            };

            const questions: ParsedQuestion[] = [];
            let currentSubject = 'Uncategorized';
            let currentChapter = '';
            let curQ: Partial<ParsedQuestion> = {};
            let inQuestionText = false;
            
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line) continue;

              if (line.startsWith('-> Subject:')) {
                currentSubject = line.replace('-> Subject:', '').trim();
                continue;
              }

              if (line.startsWith('-> Chapter:')) {
                currentChapter = line.replace('-> Chapter:', '').trim();
                continue;
              }

              const qMatch = line.match(/^Question \d+ \[Code: (.*?)\]\s*\(Année: (.*?)\):/);
              if (qMatch) {
                if (curQ.questionText) questions.push(curQ as ParsedQuestion);
                curQ = {
                  code: qMatch[1],
                  year: qMatch[2],
                  subject: currentSubject,
                  chapter: currentChapter,
                  questionText: '',
                  options: [],
                  generalComment: ''
                };
                inQuestionText = true;
                continue;
              }

              const optMatch = line.match(/^[A-E]\.\s+(.*?)( ✅ \(CORRECT\))?( -> Note: (.*))?$/);
              if (optMatch && curQ.options) {
                inQuestionText = false;
                const text = optMatch[1].trim();
                const isCorrect = !!optMatch[2];
                const explanation = optMatch[4] ? optMatch[4].trim() : '';
                curQ.options.push({ text, isCorrect, explanation });
                continue;
              }

              if (line.startsWith('Explication générale:')) {
                inQuestionText = false;
                if (curQ) curQ.generalComment = line.replace('Explication générale:', '').trim();
                continue;
              }

              if (inQuestionText && !line.startsWith('-----------------')) {
                curQ.questionText += (curQ.questionText ? '\n' : '') + line;
              }
            }
            if (curQ.questionText) questions.push(curQ as ParsedQuestion);
            
            const fileSubcategory = body.fileSubcategory ? String(body.fileSubcategory).trim() : "";

            // Register fileSubcategory and any parsed question subjects into QBank subcategories
            try {
              const qbRes = await fsGet(`qbanks/${body.qbankId}`);
              if (qbRes) {
                let currentSubcategories = qbRes.fields?.subcategories?.stringValue || "";
                const cats = currentSubcategories.split(",").map((s: string) => s.trim()).filter(Boolean);
                let updated = false;

                if (fileSubcategory && !cats.includes(fileSubcategory)) {
                  cats.push(fileSubcategory);
                  updated = true;
                }
                questions.forEach(q => {
                  if (q.subject && q.subject !== 'Uncategorized' && !cats.includes(q.subject)) {
                    cats.push(q.subject);
                    updated = true;
                  }
                });

                if (updated) {
                  await fsSetMerge(`qbanks/${body.qbankId}`, {
                    subcategories: { stringValue: cats.join(", ") }
                  });
                }
              }
            } catch(e) {
              console.error("Failed to update QBank subcategories", e);
            }

            // Filter by chosen subjects if provided
            const chosen = body.chosenSubjects || [];
            const toImport = chosen.length > 0 ? questions.filter(q => chosen.includes(q.subject)) : questions;

            // Fetch existing questions to check for duplicates (if not skipped)
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();
            let existingQuestions: Record<string, any> = {};
            
            if (!body.skipDuplicates) {
              let pageToken = "";
              let fetchedCount = 0;
              while (fetchedCount < 1000) {
                 const params = new URLSearchParams({ pageSize: "300" });
                 if (pageToken) params.set("pageToken", pageToken);
                 const existingRes = await fetch(`https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${body.qbankId}/questions?${params}`, { headers: { Authorization: `Bearer ${token}` }});
                 if (!existingRes.ok && existingRes.status !== 404) break;
                 if (existingRes.status === 404) break;
                 const exData = await existingRes.json();
                 if (exData.documents) {
                    fetchedCount += exData.documents.length;
                    exData.documents.forEach((d: any) => {
                       const cText = d.fields?.questionText?.stringValue?.toLowerCase().replace(/[^a-z0-9]/g, "") || "";
                       if (cText) existingQuestions[cText] = d;
                    });
                 }
                 pageToken = exData.nextPageToken || "";
                 if (!pageToken) break;
              }
            }

            const questionIds: string[] = [];
            let duplicatesSkipped = 0;
            let parseIndex = 0;
            
            let currentBatch: Promise<any>[] = [];
            
            // Pre-mint globally-unique codes for this TXT batch. Imported
            // source codes are preserved as sourceCode, never reused.
            const txtCodePool: string[] = [];
            {
              const reserved = new Set<string>();
              for (let i = 0; i < toImport.length + 5; i++) {
                txtCodePool.push(await newUniqueCode(reserved));
              }
            }
            const importedForIndex: { id: string; code: string }[] = [];

            for (const q of toImport) {
              parseIndex++;
              const text = q.questionText;
              if (!text) continue;
              
              const cleanText = text.toLowerCase().replace(/[^a-z0-9]/g, "");
              const finalSubject = (q.subject && q.subject !== 'Uncategorized') ? q.subject : (fileSubcategory || 'Uncategorized');

              if (existingQuestions[cleanText]) {
                const existingDoc = existingQuestions[cleanText];
                const docPath = existingDoc.name.replace(`projects/${sa.project_id}/databases/(default)/documents/`, '');
                
                let existingDataStr = existingDoc.fields?.data?.stringValue || "{}";
                let exDataObj: any = {};
                try { exDataObj = JSON.parse(existingDataStr); } catch(e){}
                
                let needsUpdate = false;
                if (exDataObj.chapter !== (q.chapter || "")) {
                   exDataObj.chapter = (q.chapter || "");
                   needsUpdate = true;
                }
                if (exDataObj.subject !== finalSubject) {
                   exDataObj.subject = finalSubject;
                   needsUpdate = true;
                }
                
                if (needsUpdate) {
                   currentBatch.push(fsSetMerge(docPath, toFields({
                       data: JSON.stringify(exDataObj)
                   })));
                }
                
                duplicatesSkipped++;
                
                if (currentBatch.length >= 50) {
                   await Promise.all(currentBatch);
                   currentBatch = [];
                }
                continue;
              }
              
              const correctIndices = q.options.map((o, idx) => o.isCorrect ? idx : -1).filter(idx => idx !== -1);
              
              let explanationText = "";
              if (q.generalComment) explanationText += `**General Explication:**\n${q.generalComment}\n\n`;
              q.options.forEach((o, idx) => {
                if (o.explanation && o.explanation !== "No commentaire") {
                  explanationText += `- **Option ${String.fromCharCode(65 + idx)}**: ${o.explanation}\n`;
                }
              });

              const qTags = q.year ? [q.year] : [];

              // Determine final subject: if question has a specific subject, use it; if Uncategorized, fall back to fileSubcategory
              // finalSubject is already declared above

              const qId = crypto.randomUUID();
              const mintedCode = txtCodePool.length ? txtCodePool.shift()! : await newUniqueCode(new Set());
              importedForIndex.push({ id: qId, code: mintedCode });
              const p = fsSetMerge(`qbanks/${body.qbankId}/questions/${qId}`, toFields({
                questionText: text,
                data: JSON.stringify({
                  code: mintedCode,
                  sourceCode: q.code || "",
                  tags: qTags,
                  options: q.options.map(o => o.text),
                  correctIndices: correctIndices.length ? correctIndices : [0],
                  explanation: explanationText.trim() || "",
                  subject: finalSubject,
                  chapter: q.chapter || "",
                  createdAt: Date.now() + parseIndex
                }),
                createdAt: Date.now() + parseIndex
              }));
              
              currentBatch.push(p);
              questionIds.push(qId);
              
              if (currentBatch.length >= 50) {
                 await Promise.all(currentBatch);
                 currentBatch = [];
              }
            }
            if (currentBatch.length > 0) {
               await Promise.all(currentBatch);
            }

            await fsSetMerge(`qbanks/${body.qbankId}`, toFields({ updatedAt: Date.now() }));
            // Surgical index updates — imported questions searchable instantly
            for (const item of importedForIndex) qindexUpsert(body.qbankId!, item.id, item.code);
            return json({ ok: true, imported: questionIds.length, duplicatesSkipped, totalFound: questions.length }, 200, cors);
          }

          if (body.action === "list_qbank_questions") {
            if (!body.qbankId) return json({ error: "Missing qbankId" }, 400, cors);
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();
            const documents: any[] = [];
            let pageToken = "";
            // Limit to max 500 questions to prevent runaway reads and excessive payloads
            while (documents.length < 500) {
              const params = new URLSearchParams({ pageSize: "300" });
              if (pageToken) params.set("pageToken", pageToken);
              const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${body.qbankId}/questions?${params}`;
              const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
              if (!resp.ok && resp.status !== 404) return json({ error: `Firestore fetch failed: ${resp.status}` }, 500, cors);
              if (resp.status === 404) break;
              
              const data = (await resp.json()) as { documents?: any[], nextPageToken?: string };
              if (data.documents) documents.push(...data.documents);
              pageToken = data.nextPageToken || "";
              if (!pageToken) break;
            }
            
            const questions = documents.map(d => ({
              id: d.name.split("/").pop() || "",
              questionText: d.fields?.questionText?.stringValue || "",
              data: d.fields?.data?.stringValue || "{}",
              reported: d.fields?.reported?.booleanValue || false,
              reports: (d.fields?.reports?.arrayValue?.values || []).map((v: any) => v.mapValue?.fields || {})
            }));
            return json({ questions }, 200, cors);
          }

          if (body.action === "delete_qbank_question") {
            if (!body.qbankId || !body.questionId) return json({ error: "Missing ids" }, 400, cors);
            qindexRemove(body.qbankId!, body.questionId!);
            await fsDeleteDoc(`qbanks/${body.qbankId}/questions/${body.questionId}`);
            await fsSetMerge(`qbanks/${body.qbankId}`, toFields({ updatedAt: Date.now() }));
            return json({ ok: true }, 200, cors);
          }

          if (body.action === "delete_multiple_qbank_questions") {
            if (!body.qbankId || !Array.isArray(body.questionIds)) return json({ error: "Missing ids" }, 400, cors);
            for (const qId of body.questionIds!) qindexRemove(body.qbankId!, qId);
            
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();
            
            // 1. Bulk delete the question documents
            const chunkSize = 500;
            for (let i = 0; i < body.questionIds.length; i += chunkSize) {
              const chunk = body.questionIds.slice(i, i + chunkSize);
              const writes = chunk.map(qId => ({ delete: `projects/${sa.project_id}/databases/(default)/documents/qbanks/${body.qbankId}/questions/${qId}` }));
              
              const res = await fetch(`https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents:commit`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ writes })
              });
              if (!res.ok) {
                 console.error("Bulk delete failed", await res.text());
              }
            }
            
            // 2. Re-publish chunks from remaining questions so stale chunks
            //    don't resurrect deleted questions on next page load.
            try {
              // Fetch remaining questions
              const remaining: any[] = [];
              let pt = "";
              while (true) {
                const params = new URLSearchParams({ pageSize: "300" });
                if (pt) params.set("pageToken", pt);
                const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${body.qbankId}/questions?${params}`;
                const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
                if (!resp.ok && resp.status !== 404) break;
                if (resp.status === 404) break;
                const data = await resp.json();
                if (data.documents) {
                  for (const doc of data.documents) {
                    const id = doc.name.split("/").pop();
                    const text = doc.fields?.questionText?.stringValue || "";
                    const dataStr = doc.fields?.data?.stringValue;
                    if (dataStr) {
                      try { remaining.push({ id, text, data: JSON.parse(dataStr), ...extractChunkConcepts(doc) }); } catch {}
                    }
                  }
                }
                pt = data.nextPageToken || "";
                if (!pt) break;
              }

              // Delete old chunks
              let cpt = "";
              while (true) {
                const params = new URLSearchParams({ pageSize: "300" });
                if (cpt) params.set("pageToken", cpt);
                const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${body.qbankId}/chunks?${params}`;
                const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
                if (!resp.ok) break;
                const data = await resp.json();
                if (data.documents && data.documents.length > 0) {
                  const delWrites = data.documents.map((d: any) => ({ delete: d.name }));
                  await fetch(`https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents:commit`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                    body: JSON.stringify({ writes: delWrites })
                  });
                }
                cpt = data.nextPageToken || "";
                if (!cpt) break;
              }

              // Write new chunks to R2 from remaining questions
              const s3Client = new S3Client({
                region: "auto",
                endpoint: process.env.R2_ENDPOINT!,
                forcePathStyle: true,
                credentials: {
                  accessKeyId: process.env.R2_ACCESS_KEY_ID!,
                  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
                },
              });
              const rawJson = JSON.stringify(remaining);
              const compressedStr = gzipSync(Buffer.from(rawJson, 'utf-8'));
              await s3Client.send(new PutObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME || "curaq",
                Key: `qbanks/${body.qbankId}/chunks.json.gz`,
                Body: compressedStr,
                ContentType: "application/gzip",
              }));
            } catch (e) {
              console.error("[delete_multiple] chunk republish failed:", (e as Error).message);
            }
            
            await fsSetMerge(`qbanks/${body.qbankId}`, toFields({ updatedAt: Date.now() }));
            return json({ ok: true }, 200, cors);
          }

          if (body.action === "rename_qbank_subject") {
            if (!body.qbankId || !body.oldSubject || !body.newSubject) return json({ error: "Missing fields" }, 400, cors);
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();
            
            const documents: any[] = [];
            let pageToken = "";
            while (true) {
              const params = new URLSearchParams({ pageSize: "300" });
              if (pageToken) params.set("pageToken", pageToken);
              const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${body.qbankId}/questions?${params}`;
              const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
              if (!resp.ok && resp.status !== 404) return json({ error: `Firestore fetch failed` }, 500, cors);
              if (resp.status === 404) break;
              
              const data = (await resp.json()) as { documents?: any[], nextPageToken?: string };
              if (data.documents) documents.push(...data.documents);
              pageToken = data.nextPageToken || "";
              if (!pageToken) break;
            }
            
            let updatedCount = 0;
            let batch: Promise<any>[] = [];
            for (const d of documents) {
               const id = d.name.split("/").pop();
               if (!id) continue;

               const dataStr = d.fields?.data?.stringValue || "{}";
               let parsed;
               try { parsed = JSON.parse(dataStr); } catch { continue; }

               if (parsed.subject === body.oldSubject) {
                 parsed.subject = body.newSubject;
                 batch.push(fsSetMerge(`qbanks/${body.qbankId}/questions/${id}`, toFields({
                   data: JSON.stringify(parsed)
                 })));
                 updatedCount++;
               }

               if (batch.length >= 50) {
                 await Promise.all(batch);
                 batch = [];
               }
            }
            if (batch.length) await Promise.all(batch);

            await fsSetMerge(`qbanks/${body.qbankId}`, toFields({ updatedAt: Date.now() }));
            return json({ ok: true, updatedCount }, 200, cors);
          }

          if (body.action === "rename_qbank_chapter") {
            if (!body.qbankId || !body.subject || !body.oldChapter || !body.newChapter) return json({ error: "Missing fields" }, 400, cors);
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();
            
            const documents: any[] = [];
            let pageToken = "";
            while (true) {
              const params = new URLSearchParams({ pageSize: "300" });
              if (pageToken) params.set("pageToken", pageToken);
              const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${body.qbankId}/questions?${params}`;
              const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
              if (!resp.ok && resp.status !== 404) return json({ error: `Firestore fetch failed` }, 500, cors);
              if (resp.status === 404) break;
              
              const data = (await resp.json()) as { documents?: any[], nextPageToken?: string };
              if (data.documents) documents.push(...data.documents);
              pageToken = data.nextPageToken || "";
              if (!pageToken) break;
            }
            
            let updatedCount = 0;
            let batch: Promise<any>[] = [];
            for (const d of documents) {
               const id = d.name.split("/").pop();
               if (!id) continue;

               const dataStr = d.fields?.data?.stringValue || "{}";
               let parsed;
               try { parsed = JSON.parse(dataStr); } catch { continue; }

               if (parsed.subject === body.subject && parsed.chapter === body.oldChapter) {
                 parsed.chapter = body.newChapter;
                 batch.push(fsSetMerge(`qbanks/${body.qbankId}/questions/${id}`, toFields({
                   data: JSON.stringify(parsed)
                 })));
                 updatedCount++;
               }

               if (batch.length >= 50) {
                 await Promise.all(batch);
                 batch = [];
               }
            }
            if (batch.length) await Promise.all(batch);

            await fsSetMerge(`qbanks/${body.qbankId}`, toFields({ updatedAt: Date.now() }));
            return json({ ok: true, updatedCount }, 200, cors);
          }

          if (body.action === "batch_rename_qbank_categories") {
            if (!body.qbankId || !Array.isArray(body.renames)) return json({ error: "Missing fields" }, 400, cors);
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();
            
            const documents: any[] = [];
            let pageToken = "";
            while (true) {
              const params = new URLSearchParams({ pageSize: "300" });
              if (pageToken) params.set("pageToken", pageToken);
              const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${body.qbankId}/questions?${params}`;
              const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
              if (!resp.ok && resp.status !== 404) return json({ error: `Firestore fetch failed` }, 500, cors);
              if (resp.status === 404) break;
              
              const data = (await resp.json()) as { documents?: any[], nextPageToken?: string };
              if (data.documents) documents.push(...data.documents);
              pageToken = data.nextPageToken || "";
              if (!pageToken) break;
            }
            
            let updatedCount = 0;
            let batch: Promise<any>[] = [];
            const remaining: any[] = [];
            for (const d of documents) {
               const id = d.name.split("/").pop();
               if (!id) continue;

               const dataStr = d.fields?.data?.stringValue || "{}";
               let parsed;
               try { parsed = JSON.parse(dataStr); } catch { continue; }
               let changed = false;

               for (const r of body.renames) {
                 if (r.type === "subject" && parsed.subject === r.oldSubject) {
                   parsed.subject = r.newSubject;
                   changed = true;
                 }
                 if (r.type === "chapter" && parsed.subject === r.subject && parsed.chapter === r.oldChapter) {
                   parsed.chapter = r.newChapter;
                   changed = true;
                 }
               }

               if (changed) {
                 batch.push(fsSetMerge(`qbanks/${body.qbankId}/questions/${id}`, toFields({
                   data: JSON.stringify(parsed)
                 })));
                 updatedCount++;
               }
               
               remaining.push({ id, text: d.fields?.questionText?.stringValue || "", data: parsed });

               if (batch.length >= 50) {
                 await Promise.all(batch);
                 batch = [];
               }
            }
            if (batch.length) await Promise.all(batch);

            await fsSetMerge(`qbanks/${body.qbankId}`, toFields({ updatedAt: Date.now() }));
            return json({ ok: true, updatedCount }, 200, cors);
          }

          if (body.action === "update_qbank_question") {
            if (!body.qbankId || !body.questionId || !body.questionText || !body.dataJson) return json({ error: "Missing fields" }, 400, cors);

            // Validate the json and guarantee a usable code
            let updData: any;
            try {
              updData = JSON.parse(body.dataJson);
            } catch (e) {
              return json({ error: "Invalid JSON data" }, 400, cors);
            }
            if (!updData || typeof updData !== "object") updData = {};
            if (!updData.code || !String(updData.code).trim()) {
              updData.code = generateQuestionCode();
            }
            const finalDataJson = JSON.stringify(updData);

            await fsSetMerge(`qbanks/${body.qbankId}/questions/${body.questionId}`, toFields({
              questionText: body.questionText,
              data: finalDataJson
            }));
            await fsSetMerge(`qbanks/${body.qbankId}`, toFields({ updatedAt: Date.now() }));
            return json({ ok: true }, 200, cors);
          }

          // ---------- Medical library (per-bank books) ----------
          // Storage: qbanks/{bankId}/books/{bookId} — one doc per book:
          //   { title, subject, updatedAt, lessonCount, data: JSON {title,subject,units} }
          // NOTE: book import/delete NEVER bumps qbanks/{id}.updatedAt — that
          // stamp versions the question payload, and bumping it would force
          // every student to re-download all questions. Books carry their own
          // updatedAt and clients version them via list_books.

          if (body.action === "list_library_books") {
            if (!body.qbankId) return json({ error: "Missing qbankId" }, 400, cors);
            if (!/^[a-zA-Z0-9_-]+$/.test(body.qbankId)) return json({ error: "Invalid qbankId" }, 400, cors);
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();
            const books: any[] = [];
            let pageToken = "";
            while (true) {
              const params = new URLSearchParams({ pageSize: "100" });
              if (pageToken) params.set("pageToken", pageToken);
              const r = await fetch(`https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${body.qbankId}/books?${params}`, { headers: { Authorization: `Bearer ${token}` } });
              if (!r.ok && r.status !== 404) return json({ error: "Failed to list books" }, 500, cors);
              if (r.status === 404) break;
              const d = await r.json();
              for (const doc of (d.documents || [])) {
                const id = String(doc.name.split("/").pop());
                const f = doc.fields || {};
                books.push({
                  id,
                  title: f.title?.stringValue || id,
                  subject: f.subject?.stringValue || "",
                  lessonCount: parseInt(f.lessonCount?.integerValue || "0", 10) || 0,
                  updatedAt: parseInt(f.updatedAt?.integerValue || "0", 10) || 0,
                });
              }
              pageToken = d.nextPageToken || "";
              if (!pageToken) break;
            }
            books.sort((a, b) => String(a.title).localeCompare(String(b.title)));
            return json({ books }, 200, cors);
          }

          if (body.action === "import_library_json") {
            if (!body.qbankId || !body.rawText) return json({ error: "Missing qbankId or rawText" }, 400, cors);
            if (!/^[a-zA-Z0-9_-]+$/.test(body.qbankId)) return json({ error: "Invalid qbankId" }, 400, cors);
            let parsed: any;
            try { parsed = JSON.parse(body.rawText); }
            catch { return json({ error: "Invalid JSON — paste one book object or an array of books" }, 400, cors); }
            const raws = Array.isArray(parsed) ? parsed : [parsed];
            if (raws.length === 0 || raws.length > 20) return json({ error: "Send 1–20 books per import" }, 400, cors);
            const seen = new Set<string>();
            const imported: any[] = [];
            for (let bi = 0; bi < raws.length; bi++) {
              const norm = normalizeLibraryBook(raws[bi], (bi === 0 && body.bookTitle) || `Book ${bi + 1}`);
              if (!norm.units.length || !norm.lessonCount) {
                return json({ error: `Book ${bi + 1} ("${norm.title}"): no lessons found. Expected { "title", "units": [{ "title", "chapters": [{ "title", "lessons": [{ "title", "body" }] }] }] }` }, 400, cors);
              }
              const payload = JSON.stringify({ title: norm.title, subject: norm.subject, units: norm.units });
              if (payload.length > 900_000) {
                return json({ error: `Book "${norm.title}" is ${(payload.length / 1024).toFixed(0)}KB — split it into smaller books under ~900KB each` }, 400, cors);
              }
              let bookId = libraryBookSlug(norm.title);
              if (seen.has(bookId)) {
                let k = 2;
                while (seen.has(`${bookId}-${k}`)) k++;
                bookId = `${bookId}-${k}`;
              }
              seen.add(bookId);
              await fsSetMerge(`qbanks/${body.qbankId}/books/${bookId}`, toFields({
                title: norm.title,
                subject: norm.subject,
                updatedAt: Date.now(),
                lessonCount: norm.lessonCount,
                data: payload,
              }));
              imported.push({ id: bookId, title: norm.title, subject: norm.subject, lessons: norm.lessonCount });
            }
            return json({ ok: true, imported: imported.length, books: imported }, 200, cors);
          }

          if (body.action === "delete_library_book") {
            if (!body.qbankId || !body.bookId) return json({ error: "Missing ids" }, 400, cors);
            if (!/^[a-zA-Z0-9_-]+$/.test(body.qbankId) || !/^[a-z0-9-]+$/.test(body.bookId)) return json({ error: "Invalid ids" }, 400, cors);
            await fsDeleteDoc(`qbanks/${body.qbankId}/books/${body.bookId}`);
            return json({ ok: true }, 200, cors);
          }

          if (body.action === "export_study_concepts") {
            if (!body.qbankId) return json({ error: "Missing qbankId" }, 400, cors);
            if (!/^[a-zA-Z0-9_-]+$/.test(body.qbankId)) return json({ error: "Invalid qbankId" }, 400, cors);
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();
            const digestUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${body.qbankId}/library/concepts`;
            const fmtEntry = (code: string, subject: string, chapter: string, lang: string, concept: string) => {
              const out: string[] = [];
              out.push("----------------------------------------------------------------");
              out.push(`[${code}] Subject: ${subject || "?"} | Chapter: ${chapter || "?"}${lang ? ` | Lang: ${lang}` : ""}`);
              out.push("----------------------------------------------------------------");
              out.push(concept);
              out.push("");
              return out.join("\n");
            };
            const fmtFile = (bank: string, withConcepts: number, bodyText: string, note: string) => {
              const header = [
                "================================================================",
                `STUDY CONCEPTS EXPORT — qbank: ${bank}`,
                `Exported: ${new Date().toISOString()} | Study concepts: ${withConcepts} | served from digest (1 read)`,
                note,
                "Author books from these concepts, then import them as JSON via",
                "Admin > Library > Import book.",
                "================================================================",
                "",
              ].join("\n");
              let text = header + bodyText;
              if (text.length > 8_000_000) {
                text = text.slice(0, 8_000_000) + "\n\n[TRUNCATED — bank too large for one file]";
              }
              return text;
            };
            // DIGEST ONLY — exactly 1 Firestore read (the digest doc itself).
            // This endpoint NEVER scans the questions collection. Coverage:
            // save_study_concept maintains entries incrementally; older
            // concepts need one explicit Backfill (backfill_concepts_digest).
            const dg = await fetch(digestUrl, { headers: { Authorization: `Bearer ${token}` } });
            if (!dg.ok && dg.status !== 404) return json({ error: "Failed to read concepts digest" }, 500, cors);
            const df = dg.ok ? ((await dg.json()).fields || {}) : {};
            const entries = df.entries?.mapValue?.fields || {};
            const ids = Object.keys(entries);
            const parts: string[] = [];
            for (const qid of ids) {
              const ef = entries[qid]?.mapValue?.fields || {};
              const concept = ef.concept?.stringValue || "";
              if (!concept) continue;
              parts.push(fmtEntry(
                ef.code?.stringValue || qid,
                ef.subject?.stringValue || "",
                ef.chapter?.stringValue || "",
                ef.lang?.stringValue || "",
                concept,
              ));
            }
            const backfilledAt = df.backfilledAt?.stringValue || df.backfilledAt?.timestampValue || null;
            const note = backfilledAt
              ? `Digest backfilled: ${backfilledAt}.`
              : "Digest keeps filling as students generate concepts — run Backfill digest for full coverage of older concepts.";
            return json({
              filename: `concepts-${body.qbankId}.txt`,
              text: fmtFile(body.qbankId, parts.length, parts.join("\n"), note),
              total: parts.length,
              withConcepts: parts.length,
              cached: true,
              backfilledAt,
            }, 200, cors);
          }

          if (body.action === "backfill_concepts_digest") {
            if (!body.qbankId) return json({ error: "Missing qbankId" }, 400, cors);
            if (!/^[a-zA-Z0-9_-]+$/.test(body.qbankId)) return json({ error: "Invalid qbankId" }, 400, cors);
            // Explicit one-time scan: walks every question ONCE to seed the
            // digest. Export itself never scans — this is the only action
            // that does, and only when the admin clicks Backfill.
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();
            const digestEntries: Record<string, any> = {};
            let total = 0, withConcepts = 0;
            let pageToken = "";
            while (true) {
              const params = new URLSearchParams({ pageSize: "300" });
              if (pageToken) params.set("pageToken", pageToken);
              const r: Response = await fetch(`https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${body.qbankId}/questions?${params}`, { headers: { Authorization: `Bearer ${token}` } });
              if (!r.ok && r.status !== 404) return json({ error: "Failed to list questions" }, 500, cors);
              if (r.status === 404) break;
              const d: any = await r.json();
              for (const doc of ((d.documents || []) as any[])) {
                total++;
                const qid = String(doc.name.split("/").pop());
                const f = doc.fields || {};
                const concept = f.studyConcept?.stringValue || "";
                if (!concept) continue;
                const conceptLang = f.studyConceptLang?.stringValue || "";
                let code = "", subject = "", chapter = "";
                try {
                  const data = JSON.parse(f.data?.stringValue || "{}");
                  code = String(data.code || "");
                  subject = String(data.subject || "");
                  chapter = String(data.chapter || "");
                } catch {}
                withConcepts++;
                digestEntries[qid] = { mapValue: { fields: {
                  code: { stringValue: code || qid },
                  subject: { stringValue: subject },
                  chapter: { stringValue: chapter },
                  concept: { stringValue: concept },
                  lang: { stringValue: conceptLang },
                } } };
              }
              pageToken = d.nextPageToken || "";
              if (!pageToken) break;
            }
            // Merge with live entries other students may have saved mid-scan:
            // read the current digest first so incremental upserts are kept.
            try {
              const cur = await fetch(`https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${body.qbankId}/library/concepts`, { headers: { Authorization: `Bearer ${token}` } });
              if (cur.ok) {
                const curEntries = ((await cur.json()).fields?.entries?.mapValue?.fields || {});
                for (const k of Object.keys(curEntries)) {
                  if (!digestEntries[k]) digestEntries[k] = curEntries[k];
                }
              }
            } catch {}
            const digestFields: Record<string, any> = {
              updatedAt: { integerValue: String(Date.now()) },
              backfilledAt: { timestampValue: new Date().toISOString() },
              questionCount: { integerValue: String(total) },
              entries: { mapValue: { fields: digestEntries } },
            };
            if (JSON.stringify(digestFields).length > 900_000) {
              return json({ error: `Digest would exceed the 1MB doc cap (${withConcepts} concepts) — export stays correct via per-question reads; contact dev to shard` }, 400, cors);
            }
            await fsSetMerge(`qbanks/${body.qbankId}/library/concepts`, digestFields as Record<string, FSValue>);
            return json({ ok: true, total, withConcepts }, 200, cors);
          }

          if (body.action === "clear_qbank_question_reports") {
            if (!body.qbankId || !body.questionId) return json({ error: "Missing ids" }, 400, cors);
            const docUrl = `https://firestore.googleapis.com/v1/projects/${getServiceAccount().project_id}/databases/(default)/documents/qbanks/${body.qbankId}/questions/${body.questionId}?updateMask.fieldPaths=reported&updateMask.fieldPaths=reports`;
            const token = await getGoogleAccessToken();
            const patchRes = await fetch(docUrl, {
              method: "PATCH",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                fields: {
                  reported: { booleanValue: false },
                  reports: { arrayValue: { values: [] } }
                }
              })
            });
            if (!patchRes.ok) return json({ error: "Failed to clear reports" }, 500, cors);
            return json({ ok: true }, 200, cors);
          }

          if (body.action === "list_reported_questions") {
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();
            
            // Fetch all qbanks first to avoid needing a Collection Group Index
            const qbanksUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks?pageSize=300`;
            const qbRes = await fetch(qbanksUrl, { headers: { Authorization: `Bearer ${token}` } });
            if (!qbRes.ok) return json({ error: "Failed to list qbanks" }, 500, cors);
            const qbData = await qbRes.json();
            const qbankIds = (qbData.documents || []).map((d: any) => d.name.split("/").pop());
            
            let allReportedQuestions: any[] = [];
            
            // Query each QBank individually
            for (const qbankId of qbankIds) {
              const queryUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}:runQuery`;
              const reqBody = {
                structuredQuery: {
                  from: [{ collectionId: "questions" }],
                  where: {
                    fieldFilter: {
                      field: { fieldPath: "reported" },
                      op: "EQUAL",
                      value: { booleanValue: true }
                    }
                  },
                  limit: 50
                }
              };
              
              const res = await fetch(queryUrl, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify(reqBody)
              });
              
              if (res.ok) {
                const results = await res.json() as any[];
                const questions = results.filter(r => r.document).map(r => {
                   const d = r.document;
                   const pathParts = d.name.split("/");
                   const qId = pathParts.pop() || "";
                   
                   return {
                     id: qId,
                     qbankId: qbankId,
                     questionText: d.fields?.questionText?.stringValue || "",
                     data: d.fields?.data?.stringValue || "{}",
                     reported: d.fields?.reported?.booleanValue || false,
                     reports: (d.fields?.reports?.arrayValue?.values || []).map((v: any) => v.mapValue?.fields || {})
                   };
                });
                allReportedQuestions.push(...questions);
              }
            }
            
            return json({ questions: allReportedQuestions }, 200, cors);
          }

          if (body.action === "backfill_qbank_codes") {
            if (!body.qbankId) return json({ error: "Missing qbankId" }, 400, cors);
            const mode = (body.backfillMode === "regenerate" || body.mode === ("regenerate" as any)) ? "regenerate" : "missing";
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();

            // Get all questions
            const documents: any[] = [];
            let pageToken = "";
            while (true) {
              const params = new URLSearchParams({ pageSize: "300", "mask.fieldPaths": "data" });
              if (pageToken) params.set("pageToken", pageToken);
              const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${body.qbankId}/questions?${params}`;
              const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
              if (!resp.ok && resp.status !== 404) return json({ error: `Firestore fetch failed: ${resp.status}` }, 500, cors);
              if (resp.status === 404) break;

              const data = (await resp.json()) as { documents?: any[], nextPageToken?: string };
              if (data.documents) documents.push(...data.documents);
              pageToken = data.nextPageToken || "";
              if (!pageToken) break;
            }

            // Reserve pool sized for worst case (every question regenerated)
            const reserved = new Set<string>();
            const pool: string[] = [];
            for (let i = 0; i < documents.length + 10; i++) {
              pool.push(await newUniqueCode(reserved));
            }
            const regenForIndex: { id: string; code: string }[] = [];

            let updatedCount = 0;
            let batch: Promise<any>[] = [];
            for (const d of documents) {
               const id = d.name.split("/").pop();
               if (!id) continue;

               const dataStr = d.fields?.data?.stringValue || "{}";
               let parsed;
               try { parsed = JSON.parse(dataStr); } catch { continue; }

               const shouldAssign = mode === "regenerate" || !parsed.code;
               if (!shouldAssign) continue;

               parsed.code = pool.length ? pool.shift()! : await newUniqueCode(reserved);
               regenForIndex.push({ id: id!, code: parsed.code });
               batch.push(fsSetMerge(`qbanks/${body.qbankId}/questions/${id}`, toFields({
                 data: JSON.stringify(parsed)
               })));
               updatedCount++;

               if (batch.length >= 50) {
                 await Promise.all(batch);
                 batch = [];
               }
            }
            if (batch.length) await Promise.all(batch);

            // Bump bank updatedAt so student caches invalidate
            await fsSetMerge(`qbanks/${body.qbankId}`, toFields({ updatedAt: Date.now() }));

            // Surgical index refresh: drop old codes for regenerated questions,
            // register the new ones — searchable immediately.
            for (const item of regenForIndex) {
               qindexRemove(body.qbankId!, item.id);
               qindexUpsert(body.qbankId!, item.id, item.code);
            }

            return json({ ok: true, updatedCount, mode }, 200, cors);
          }

          if (body.action === "list_access_requests") {
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();
            // Pending only; sorted here (avoids orderBy/index quirks)
            let rows: any[] = [];
            try {
              const q = await fetch(
                `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents:runQuery`,
                {
                  method: "POST",
                  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    structuredQuery: {
                      from: [{ collectionId: "access_requests" }],
                      where: { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "pending" } } },
                    },
                  }),
                }
              );
              if (!q.ok && q.status !== 404) {
                console.error("[access_requests] runQuery status", q.status, await q.text().catch(() => ""));
              }
              rows = q.ok ? (await q.json()) : [];
            } catch (e) {
              console.error("[access_requests] runQuery threw", e);
              rows = [];
            }
            // resolve bank names in one pass
            let banks: Record<string, string> = {};
            try {
              const lb = await fetch(
                `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks?pageSize=300`,
                { headers: { Authorization: `Bearer ${token}` } }
              );
              if (lb.ok) {
                for (const d of (await lb.json()).documents || []) {
                  banks[d.name.split("/").pop()] = d.fields?.name?.stringValue || "(unnamed)";
                }
              }
            } catch {}
            const requests = (rows || [])
              .filter((r: any) => r.document)
              .map((r: any) => {
                const f = r.document.fields || {};
                return {
                  id: r.document.name.split("/").pop(),
                  uid: String(f.uid?.stringValue || ""),
                  email: String(f.email?.stringValue || ""),
                  qbankId: String(f.qbankId?.stringValue || ""),
                  bankName: banks[String(f.qbankId?.stringValue || "")] || "(deleted bank)",
                  reason: String(f.reason?.stringValue || ""),
                  status: String(f.status?.stringValue || ""),
                  createdAt: String(f.createdAt?.timestampValue || ""),
                };
              })
              .sort((x: any, y: any) => String(y.createdAt || "").localeCompare(String(x.createdAt || "")))
              .slice(0, 200);
            return json({ requests }, 200, cors);
          }

          if (body.action === "resolve_access_request") {
            const reqId = String(body.requestId || "");
            const decision = body.decision === "accept" ? "accepted" : body.decision === "reject" ? "rejected" : "";
            if (!reqId || !decision) return json({ error: "Missing requestId or decision" }, 400, cors);
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();
            const basePath = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;

            // Load request
            const gr = await fetch(
              `${basePath}/access_requests/${reqId}`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            if (!gr.ok) return json({ error: "Request not found" }, 404, cors);
            const gd = await gr.json();
            const f = gd.fields || {};
            const reqUid = String(f.uid?.stringValue || "");
            const qbankId = String(f.qbankId?.stringValue || "");
            if (!reqUid || !qbankId) return json({ error: "Corrupt request" }, 400, cors);

            // Bank name for the notification text
            let bankName = "the question bank";
            try {
              const br = await fetch(`${basePath}/qbanks/${qbankId}`, { headers: { Authorization: `Bearer ${token}` } });
              if (br.ok) {
                const bd = await br.json();
                bankName = bd.fields?.name?.stringValue || bankName;
              }
            } catch {}

            if (decision === "accepted") {
              // Grant: arrayUnion on users_index/{uid}.qbankGrants
              await fetch(
                `${basePath}/users_index/${reqUid}?updateMask.fieldPaths=qbankGrants`,
                {
                  method: "PATCH",
                  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    fields: {
                      qbankGrants: {
                        arrayValue: { values: [{ stringValue: qbankId }] },
                      },
                    },
                  }),
                }
              ).catch(() => {});
              // Drop the cached profile so the new grant applies immediately.
              invalidateUserProfile(reqUid);
            }

            // Mark resolved
            await fetch(
              `${basePath}/access_requests/${reqId}?updateMask.fieldPaths=status&updateMask.fieldPaths=resolvedAt&updateMask.fieldPaths=resolvedBy`,
              {
                method: "PATCH",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  fields: {
                    status: { stringValue: decision },
                    resolvedAt: { timestampValue: new Date().toISOString() },
                    resolvedBy: { stringValue: String(actor.email || actor.sub || "") },
                  },
                }),
              }
            );

            // Notify the student (direct REST write — same shape as broadcasts)
            const nid = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
            const createdAt = new Date();
            const title = decision === "accepted"
              ? "Access approved"
              : "Access request rejected";
            const message = decision === "accepted"
              ? `You now have access to "${bankName}". Open it from Exam Prep or by switching banks.`
              : `Your request for "${bankName}" was not approved. Contact support for details.`;
            const notifFields = toFields({
              notificationId: nid,
              title,
              body: message,
              type: decision === "accepted" ? "success" : "warning",
              link: null as any,
              createdAt,
              read: false,
              readAt: null,
            });
            const notifRes = await fetch(
              `${basePath}/users/${reqUid}/notifications/${nid}`,
              {
                method: "PATCH",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ fields: notifFields }),
              }
            );
            if (!notifRes.ok) {
              console.error("[resolve_access_request] notification write failed", notifRes.status, await notifRes.text().catch(() => ""));
            }

            return json({ ok: true, decision }, 200, cors);
          }

          if (body.action === "ai_generate_block") {
            // Generate a structured explanation block (table/criteria/compare/note)
            // from a free-form topic via the existing AI router. Returns the
            // validated block; does NOT write Firestore — the editor composes.
            const kind = String(body.kind || "");
            const topic = String(body.topic || "").trim().slice(0, 300);
            const lang = String(body.blockLang || "en").slice(0, 8);
            const VALID = ["table", "criteria", "compare", "note"];
            if (!VALID.includes(kind)) return json({ error: "Invalid kind" }, 400, cors);
            if (!topic || topic.length < 3) return json({ error: "Topic too short" }, 400, cors);

            const schemaHint: Record<string, string> = {
              table: '{"type":"table","title":string,"headers":string[3..5],"rows":(string[])[4..10] each row same length as headers,"note":string?}',
              criteria: '{"type":"criteria","title":string,"items":string[3..12],"note":string?}',
              compare: '{"type":"compare","title":string,"leftLabel":string,"rightLabel":string,"pairs":(string[2])[4..10]}',
              note: '{"type":"note","tone":"info"|"warning"|"key","text":string}',
            };

            const r = await routeRequest({
              messages: [
                { role: "system", content:
                  `You are a medical education content generator. Output ONLY minified JSON - no markdown fences, no commentary. Language: ${lang}. ` +
                  `Produce exactly this shape: ${schemaHint[kind]} ` +
                  `Content rules: medically accurate and current, concise cells (max ~60 chars each), no HTML inside strings.` },
                { role: "user", content: topic },
              ],
              requireJson: true,
            });

            let block: any;
            try {
              const txt = String((r as any).text || "").replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim();
              const m2 = txt.match(/\{[\s\S]*\}/);
              block = JSON.parse(m2 ? m2[0] : txt);
            } catch {
              return json({ error: "AI returned invalid JSON", raw: String((r as any).text || "").slice(0, 500) }, 502, cors);
            }
            if (!block || block.type !== kind) return json({ error: "AI returned wrong block type" }, 502, cors);

            // Shape validation per kind
            if (kind === "table") {
              if (!Array.isArray(block.headers) || !Array.isArray(block.rows) ||
                  block.headers.length < 2 || block.headers.length > 6 ||
                  !block.rows.length || block.rows.some((rw: any) => !Array.isArray(rw) || rw.length !== block.headers.length)) {
                return json({ error: "AI table shape invalid" }, 502, cors);
              }
            } else if (kind === "criteria") {
              if (!Array.isArray(block.items) || block.items.length < 2) return json({ error: "AI criteria shape invalid" }, 502, cors);
            } else if (kind === "compare") {
              if (!Array.isArray(block.pairs) || block.pairs.length < 2) return json({ error: "AI compare shape invalid" }, 502, cors);
            } else if (kind === "note") {
              if (!block.text || typeof block.text !== "string") return json({ error: "AI note shape invalid" }, 502, cors);
            }

            if (JSON.stringify(block).length > 4096) return json({ error: "Generated block too large" }, 502, cors);

            return json({ ok: true, block }, 200, cors);
          }

          if (body.action === "list_ai_functions") {
            const cfgFns = await loadProvidersConfig();
            const customChains = await loadCustomChains();
            const tasks = Object.keys(TASK_CHAINS).map((task) => ({
              task, 
              label: TASK_LABELS[task] || task, 
              chain: resolveChain(task, cfgFns, customChains),
              baseChain: resolveChain(task, cfgFns, {}),
              customChain: customChains[task] || [],
            }));
            return json({ tasks }, 200, cors);
          }
          if (body.action === "set_ai_custom_chains") {
            if (!body.chains || typeof body.chains !== "object") {
               return json({ error: "Invalid payload" }, 400, cors);
            }
            await saveCustomChains(body.chains as CustomChainsConfig);
            return json({ ok: true }, 200, cors);
          }
          if (body.action === "check_ai_function" || body.action === "check_all_ai_functions") {
            const cfg = await loadProvidersConfig(true);
            const customChains = await loadCustomChains();
            const mode = body.mode === "full_chain" ? "full_chain" : "first_success";
            const runOne = async (task: string) => {
              const chain = resolveChain(task, cfg, customChains);
              const probe = probeFor(task);
              const steps: Array<Awaited<ReturnType<typeof probeChainStep>>> = [];
              let firstSuccessIndex = -1;
              const t0 = Date.now();
              for (let i = 0; i < chain.length; i++) {
                const r = await probeChainStep(chain[i], cfg, {
                  messages: probe.messages, requireJson: probe.requireJson, maxTokens: probe.maxTokens,
                });
                steps.push(r);
                if (r.ok && firstSuccessIndex === -1) {
                  firstSuccessIndex = i;
                  if (mode === "first_success") break;
                }
              }
              return { task, label: TASK_LABELS[task] || task, steps, firstSuccessIndex, elapsedMs: Date.now() - t0 };
            };
            if (body.action === "check_ai_function") {
              if (!body.task || !TASK_CHAINS[body.task]) return json({ error: "Unknown task" }, 400, cors);
              if (body.mode === "test_step" && typeof body.stepIndex === "number") {
                 const chain = resolveChain(body.task, cfg, customChains);
                 if (body.stepIndex >= 0 && body.stepIndex < chain.length) {
                    const probe = probeFor(body.task);
                    const t0 = Date.now();
                    const r = await probeChainStep(chain[body.stepIndex], cfg, {
                      messages: probe.messages, requireJson: probe.requireJson, maxTokens: probe.maxTokens,
                    });
                    // Format response exactly like runOne so the frontend can display it the same way
                    return json({ task: body.task, label: TASK_LABELS[body.task] || body.task, steps: [r], firstSuccessIndex: r.ok ? 0 : -1, elapsedMs: Date.now() - t0, isStepTest: true, stepIndex: body.stepIndex }, 200, cors);
                 }
                 return json({ error: "Invalid step index" }, 400, cors);
              }
              return json(await runOne(body.task), 200, cors);
            }
            const results = [];
            for (const task of Object.keys(TASK_CHAINS)) {
              results.push(await runOne(task));
            }
            return json({ results }, 200, cors);
          }



          if (!body.uid || typeof body.uid !== "string" || body.uid.length > 128) {
            return json({ error: "Bad request" }, 400, cors);
          }


          if (body.action === "upgrade" || body.action === "upgrade_aplus") {
            const plan = body.action === "upgrade_aplus" ? "aplus" : "pro";
            const days = Math.max(1, Math.min(3650, body.days || 30));
            const until = new Date(Date.now() + days * 86400_000);
            await fsPatch(`users_index/${body.uid}`, { plan, proUntil: until });
            // Refill credits to the new plan's allotment right away.
            await resetUserCredits(body.uid).catch(() => {});
            return json({ ok: true, plan, proUntil: until.toISOString() }, 200, cors);
          }
          if (body.action === "downgrade") {
            await fsPatch(`users_index/${body.uid}`, { plan: "free", proUntil: null });
            await resetUserCredits(body.uid).catch(() => {});
            return json({ ok: true, plan: "free" }, 200, cors);
          }
          if (body.action === "reset_quota") {
            const credits = await resetUserCredits(body.uid);
            return json({ ok: true, credits }, 200, cors);
          }
          if (body.action === "grant_bonus") {
            const n = Math.max(1, Math.min(1_000_000, body.bonus || 1000));
            const total = await grantBonusCredits(body.uid, n);
            return json({ ok: true, bonus: total }, 200, cors);
          }
          if (body.action === "delete_user") {
            const safeDelete = (p: string) => fsDeleteDoc(p).catch(() => {});
            await Promise.all([
              safeDelete(`users/${body.uid}`),
              safeDelete(`users_index/${body.uid}`),
              safeDelete(`subscriptions/${body.uid}`),
              safeDelete(`kashier_pending/${body.uid}`),
            ]);
            return json({ ok: true }, 200, cors);
          }

          return json({ error: "Bad request" }, 400, cors);
        } catch (e) {
          console.error("[admin]", (e as Error).message);
          return json({ error: "Server error" }, 500, cors);
        }
      },
    },
  },
});
