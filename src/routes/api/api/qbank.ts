import { createFileRoute } from "@tanstack/react-router";
import { getServiceAccount, getGoogleAccessToken, verifyFirebaseIdToken } from "@/lib/firebase.server";
import { getCorsHeaders } from "@/lib/cors";
import { routeRequest } from "@/lib/ai-router.server";
import { getClientIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit.server";
import { ensureQIndex, qindexLookup, normRef } from "@/lib/qindex.server";
import { gunzipSync } from "node:zlib";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

import { dbStats } from "@/lib/firebase.server";
import {
  getQbankListCache,
} from "@/lib/qbank-cache.server";
import {
  buildAccessBundle,
  getAccessBundleCached,
  loadAllBanks,
  resolveBankAccessEdge as resolveBankAccess,
} from "@/lib/qbank-access.server";
import { encryptForBank, splitQuestionsForStatic } from "@/lib/qbank-drm.server";

// Exam-prep list: static-ish admin content. 5-min shared cache avoids a full
// collection scan (N reads) on every call.
let examPrepCache: { items: any[]; exp: number } | null = null;
const EXAM_PREP_TTL_MS = 5 * 60_000;
// Library book lists: per bank, tiny (few docs), 5-min shared cache.
const libraryListCache = new Map<string, { items: any[]; exp: number }>();
const LIBRARY_LIST_TTL_MS = 5 * 60_000;
// Study concepts are identical for every user asking the same question.
// 10-min shared cache turns repeat views into 0 Firestore reads.
const studyConceptCache = new Map<string, { data: { studyConcept: string | null; studyConceptLang: string | null }; exp: number }>();
const STUDY_CONCEPT_TTL_MS = 10 * 60_000;
const STUDY_CONCEPT_MAX = 500;
function getCachedStudyConcept(key: string) {
  const e = studyConceptCache.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { studyConceptCache.delete(key); return null; }
  return e.data;
}
function setCachedStudyConcept(key: string, data: { studyConcept: string | null; studyConceptLang: string | null }) {
  if (studyConceptCache.size >= STUDY_CONCEPT_MAX) {
    const first = studyConceptCache.keys().next().value as string | undefined;
    if (first) studyConceptCache.delete(first);
  }
  studyConceptCache.set(key, { data, exp: Date.now() + STUDY_CONCEPT_TTL_MS });
}
// NOTE: no global DRM key. Bulk payloads use encryptForBank() (per-bank key,
// env-only). See src/lib/qbank-drm.server.ts + POST /api/qbank_key.

function json(body: unknown, status: number, cors: Record<string, string>) {
  const store = dbStats.getStore();
  return new Response(JSON.stringify(body), {
    status,
    headers: { 
      "content-type": "application/json", 
      "x-firestore-reads": store ? String(store.reads) : "0",
      "x-firestore-writes": store ? String(store.writes) : "0",
      ...cors 
    },
  });
}

export const Route = createFileRoute("/api/qbank")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "POST, GET, OPTIONS" });
        return new Response(null, { status: 204, headers: cors });
      },
      GET: async ({ request }) => {
        return dbStats.run({reads: 0, writes: 0}, async () => {
        const cors = getCorsHeaders(request, { methods: "POST, GET, OPTIONS" });
        
        const ip = getClientIp(request);
        const ipLimit = rateLimit(`qbank:ip:${ip}`, 60_000, 100);
        if (!ipLimit.ok) return rateLimitResponse(ipLimit.retryAfter, cors);

        const urlObj = new URL(request.url);
        const action = urlObj.searchParams.get("action");
        
        const sa = getServiceAccount();
        const token = await getGoogleAccessToken();

        // Public endpoints - no auth required
        if (action === "get_peer_stats_threshold") {
          try {
            const { loadPeerStatsSettings } = await import("@/lib/peer-stats-settings.server");
            const settings = await loadPeerStatsSettings();
            console.log("[peer-public] returning threshold:", settings.threshold);
            return json({ threshold: settings.threshold }, 200, cors);
          } catch (e) {
            console.error("[peer-public] error:", e);
            return json({ threshold: 50 }, 200, cors);
          }
        }

        if (action === "debug_peer_stats_doc") {
          try {
            const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/admin/peer_stats_settings`;
            const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
            const data = await r.json();
            return json({ raw: data }, 200, cors);
          } catch (e) {
            return json({ error: e.message }, 500, cors);
          }
        }

        // Auth required for everything below
        try {
          const auth = request.headers.get("authorization") || "";
          const m = auth.match(/^Bearer\s+(.+)$/i);
          if (!m) return json({ error: "Unauthorized" }, 401, cors);
          const user = await verifyFirebaseIdToken(m[1]);
          const uid = String(user.sub || user.user_id || "");
          if (!uid) return json({ error: "Unauthorized" }, 401, cors);

          const userLimit = rateLimit(`qbank:uid:${uid}`, 60_000, 60);
          if (!userLimit.ok) return rateLimitResponse(userLimit.retryAfter, cors);

          if (action === "list_categories") {
            // Version-aware cache: the list lives in memory until an admin
            // publish bumps a bank's `updatedAt` (which invalidates it).
            // Clients send their known maxUpdatedAt as `?v=`; a match means
            // "unchanged" with ZERO Firestore reads.
            //
            // NOTE: intentionally UNFILTERED (all banks, all users). Bank
            // ids/names/countries are already world-public via
            // /api/public/qbanks, so filtering here buys zero protection —
            // and it breaks the locked-card → "Request Access" discovery
            // flow (users can't request banks they can't see). Enforcement
            // lives at the content endpoints (get_questions / qbank_static /
            // qbank_key / get_answers all 403 by the same country+grant
            // rule); an id alone grants nothing.
            const clientV = parseInt(urlObj.searchParams.get("v") || "0", 10) || 0;
            try {
              const cached = getQbankListCache();
              if (cached) {
                if (clientV && clientV === cached.maxUpdatedAt) {
                  return json({ unchanged: true, maxUpdatedAt: cached.maxUpdatedAt }, 200, cors);
                }
                return json({ qbanks: cached.banks, maxUpdatedAt: cached.maxUpdatedAt, cached: true }, 200, cors);
              }
              const qbanks = await loadAllBanks(sa, token);
              const fresh = getQbankListCache();
              const maxUpdatedAt = fresh ? fresh.maxUpdatedAt : 0;
              if (clientV && clientV === maxUpdatedAt) {
                return json({ unchanged: true, maxUpdatedAt }, 200, cors);
              }
              return json({ qbanks, maxUpdatedAt }, 200, cors);
            } catch {
              return json({ error: "Failed to load qbanks" }, 500, cors);
            }
          }

          if (action === "list_exam_prep") {
            const nowEp = Date.now();
            if (examPrepCache && examPrepCache.exp > nowEp) {
              return json({ items: examPrepCache.items, cached: true }, 200, cors);
            }
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
                let qbankIds = [];
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
            examPrepCache = { items, exp: Date.now() + EXAM_PREP_TTL_MS };
            return json({ items }, 200, cors);
          }

          // ---------- Per-bank medical library (books) ----------
          // Storage: qbanks/{bankId}/books/{bookId} (one doc per book).
          // list_books = metadata only (cached 5 min shared); get_book =
          // single-doc read. Clients cache bodies forever in IndexedDB keyed
          // by updatedAt, so repeat opens cost 0 reads.
          if (action === "list_books") {
            const qbankId = urlObj.searchParams.get("qbankId");
            if (!qbankId) return json({ error: "Missing qbankId" }, 400, cors);
            if (!/^[a-zA-Z0-9_-]+$/.test(qbankId)) return json({ error: "Invalid qbankId" }, 400, cors);
            const access = await resolveBankAccess(sa, token, uid, qbankId);
            if (!access.ok) return json({ error: access.status === 404 ? "QBank not found" : "Forbidden" }, access.status === 404 ? 404 : 403, cors);
            const nowLib = Date.now();
            const libHit = libraryListCache.get(qbankId);
            if (libHit && libHit.exp > nowLib) {
              return json({ books: libHit.items, cached: true }, 200, cors);
            }
            const books: any[] = [];
            let libToken = "";
            while (true) {
              const params = new URLSearchParams({ pageSize: "100" });
              if (libToken) params.set("pageToken", libToken);
              const r = await fetch(
                `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}/books?${params}`,
                { headers: { Authorization: `Bearer ${token}` } }
              );
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
              libToken = d.nextPageToken || "";
              if (!libToken) break;
            }
            books.sort((a, b) => String(a.title).localeCompare(String(b.title)));
            libraryListCache.set(qbankId, { items: books, exp: Date.now() + LIBRARY_LIST_TTL_MS });
            return json({ books }, 200, cors);
          }

          if (action === "get_book") {
            const qbankId = urlObj.searchParams.get("qbankId");
            const bookId = urlObj.searchParams.get("bookId");
            if (!qbankId || !bookId) return json({ error: "Missing ids" }, 400, cors);
            if (!/^[a-zA-Z0-9_-]+$/.test(qbankId) || !/^[a-z0-9-]+$/.test(bookId)) return json({ error: "Invalid ids" }, 400, cors);
            const access = await resolveBankAccess(sa, token, uid, qbankId);
            if (!access.ok) return json({ error: access.status === 404 ? "QBank not found" : "Forbidden" }, access.status === 404 ? 404 : 403, cors);
            const r = await fetch(
              `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}/books/${bookId}`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            if (!r.ok) return json({ error: "Book not found" }, 404, cors);
            const doc = await r.json();
            const f = doc.fields || {};
            let data: any = null;
            try { data = JSON.parse(f.data?.stringValue || "null"); } catch {}
            if (!data || !Array.isArray(data.units)) return json({ error: "Book data corrupt" }, 500, cors);
            return json({
              book: {
                id: bookId,
                title: f.title?.stringValue || bookId,
                subject: f.subject?.stringValue || "",
                updatedAt: parseInt(f.updatedAt?.integerValue || "0", 10) || 0,
                lessonCount: parseInt(f.lessonCount?.integerValue || "0", 10) || 0,
                units: data.units,
              },
            }, 200, cors);
          }

          // ---------- Country-based qbank access ----------
          if (action === "bootstrap_access") {
            // Returns the caller's profile country, the main qbanks of that
            // country, the exam-prep sub-banks of that country, plus any
            // individually granted banks (admin-approved requests).
            // Bundle is cached 1h per user (KV-style); bank metadata comes
            // from the shared publish-invalidated list cache (0 reads warm).
            try {
              const bundle = await getAccessBundleCached(sa, token, uid);
              return json(bundle, 200, cors);
            } catch {
              return json({ profileCountry: "", mainIds: [], prepIds: [], grants: [], legacy: true }, 200, cors);
            }
          }

          if (action === "my_access_requests") {
            // Bank ids the caller already asked for and is waiting on.
            // Lets the bank list render "Pending" instead of inviting a
            // duplicate request. Billed reads = # pending docs (min 1).
            try {
              const qRes = await fetch(
                `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents:runQuery`,
                {
                  method: "POST",
                  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    structuredQuery: {
                      from: [{ collectionId: "access_requests" }],
                      where: {
                        compositeFilter: { op: "AND", filters: [
                          { fieldFilter: { field: { fieldPath: "uid" }, op: "EQUAL", value: { stringValue: uid } } },
                          { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "pending" } } },
                        ] },
                      },
                      select: { fields: [{ fieldPath: "qbankId" }] },
                      limit: 50,
                    },
                  }),
                }
              );
              if (!qRes.ok) return json({ pendingIds: [] }, 200, cors);
              const qd = await qRes.json();
              const pendingIds: string[] = [];
              for (const el of (Array.isArray(qd) ? qd : [])) {
                const bid = el?.document?.fields?.qbankId?.stringValue;
                if (bid) pendingIds.push(String(bid));
              }
              return json({ pendingIds }, 200, cors);
            } catch {
              return json({ pendingIds: [] }, 200, cors);
            }
          }


          if (action === "get_question") {
            // Live lookup by human code / doc id / doc-id prefix against the
            // shared in-memory index. Index is surgically updated on every
            // admin edit/import/delete, so results are always fresh. The
            // document itself is fetched live from Firestore.
            const rawRef = urlObj.searchParams.get("ref") || "";
            const hintBank = urlObj.searchParams.get("qbankId") || "";
            const wantRefresh = urlObj.searchParams.get("refresh") === "1";
            if (!rawRef || !/^[A-Za-z0-9_-]{3,64}$/.test(rawRef)) return json({ error: "Invalid ref" }, 400, cors);

            await ensureQIndex(wantRefresh);
            const candidates = qindexLookup(rawRef);
            if (candidates.length === 0) return json({ question: null, matches: 0 }, 404, cors);

            const validId = (x: string) => /^[a-zA-Z0-9_-]+$/.test(x);
            const fetchDoc = async (bid: string, qid: string) => {
              if (!validId(bid) || !validId(qid)) return null;

              // Access Verification Check (grants unlock any kind of bank)
              const access = await resolveBankAccess(sa, token, uid, bid);
              if (!access.ok) return null;

              const r = await fetch(
                `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${bid}/questions/${qid}`,
                { headers: { Authorization: `Bearer ${token}` } }
              );
              if (!r.ok) return null;
              const doc = await r.json();
              let parsed: any = {};
              try { parsed = JSON.parse(doc.fields?.data?.stringValue || "{}"); } catch {}
              return { id: qid, text: doc.fields?.questionText?.stringValue || "", data: parsed, qbankId: bid };
            };

            // Rank: hinted bank first
            const rank = (e: any) => (validId(hintBank) && e.qbankId === hintBank ? 0 : 1);
            candidates.sort((a: any, b: any) => rank(a) - rank(b));

            const alive: any[] = [];
            for (const c of candidates.slice(0, 5)) {
              const doc = await fetchDoc(c.qbankId, c.questionId);
              if (doc) alive.push(doc);
            }
            if (alive.length === 0) {
              // stale index entries — force rebuild next time
              await ensureQIndex(true).catch(() => {});
              return json({ question: null, matches: candidates.length }, 404, cors);
            }
            const [best, ...rest] = alive;
            return json({
              question: best,
              matches: candidates.length,
              alternatives: rest.map(r => ({ qbankId: r.qbankId, id: r.id })),
            }, 200, cors);
          }

          if (action === "get_questions") {
            const qbankId = urlObj.searchParams.get("qbankId");
            const onlyProgress = urlObj.searchParams.get("onlyProgress") === "true";
            if (!qbankId) return json({ error: "Missing qbankId" }, 400, cors);
            
            // Validate alphanumeric to prevent basic injection, though it's just a path param
            if (!/^[a-zA-Z0-9_-]+$/.test(qbankId)) return json({ error: "Invalid qbankId" }, 400, cors);

            // Security: Verify user has access to this QBank.
            // Profile (60s cache) + bank metadata (shared list cache) = 0
            // reads when warm; only the progress blob below costs a read.
            // Security: Verify user has access to this QBank (profile 60s
            // cache + shared bank metadata; exactly one fresh profile read
            // before giving up, so a just-approved grant is never missed).
            const access = await resolveBankAccess(sa, token, uid, qbankId);
            if (!access.ok && access.status === 404) {
              return json({ error: "QBank not found" }, 404, cors);
            }
            if (!access.ok) {
              return json({
                error: "Forbidden: You do not have access to this QBank.",
                detail: {
                  bankKind: access.meta?.kind || "unknown",
                  bankCountry: access.meta?.country || "unknown",
                  profileCountry: access.profile.country || "(none)",
                  grantListed: access.profile.grants.includes(qbankId),
                },
              }, 403, cors);
            }

            // Batched access bundle (?includeAccess=1): lets the client skip
            // the standalone bootstrap_access roundtrip. The bundle is
            // already resolved for the check above (1h cache, 0 extra reads
            // when warm).
            let accessBundle: ReturnType<typeof buildAccessBundle> | null = null;
            if (urlObj.searchParams.get("includeAccess") === "1" || urlObj.searchParams.get("includeAccess") === "true") {
              try {
                accessBundle = access.bundle || await getAccessBundleCached(sa, token, uid);
              } catch { /* progress still returns, just without the bundle */ }
            }

            const questions: any[] = [];
            
            if (!onlyProgress) {
              const storageProvider = access.meta?.storage_provider;
              let fetchedFromChunks = false;

              if (storageProvider === "r2") {
                const s3Client = new S3Client({
                  region: "auto",
                  endpoint: process.env.R2_ENDPOINT!,
                  forcePathStyle: true,
                  credentials: {
                    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
                    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
                  },
                });
                try {
                  const objRes = await s3Client.send(new GetObjectCommand({
                    Bucket: process.env.R2_BUCKET_NAME || "curaq",
                    Key: `qbanks/${qbankId}/chunks.json.gz`,
                  }));
                  const bytes = await objRes.Body?.transformToByteArray();
                  if (bytes) {
                    const rawJson = gunzipSync(bytes).toString('utf-8');
                    const parsed = JSON.parse(rawJson);
                    questions.push(...parsed);
                    fetchedFromChunks = true;
                  }
                } catch (e) {
                  console.error("Failed to fetch chunks from R2", e);
                }
              }

              // 1. Try fetching from Firestore chunks (if not already fetched from R2)
              if (!fetchedFromChunks) {
              let chunkToken = "";
              const allChunks: any[] = [];
              while (true) {
                const params = new URLSearchParams({ pageSize: "100" });
                if (chunkToken) params.set("pageToken", chunkToken);
                const chunkUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}/chunks?${params}`;
                const chunkRes = await fetch(chunkUrl, { headers: { Authorization: `Bearer ${token}` } });
                if (!chunkRes.ok || chunkRes.status === 404) break;
                
                const chunkData = await chunkRes.json();
                if (chunkData.documents && chunkData.documents.length > 0) {
                  fetchedFromChunks = true;
                  allChunks.push(...chunkData.documents);
                }
                chunkToken = chunkData.nextPageToken || "";
                if (!chunkToken) break;
              }

              if (fetchedFromChunks) {
                  allChunks.sort((a, b) => {
                     const aIdx = parseInt(a.fields?.index?.integerValue || "0", 10);
                     const bIdx = parseInt(b.fields?.index?.integerValue || "0", 10);
                     return aIdx - bIdx;
                  });
                  for (const doc of allChunks) {
                     const dataStr = doc.fields?.data?.stringValue;
                     if (dataStr) {
                        try {
                          let parsedChunk;
                          if (dataStr.trim().startsWith("[")) {
                            parsedChunk = JSON.parse(dataStr);
                          } else {
                            const buf = Buffer.from(dataStr, 'base64');
                            const rawJson = gunzipSync(buf).toString('utf-8');
                            parsedChunk = JSON.parse(rawJson);
                          }
                          questions.push(...parsedChunk);
                        } catch (e) {
                          console.error("Failed to parse chunk", doc.name, e);
                        }
                     }
                  }
              }
              }

              // 2. Fallback to fetching individual questions if no chunks exist
              if (!fetchedFromChunks) {
                let pageTokenQ = "";
                while (true) {
                  const params = new URLSearchParams({ pageSize: "300" });
                  if (pageTokenQ) params.set("pageToken", pageTokenQ);
                  const qRes = await fetch(
                    `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}/questions?${params}`,
                    {
                      method: "GET",
                      headers: { Authorization: `Bearer ${token}` }
                    }
                  );
                  
                  if (!qRes.ok && qRes.status !== 404) return json({ error: "Failed to load questions" }, 500, cors);
                  if (qRes.status === 404) break;
                  
                  const qData = await qRes.json();
                  if (qData && Array.isArray(qData.documents)) {
                    for (const doc of qData.documents) {
                      const id = doc.name.split("/").pop();
                      const text = doc.fields?.questionText?.stringValue || "";
                      const dataStr = doc.fields?.data?.stringValue;
                      
                      if (dataStr) {
                        try {
                          const parsed = JSON.parse(dataStr);
                          questions.push({ id, text, data: parsed });
                        } catch (e) {
                          console.error("Failed to parse qbank question", id, e);
                        }
                      }
                    }
                  }
                  pageTokenQ = qData.nextPageToken || "";
                  if (!pageTokenQ) break;
                }
              }
            }
            
            const progressMap: Record<string, any> = {};
            const pRes = await fetch(
              `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users_index/${uid}/qbank_progress_blobs/${qbankId}`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            
            if (pRes.ok) {
              try {
                const doc = await pRes.json();
                const fields = doc.fields?.progress?.mapValue?.fields || {};
                for (const [qId, val] of Object.entries(fields)) {
                  const data: any = (val as any).mapValue?.fields || {};
                  progressMap[qId] = {
                    correct: data.correct?.booleanValue,
                    timeTakenMs: parseInt(data.timeTakenMs?.integerValue || "0", 10),
                    marked: data.marked?.booleanValue || false,
                    note: data.note?.stringValue || ""
                  };
                }
              } catch (e) {
                console.error("Failed to parse progress blob", e);
              }
            }

            if (!onlyProgress && questions.length > 0) {
              // Stems-only + per-bank key (same contract as /api/qbank_static).
              const { stems } = splitQuestionsForStatic(questions);
              const bankCountry = access.meta?.country || "global";
              try {
                const encryptedQuestions = await encryptForBank(JSON.stringify(stems), qbankId, bankCountry);
                return json({ encryptedQuestions, answersSplit: true, progress: progressMap, ...(accessBundle ? { access: accessBundle } : {}) }, 200, cors);
              } catch (e: any) {
                console.error("[get_questions] DRM key missing:", e?.message);
                return json({ error: "Server misconfigured" }, 500, cors);
              }
            }

            return json({ questions, progress: progressMap, ...(accessBundle ? { access: accessBundle } : {}) }, 200, cors);
          }

          if (action === "get_answers") {
            // On-demand answer slice for stems-only clients. Served from the
            // bank's private R2 chunks via a 5-min in-memory answer map: 0
            // Firestore reads on the hot path (or 0 reads + 1 R2 GET on map
            // build). Firestore single-doc reads happen ONLY for ids missing
            // from R2 (legacy banks / brand-new questions). Still strictly
            // rate-limited so bulk-scraping 37k answers takes thousands of
            // throttled calls instead of 1 download.
            const qbankId = urlObj.searchParams.get("qbankId");
            const rawIds = urlObj.searchParams.get("ids") || "";
            if (!qbankId) return json({ error: "Missing qbankId" }, 400, cors);
            if (!/^[a-zA-Z0-9_-]+$/.test(qbankId)) return json({ error: "Invalid qbankId" }, 400, cors);
            const ids = rawIds.split(",").map((s) => s.trim()).filter((s) => /^[a-zA-Z0-9_-]{1,64}$/.test(s));
            if (ids.length === 0) return json({ error: "Missing ids" }, 400, cors);
            if (ids.length > 50) return json({ error: "Too many ids (max 50)" }, 400, cors);
            const uniq = [...new Set(ids)].slice(0, 50);
            const ansLimit = rateLimit(`qbank-answers:${uid}`, 60_000, 60);
            if (!ansLimit.ok) return rateLimitResponse(ansLimit.retryAfter, cors);
            const access = await resolveBankAccess(sa, token, uid, qbankId);
            if (!access.ok) return json({ error: access.status === 404 ? "QBank not found" : "Forbidden" }, access.status === 404 ? 404 : 403, cors);
            const { getBulkAnswers } = await import("@/lib/qbank-answers.server");
            const answers = await getBulkAnswers(sa, token, qbankId, uniq, access.meta?.storage_provider);
            return json({ answers }, 200, cors);
          }

          if (action === "get_study_concept") {
            const qbankId = urlObj.searchParams.get("qbankId");
            const questionId = urlObj.searchParams.get("questionId");
            if (!qbankId || !questionId) return json({ error: "Missing ids" }, 400, cors);
            if (!/^[a-zA-Z0-9_-]+$/.test(qbankId) || !/^[a-zA-Z0-9_-]+$/.test(questionId)) return json({ error: "Invalid ids" }, 400, cors);
            const wantLang = /^[a-zA-Z-]{2,8}$/.test(urlObj.searchParams.get("lang") || "")
              ? urlObj.searchParams.get("lang")!.slice(0, 8)
              : "";
            const access = await resolveBankAccess(sa, token, uid, qbankId);
            if (!access.ok) return json({ error: access.status === 404 ? "QBank not found" : "Forbidden" }, access.status === 404 ? 404 : 403, cors);

            const cacheKey = `${qbankId}/${questionId}/${wantLang}`;
            const hit = getCachedStudyConcept(cacheKey);
            if (hit) return json({ ...hit, cached: true }, 200, cors);

            // Concepts are generated once per (question, lang) and shared by
            // all students. Serve from the R2 snapshot: 0 Firestore reads hot.
            try {
              const { getConceptForQuestion } = await import("@/lib/qbank-answers.server");
              const fromR2 = await getConceptForQuestion(qbankId, questionId, wantLang);
              if (fromR2) {
                setCachedStudyConcept(cacheKey, fromR2);
                return json({ ...fromR2, cachedR2: true }, 200, cors);
              }
            } catch { /* fall through to Firestore */ }

            const r = await fetch(
              `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}/questions/${questionId}`,
              { headers: { Authorization: `Bearer ${token}` } }
            );

            if (!r.ok) return json({ studyConcept: null, studyConceptLang: null }, 200, cors);
            const doc = await r.json();
            const fields = doc.fields || {};
            // Per-lang map first (written by save_study_concept, no clobber),
            // legacy single fields as fallback.
            const langMap = fields.studyConcepts?.mapValue?.fields || {};
            let studyConcept: string | null = null;
            let studyConceptLang: string | null = null;
            if (wantLang && langMap[wantLang]?.stringValue) {
              studyConcept = langMap[wantLang].stringValue;
              studyConceptLang = wantLang;
            } else if (fields.studyConcept?.stringValue) {
              studyConcept = fields.studyConcept.stringValue;
              studyConceptLang = fields.studyConceptLang?.stringValue || null;
            } else {
              const firstLang = Object.keys(langMap)[0];
              if (firstLang && langMap[firstLang]?.stringValue) {
                studyConcept = langMap[firstLang].stringValue;
                studyConceptLang = firstLang;
              }
            }
            // Only cache when a concept exists; misses stay uncached so a
            // just-generated concept is visible immediately.
            if (studyConcept) setCachedStudyConcept(cacheKey, { studyConcept, studyConceptLang });
            return json({ studyConcept, studyConceptLang }, 200, cors);
          }

          return json({ error: "Invalid action" }, 400, cors);
        } catch (e) {
          console.error("[qbank GET]", (e as Error).message);
          return json({ error: "Server error" }, 500, cors);
        }
        });
      },
      POST: async ({ request }) => {
        return dbStats.run({reads: 0, writes: 0}, async () => {
        const cors = getCorsHeaders(request, { methods: "POST, GET, OPTIONS" });
        
        const ip = getClientIp(request);
        const ipLimit = rateLimit(`qbank:ip:${ip}`, 60_000, 100);
        if (!ipLimit.ok) return rateLimitResponse(ipLimit.retryAfter, cors);

        try {
          const auth = request.headers.get("authorization") || "";
          const m = auth.match(/^Bearer\s+(.+)$/i);
          if (!m) return json({ error: "Unauthorized" }, 401, cors);
          const user = await verifyFirebaseIdToken(m[1]);
          const uid = String(user.sub || user.user_id || "");
          if (!uid) return json({ error: "Unauthorized" }, 401, cors);

          const userLimit = rateLimit(`qbank:uid:${uid}`, 60_000, 60);
          if (!userLimit.ok) return rateLimitResponse(userLimit.retryAfter, cors);

          const body = (await request.json()) as any;
          const sa = getServiceAccount();
          const token = await getGoogleAccessToken();
          if (body.action === "batch_sync_progress") {
            const { updates } = body;
            if (!Array.isArray(updates) || updates.length === 0) return json({ ok: true }, 200, cors);
            if (updates.length > 100) return json({ error: "Too many updates in batch" }, 400, cors);
            
            let incrementAnswerCount = 0;
            const qbankUpdates: Record<string, { paths: Set<string>, progressFields: any }> = {};
            
            for (const u of updates) {
               if (!/^[a-zA-Z0-9_-]+$/.test(u.qbankId) || !/^[a-zA-Z0-9_-]+$/.test(u.questionId)) {
                  throw new Error("Invalid identifiers");
               }
               if (!qbankUpdates[u.qbankId]) {
                   qbankUpdates[u.qbankId] = { paths: new Set<string>(), progressFields: {} };
               }
               
               let qField: any = {};
               if (qbankUpdates[u.qbankId].progressFields[u.questionId]) {
                   qField = qbankUpdates[u.qbankId].progressFields[u.questionId].mapValue.fields;
               }
               
               if (u.correct !== undefined) { 
                   qField.correct = { booleanValue: !!u.correct }; 
                   incrementAnswerCount++;
               }
               if (u.timeTakenMs !== undefined) { qField.timeTakenMs = { integerValue: String(u.timeTakenMs) }; }
               if (u.marked !== undefined) { qField.marked = { booleanValue: !!u.marked }; }
               if (u.note !== undefined) { qField.note = { stringValue: String(u.note) }; }
               qField.timestamp = { timestampValue: new Date().toISOString() };
               
               qbankUpdates[u.qbankId].progressFields[u.questionId] = { mapValue: { fields: qField } };
               
               if (u.correct !== undefined) qbankUpdates[u.qbankId].paths.add(`progress.\`${u.questionId}\`.correct`);
               if (u.timeTakenMs !== undefined) qbankUpdates[u.qbankId].paths.add(`progress.\`${u.questionId}\`.timeTakenMs`);
               if (u.marked !== undefined) qbankUpdates[u.qbankId].paths.add(`progress.\`${u.questionId}\`.marked`);
               if (u.note !== undefined) qbankUpdates[u.qbankId].paths.add(`progress.\`${u.questionId}\`.note`);
               qbankUpdates[u.qbankId].paths.add(`progress.\`${u.questionId}\`.timestamp`);
            }

            const writes = Object.keys(qbankUpdates).map(qbankId => {
               const data = qbankUpdates[qbankId];
               return {
                 update: {
                   name: `projects/${sa.project_id}/databases/(default)/documents/users_index/${uid}/qbank_progress_blobs/${qbankId}`,
                   fields: {
                     progress: {
                       mapValue: {
                         fields: data.progressFields
                       }
                     }
                   }
                 },
                 updateMask: { fieldPaths: Array.from(data.paths) }
               };
            });

            if (incrementAnswerCount > 0) {
               writes.push({
                 transform: {
                   document: `projects/${sa.project_id}/databases/(default)/documents/users_index/${uid}`,
                   fieldTransforms: [{
                     fieldPath: "qbankAnswerCount",
                     increment: { integerValue: String(incrementAnswerCount) }
                   }]
                 }
               });
            }
            
            const commitUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents:commit`;
            const commitRes = await fetch(commitUrl, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ writes })
            });
            
            if (!commitRes.ok) {
              const errTxt = await commitRes.text();
              console.error("Batch sync failed", errTxt);
              return json({ error: "Failed to sync progress: " + errTxt }, 500, cors);
            }
            
            return json({ ok: true }, 200, cors);
          }

          if (body.action === "save_progress") {
            const { qbankId, questionId, correct, timeTakenMs } = body;
            
            if (!qbankId || !questionId || typeof correct !== "boolean" || typeof timeTakenMs !== "number") {
              return json({ error: "Invalid payload" }, 400, cors);
            }
            if (!/^[a-zA-Z0-9_-]+$/.test(qbankId) || !/^[a-zA-Z0-9_-]+$/.test(questionId)) {
               return json({ error: "Invalid identifiers" }, 400, cors);
            }

            const docUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users_index/${uid}/qbank_progress_blobs/${qbankId}?updateMask.fieldPaths=progress.${questionId}.correct&updateMask.fieldPaths=progress.${questionId}.timeTakenMs&updateMask.fieldPaths=progress.${questionId}.timestamp`;
            
            const patchRes = await fetch(docUrl, {
              method: "PATCH",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                fields: {
                  progress: {
                    mapValue: {
                      fields: {
                        [questionId]: {
                          mapValue: {
                            fields: {
                              correct: { booleanValue: correct },
                              timeTakenMs: { integerValue: String(timeTakenMs) },
                              timestamp: { timestampValue: new Date().toISOString() }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              })
            });
            
            if (!patchRes.ok) {
              const errTxt = await patchRes.text();
              console.error("Save progress failed", errTxt);
              return json({ error: "Failed to save progress" }, 500, cors);
            }

            // Increment the overall qbankAnswerCount in users_index
            const incUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents:commit`;
            fetch(incUrl, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                writes: [{
                  transform: {
                    document: `projects/${sa.project_id}/databases/(default)/documents/users_index/${uid}`,
                    fieldTransforms: [{ fieldPath: "qbankAnswerCount", increment: { integerValue: "1" } }]
                  }
                }]
              })
            }).catch(e => console.error("Failed to increment answer count", e));
            
            return json({ ok: true }, 200, cors);
          }
          
          if (body.action === "update_question_meta") {
            const { qbankId, questionId, marked, note } = body;
            
            if (!qbankId || !questionId) {
              return json({ error: "Invalid payload" }, 400, cors);
            }
            if (!/^[a-zA-Z0-9_-]+$/.test(qbankId) || !/^[a-zA-Z0-9_-]+$/.test(questionId)) {
               return json({ error: "Invalid identifiers" }, 400, cors);
            }

            const qField: any = {
              timestamp: { timestampValue: new Date().toISOString() }
            };
            const paths = [`progress.${questionId}.timestamp`];
            
            if (marked !== undefined) {
              qField.marked = { booleanValue: !!marked };
              paths.push(`progress.${questionId}.marked`);
            }
            if (note !== undefined) {
              qField.note = { stringValue: String(note) };
              paths.push(`progress.${questionId}.note`);
            }

            const maskStr = paths.map(m => `updateMask.fieldPaths=${m}`).join("&");
            const docUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users_index/${uid}/qbank_progress_blobs/${qbankId}?${maskStr}`;
            
            const patchRes = await fetch(docUrl, {
              method: "PATCH",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                fields: {
                  progress: {
                    mapValue: {
                      fields: {
                        [questionId]: {
                          mapValue: {
                            fields: qField
                          }
                        }
                      }
                    }
                  }
                }
              })
            });
            
            if (!patchRes.ok) {
              const errTxt = await patchRes.text();
              console.error("Update meta failed", errTxt);
              return json({ error: "Failed to update metadata" }, 500, cors);
            }
            
            return json({ ok: true }, 200, cors);
          }
          if (body.action === "report_question") {
            const { qbankId, questionId, reason } = body;
            if (!qbankId || !questionId || !reason) return json({ error: "Missing fields" }, 400, cors);
            
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();
            const commitUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents:commit`;
            
            const writes = [
              {
                update: {
                  name: `projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}/questions/${questionId}`,
                  fields: {
                    reported: { booleanValue: true }
                  }
                },
                updateMask: { fieldPaths: ["reported"] }
              },
              {
                transform: {
                  document: `projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}/questions/${questionId}`,
                  fieldTransforms: [
                    {
                      fieldPath: "reports",
                      appendMissingElements: {
                        values: [
                          {
                            mapValue: {
                              fields: {
                                uid: { stringValue: uid },
                                reason: { stringValue: String(reason) },
                                timestamp: { timestampValue: new Date().toISOString() }
                              }
                            }
                          }
                        ]
                      }
                    }
                  ]
                }
              }
            ];
            
            const commitRes = await fetch(commitUrl, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ writes })
            });
            
            if (!commitRes.ok) {
              const errTxt = await commitRes.text();
              console.error("Report question failed", errTxt);
              return json({ error: "Failed to report question" }, 500, cors);
            }
            
            return json({ ok: true }, 200, cors);
          }
          
          if (body.action === "chat_question") {
             if (!body.questionContext || !body.userMessage) {
                return json({ error: "Missing context or message" }, 400, cors);
             }

             // Answer in the student's language (explicit choice, or "auto"
             // = match the question's own language). Otherwise the tutor
             // defaults to English even for French questions.
             let chatLang: string | undefined;
             if (typeof body.lang === "string" && /^[a-zA-Z-]{2,8}$/.test(body.lang)) {
               chatLang = body.lang.slice(0, 8);
             }
             let langSuffix = "";
             if (chatLang) {
               try {
                 const { langInstruction } = await import("@/lib/prompt-registry.server");
                 langSuffix = langInstruction(chatLang);
               } catch { /* non-fatal: answer without language pinning */ }
             }

             const messages = [
               {
                 role: "system",
                 content: "You are an expert medical AI tutor. The user is asking a follow-up question about a specific exam question they just reviewed. Be helpful, concise, and explain concepts clearly. Use markdown formatting.\n\nIMPORTANT: Do NOT output your internal thinking process or any <think> tags. Just output the final response." + langSuffix + "\n\nHere is the question context:\n" + body.questionContext
               },
               {
                 role: "user",
                 content: body.userMessage
               }
             ];

             const r = await routeRequest({ messages, requireJson: false });
             
             let finalRes = r.text || "";
             // Strip out <think> tags if the model still includes them
             finalRes = finalRes.replace(/<think>[\s\S]*?<\/think>/gi, "");
             
             // In some cases OpenRouter or deepseek injects "Here's a thinking process:" 
             // We can strip anything before a horizontal rule if it's explicitly a thinking process,
             // or simply strip the specific string.
             if (finalRes.includes("Here's a thinking process:")) {
                const parts = finalRes.split("---\n");
                if (parts.length > 1) {
                    finalRes = parts.slice(1).join("---\n");
                } else {
                    // fallback if no horizontal rule
                    finalRes = finalRes.replace(/Here's a thinking process:[\s\S]*?(\n\n|$)/gi, "");
                }
             }

             return json({ response: finalRes.trim() }, 200, cors);
          }
          
          if (body.action === "save_flashcard") {
             const { questionId, qbankId, front, back, concepts } = body;
             if (!questionId || !front) return json({ error: "Missing fields" }, 400, cors);
             
             // Ensure reasonable limits
             const cardId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
             const docUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users_index/${uid}/qbank_flashcards/${cardId}`;
             
             const createRes = await fetch(docUrl, {
               method: "PATCH",
               headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
               body: JSON.stringify({
                 fields: {
                   questionId: { stringValue: String(questionId) },
                   qbankId: { stringValue: String(qbankId || "") },
                   front: { stringValue: String(front) },
                   back: { stringValue: String(back || "") },
                   concepts: { stringValue: String(concepts || "") },
                   timestamp: { timestampValue: new Date().toISOString() },
                   nextReviewAt: { timestampValue: new Date().toISOString() },
                   interval: { integerValue: "0" },
                   repetition: { integerValue: "0" },
                   ease: { doubleValue: 2.5 }
                 }
               })
             });
             
             if (!createRes.ok) {
               const errTxt = await createRes.text();
               console.error("Save flashcard failed", errTxt);
               return json({ error: "Failed to save flashcard" }, 500, cors);
             }
             
             return json({ ok: true, cardId }, 200, cors);
          }
          
          if (body.action === "request_access") {
            // Student asks for permission to open another country's bank.
            const qbankId = String(body?.qbankId || "");
            const reason = String(body?.reason || "").trim().slice(0, 600);
            if (!qbankId || !/^[a-zA-Z0-9_-]+$/.test(qbankId)) return json({ error: "Missing qbankId" }, 400, cors);
            if (!reason || reason.length < 5) return json({ error: "Please provide a short reason" }, 400, cors);

            // Basic rate limit: max 10 open requests per user
            const q = await fetch(
              `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents:runQuery`,
              {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  structuredQuery: {
                    from: [{ collectionId: "access_requests" }],
                    where: {
                      compositeFilter: { op: "AND", filters: [
                        { fieldFilter: { field: { fieldPath: "uid" }, op: "EQUAL", value: { stringValue: uid } } },
                        { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "pending" } } },
                      ] },
                    },
                    limit: 10,
                  },
                }),
              }
            );
            if (q.ok) {
              const qd = await q.json();
              const pending = (qd || []).filter((x: any) => x.document).length;
              if (pending >= 10) return json({ error: "You already have many pending requests. Please wait." }, 429, cors);
            }

            // Per-bank dedupe: one pending request per bank. A repeat tap
            // succeeds idempotently so the client can flip to "Pending".
            try {
              const dupQ = await fetch(
                `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents:runQuery`,
                {
                  method: "POST",
                  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    structuredQuery: {
                      from: [{ collectionId: "access_requests" }],
                      where: {
                        compositeFilter: { op: "AND", filters: [
                          { fieldFilter: { field: { fieldPath: "uid" }, op: "EQUAL", value: { stringValue: uid } } },
                          { fieldFilter: { field: { fieldPath: "qbankId" }, op: "EQUAL", value: { stringValue: qbankId } } },
                          { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "pending" } } },
                        ] },
                      },
                      select: { fields: [{ fieldPath: "__name__" }] },
                      limit: 1,
                    },
                  }),
                }
              );
              if (dupQ.ok) {
                const dd = await dupQ.json();
                if ((Array.isArray(dd) ? dd : []).some((x: any) => x && x.document)) {
                  return json({ ok: true, alreadyRequested: true }, 200, cors);
                }
              }
            } catch { /* fall through to creating the request */ }

            const now = new Date();
            const reqId = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
            const fields: Record<string, any> = {
              uid: { stringValue: uid },
              email: { stringValue: String((user as any).email || "") },
              qbankId: { stringValue: qbankId },
              reason: { stringValue: reason },
              status: { stringValue: "pending" },
              createdAt: { timestampValue: now.toISOString() },
            };
            const mask = Object.keys(fields).map(f => `updateMask.fieldPaths=${f}`).join("&");
            const wr = await fetch(
              `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/access_requests/${reqId}?${mask}`,
              {
                method: "PATCH",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ fields }),
              }
            );
            if (!wr.ok) {
              console.error("[request_access] write failed", wr.status, await wr.text().catch(() => ""));
              return json({ error: "Could not file request" }, 500, cors);
            }
            return json({ ok: true }, 200, cors);
          }

          if (body.action === "save_study_concept") {
            const { qbankId, questionId, studyConcept } = body;
            if (!qbankId || !questionId || !studyConcept) return json({ error: "Missing fields" }, 400, cors);
            if (!/^[a-zA-Z0-9_-]+$/.test(qbankId) || !/^[a-zA-Z0-9_-]+$/.test(questionId)) return json({ error: "Invalid ids" }, 400, cors);
            const access = await resolveBankAccess(sa, token, uid, qbankId);
            if (!access.ok) return json({ error: access.status === 404 ? "QBank not found" : "Forbidden" }, access.status === 404 ? 404 : 403, cors);
            // Generation language tag so future readers get content in
            // their own language instead of a stale English copy.
            const conceptLang = typeof body.lang === "string" && /^[a-zA-Z-]{2,8}$/.test(body.lang)
              ? body.lang.slice(0, 8) : "en";

            // Per-lang map merge: generating in Arabic must NEVER clobber the
            // French concept (the old single-field overwrite did exactly
            // that, causing regen churn). One write, one (question, lang)
            // forever, shared by all future students.
            const mask = `updateMask.fieldPaths=${encodeURIComponent(`studyConcepts.${conceptLang}`)}&updateMask.fieldPaths=studyConcept&updateMask.fieldPaths=studyConceptLang`;
            const docUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}/questions/${questionId}?${mask}`;

            const fields: Record<string, unknown> = {
              studyConcepts: { mapValue: { fields: { [conceptLang]: { stringValue: String(studyConcept) } } } },
              studyConcept: { stringValue: String(studyConcept) },
              studyConceptLang: { stringValue: conceptLang },
            };

            const patchRes = await fetch(docUrl, {
              method: "PATCH",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ fields })
            });
            
            if (!patchRes.ok) {
              const errTxt = await patchRes.text();
              console.error("Save study concept failed", errTxt);
              return json({ error: "Failed to save study concept" }, 500, cors);
            }
            setCachedStudyConcept(`${qbankId}/${questionId}/${conceptLang}`, { studyConcept: String(studyConcept), studyConceptLang: conceptLang });
            // Concepts digest for 1-read exports: upsert this (question, lang)
            // entry (map key includes lang, so per-lang concepts coexist and
            // re-saves overwrite their own key). Best-effort — a digest
            // failure must never fail the concept save itself.
            // Client sends code/subject/chapter it already holds (0 extra reads).
            try {
              const digestKey = `${questionId}__${conceptLang}`;
              const entryMask = `updateMask.fieldPaths=${encodeURIComponent(`entries.${digestKey}`)}&updateMask.fieldPaths=updatedAt`;
              const digestUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}/library/concepts?${entryMask}`;
              const entryFields: Record<string, unknown> = {
                code: { stringValue: String(body.code || "").slice(0, 24) },
                subject: { stringValue: String(body.subject || "").slice(0, 120) },
                chapter: { stringValue: String(body.chapter || "").slice(0, 120) },
                concept: { stringValue: String(studyConcept) },
                lang: { stringValue: conceptLang || "" },
              };
              fetch(digestUrl, {
                method: "PATCH",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  fields: {
                    entries: { mapValue: { fields: { [digestKey]: { mapValue: { fields: entryFields } } } } },
                    updatedAt: { integerValue: String(Date.now()) },
                  },
                }),
              }).catch((e) => console.warn("[concepts digest] upsert failed:", (e as Error).message));
            } catch (e) {
              console.warn("[concepts digest] upsert failed:", (e as Error).message);
            }
            return json({ ok: true }, 200, cors);
          }
          
          if (body.action === "batch_log_peer_votes") {
            // DISABLED for now: peer stats fully off (0 reads + 0 writes).
            // Early return BEFORE any Firestore touch, so even stale cached
            // clients (v26-v29) that still flush their IDB outbox can't
            // write. Re-enable by setting PEER_STATS_WRITE_ENABLED = true.
            const PEER_STATS_WRITE_ENABLED = false;
            if (!PEER_STATS_WRITE_ENABLED) {
              return json({ ok: true, counted: 0, disabled: true }, 200, cors);
            }
            // Batched peer-stat votes from the client's IDB outbox (≤50).
            // Blind increment transforms in ONE commit: no reads, atomic per
            // doc, contention-proof (the old client read-modify-write lost
            // votes under concurrency AND cost 1r+1w per answer). Billed =
            // 1 write per voted question, amortized over the whole batch.
            // Uniqueness is enforced client-side (session + outbox + users-map
            // precheck); the server only bounds volume + shape. Server never
            // grows the users map (unbounded array/map growth would hit the
            // 1MB doc cap); threshold/display math uses `total` instead.
            const votes = (body as any).votes;
            if (!Array.isArray(votes) || votes.length === 0) return json({ ok: true, counted: 0 }, 200, cors);
            if (votes.length > 50) return json({ error: "Too many votes (max 50)" }, 400, cors);
            const batchLimit = rateLimit(`qbank-peer-batch:${uid}`, 60_000, 10);
            if (!batchLimit.ok) return rateLimitResponse(batchLimit.retryAfter, cors);
            const clean: Array<{ qid: string; idx: number }> = [];
            const seen = new Set<string>();
            for (const v of votes) {
              const qid = String((v as any)?.questionId || "");
              const idx = Number((v as any)?.selectedIndex);
              if (!/^[a-zA-Z0-9_-]{1,64}$/.test(qid)) continue;
              if (!Number.isInteger(idx) || idx < 0 || idx > 9) continue;
              if (seen.has(qid)) continue; // first vote per question wins
              seen.add(qid);
              clean.push({ qid, idx });
            }
            if (clean.length === 0) return json({ ok: true, counted: 0 }, 200, cors);
            const writes: any[] = clean.map(({ qid, idx }) => ({
              transform: {
                document: `projects/${sa.project_id}/databases/(default)/documents/questionStats/${qid}`,
                fieldTransforms: [
                  { fieldPath: `userCounts.${idx}`, increment: { integerValue: "1" } },
                  { fieldPath: "total", increment: { integerValue: "1" } },
                  { fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" },
                ],
              },
            }));
            const commitUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents:commit`;
            const commitRes = await fetch(commitUrl, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ writes }),
            });
            if (!commitRes.ok) {
              console.error("[batch_log_peer_votes] commit failed", commitRes.status, await commitRes.text().catch(() => ""));
              return json({ error: "Failed to log votes" }, 500, cors);
            }
            return json({ ok: true, counted: clean.length }, 200, cors);
          }

          return json({ error: "Invalid POST action" }, 400, cors);
        } catch (e) {
          console.error("[qbank POST]", (e as Error).message);
          return json({ error: "Server Error" }, 500, cors);
        }
        });
      },
    },
  },
});
