// R2-backed answer slices for stems-only clients.
//
// Why this exists: the first version of get_answers did one Firestore doc
// read per requested id (50 reads per batch). A full-bank session fanned out
// to thousands of billed reads — defeating the whole R2 cost optimization.
// The answers already live in the bank's private R2 chunks (0 reads to
// fetch), so answer slices are served from R2 with a small in-memory map.
//
// Cost now: hot path = 0 Firestore reads (memory map hit) or 0 reads + 1 R2
// GET on map build. Firestore single-doc reads remain ONLY as a fallback for
// ids missing from R2 (legacy Firestore-chunks banks, brand-new questions).
// Bulk scrape is still throttled by the per-uid rate limit on get_answers.

import { gunzipSync } from "node:zlib";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { extractAnswer } from "@/lib/qbank-drm.server";

type AnswerMap = Map<string, Record<string, unknown>>;

interface Entry {
  map: AnswerMap;
  exp: number;
}

const TTL_MS = 5 * 60_000;
const MAX_BANKS = 3;

const cache = new Map<string, Entry>();

function getCached(qbankId: string): AnswerMap | null {
  const e = cache.get(qbankId);
  if (!e) return null;
  if (Date.now() > e.exp) {
    cache.delete(qbankId);
    return null;
  }
  // LRU touch.
  cache.delete(qbankId);
  cache.set(qbankId, e);
  return e.map;
}

function setCached(qbankId: string, map: AnswerMap): void {
  if (cache.size >= MAX_BANKS) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest) cache.delete(oldest);
  }
  cache.set(qbankId, { map, exp: Date.now() + TTL_MS });
}

function s3Client(): S3Client | null {
  if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    return null;
  }
  return new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT!,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

async function loadR2Questions(qbankId: string): Promise<any[] | null> {
  const s3 = s3Client();
  if (!s3) return null;
  try {
    const objRes = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME || "curaq",
        Key: `qbanks/${qbankId}/chunks.json.gz`,
      }),
    );
    const bytes = await objRes.Body?.transformToByteArray();
    if (!bytes) return null;
    const rawJson = gunzipSync(bytes).toString("utf-8");
    const parsed = JSON.parse(rawJson);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    console.warn("[qbank-answers] R2 load failed for", qbankId, (e as Error).message);
    return null;
  }
}

async function buildMapFromR2(qbankId: string): Promise<AnswerMap | null> {
  const parsed = await loadR2Questions(qbankId);
  if (!parsed) return null;
  const map: AnswerMap = new Map();
  for (const q of parsed) {
    const id = q && typeof q.id === "string" ? q.id : null;
    if (!id) continue;
    const data = (q as any).data;
    if (data && typeof data === "object") map.set(id, extractAnswer(data));
  }
  return map;
}

async function fetchAnswerFromFirestore(
  sa: { project_id: string },
  token: string,
  qbankId: string,
  qid: string,
): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(
      `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}/questions/${qid}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!r.ok) return null;
    const doc = await r.json();
    let parsed: any = {};
    try {
      parsed = JSON.parse(doc.fields?.data?.stringValue || "{}");
    } catch {}
    return extractAnswer(parsed);
  } catch {
    return null;
  }
}

/**
 * Resolve answer slices for ids. Hot path (map cached or R2-built) costs 0
 * Firestore reads. Returns the answers plus whether any Firestore fallback
 * reads were needed (for x-firestore-reads transparency — dbStats counts the
 * actual fetches automatically).
 */
export async function getBulkAnswers(
  sa: { project_id: string },
  token: string,
  qbankId: string,
  ids: string[],
  storageProvider?: string,
): Promise<Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, unknown>> = {};
  if (ids.length === 0) return out;

  let map = getCached(qbankId);
  if (!map && storageProvider !== undefined && storageProvider !== "r2" && storageProvider !== "") {
    // Unknown provider spelling — still try R2 below; fall back after.
    map = null;
  }
  if (!map) {
    const built = await buildMapFromR2(qbankId);
    if (built) {
      setCached(qbankId, built);
      map = built;
    }
  }

  const missing: string[] = [];
  if (map) {
    for (const id of ids) {
      const a = map.get(id);
      if (a) out[id] = a;
      else missing.push(id);
    }
    if (missing.length === 0) return out;
  } else {
    missing.push(...ids);
  }

  // Fallback: legacy banks (Firestore chunks, no R2 object) or ids absent
  // from the R2 snapshot. One billed read per id — the only Firestore cost.
  await Promise.all(
    missing.map(async (qid) => {
      const a = await fetchAnswerFromFirestore(sa, token, qbankId, qid);
      if (a) {
        out[qid] = a;
        // Memoize so repeat views of the same question cost 0 reads for TTL.
        const m = getCached(qbankId) || new Map<string, Record<string, unknown>>();
        m.set(qid, a);
        setCached(qbankId, m);
      }
    }),
  );
  return out;
}

/** Drop a bank's answer map (call after admin publish). Best-effort. */
export function invalidateAnswerMap(qbankId: string): void {
  cache.delete(qbankId);
  conceptCache.delete(qbankId);
}

// ---------------------------------------------------------------------------
// Study-concept map: same R2 snapshot, second index. Concepts are generated
// once per (question, lang) and shared by all future students, so serving
// them from R2 (0 reads hot) beats re-reading the question doc every time.
// ---------------------------------------------------------------------------

export interface ConceptSlice {
  langs: Record<string, string>;
  legacyText: string | null;
  legacyLang: string | null;
}

const conceptCache = new Map<string, { map: Map<string, ConceptSlice>; exp: number }>();

function conceptSliceFromChunk(q: any): ConceptSlice | null {
  if (!q || typeof q !== "object") return null;
  const langs: Record<string, string> = {};
  const rawLangs = (q as any).studyConcepts;
  if (rawLangs && typeof rawLangs === "object" && !Array.isArray(rawLangs)) {
    for (const [k, v] of Object.entries(rawLangs)) {
      if (typeof v === "string" && v) langs[k] = v;
      else if (v && typeof v === "object" && typeof (v as any).text === "string" && (v as any).text) {
        langs[k] = (v as any).text;
      }
    }
  }
  const legacyText = typeof (q as any).studyConcept === "string" ? (q as any).studyConcept : null;
  const legacyLang = typeof (q as any).studyConceptLang === "string" ? (q as any).studyConceptLang : null;
  if (Object.keys(langs).length === 0 && !legacyText) return null;
  return { langs, legacyText, legacyLang };
}

function getConceptMapCached(qbankId: string): Map<string, ConceptSlice> | null {
  const e = conceptCache.get(qbankId);
  if (!e) return null;
  if (Date.now() > e.exp) {
    conceptCache.delete(qbankId);
    return null;
  }
  conceptCache.delete(qbankId);
  conceptCache.set(qbankId, e);
  return e.map;
}

function setConceptMapCached(qbankId: string, map: Map<string, ConceptSlice>): void {
  if (conceptCache.size >= MAX_BANKS) {
    const oldest = conceptCache.keys().next().value as string | undefined;
    if (oldest) conceptCache.delete(oldest);
  }
  conceptCache.set(qbankId, { map, exp: Date.now() + TTL_MS });
}

/**
 * Concept for one question in the requested lang, served from the R2
 * snapshot (0 Firestore reads). Returns null when the snapshot has nothing
 * (caller falls back to the Firestore doc read). Legacy single-field
 * concepts are returned with their stored lang tag.
 */
export async function getConceptForQuestion(
  qbankId: string,
  questionId: string,
  lang: string,
): Promise<{ studyConcept: string; studyConceptLang: string | null } | null> {
  let map = getConceptMapCached(qbankId);
  if (!map) {
    const raw = await loadR2Questions(qbankId);
    if (!raw) return null;
    const cmap = new Map<string, ConceptSlice>();
    for (const q of raw) {
      const id = q && typeof q.id === "string" ? q.id : null;
      if (!id) continue;
      const slice = conceptSliceFromChunk(q);
      if (slice) cmap.set(id, slice);
    }
    setConceptMapCached(qbankId, cmap);
    map = cmap;
  }
  const slice = map.get(questionId);
  if (!slice) return null;
  if (lang && slice.langs[lang]) return { studyConcept: slice.langs[lang], studyConceptLang: lang };
  if (slice.legacyText) return { studyConcept: slice.legacyText, studyConceptLang: slice.legacyLang };
  const firstLang = Object.keys(slice.langs)[0];
  if (firstLang) return { studyConcept: slice.langs[firstLang], studyConceptLang: firstLang };
  return null;
}
