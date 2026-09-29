// Per-bank DRM keys + answer-split helpers.
//
// Security model (replaces the old single hardcoded DRM_KEY_STR):
// - One AES-GCM key per bank (or per country fallback: key_TN / key_EG /
//   key_DZ). Keys live ONLY in env/KV, never in JS.
// - Client fetches its bank key via POST /api/qbank_key { qbankId } — same
//   auth + access check as the static payload, strictly rate-limited and
//   logged (uid, bank, ip, time). Key lives in client memory only.
// - Static payloads stay single-file AES-GCM, but encrypted with the
//   per-bank key: an Egypt user who downloads the Tunisia file still cannot
//   decrypt it without an authorized key call (which 403s).
// - Rotation: change the env value monthly. Because encryption happens
//   on-serve (R2 holds plaintext gzip), rotation is instant — no offline
//   re-encryption of stored files is needed.
//
// Answer split (scrape mitigation):
// - The static file carries STEMS ONLY (text + options + subject/chapter).
//   correctIndices / explanation / explanationBlocks stay server-side and are
//   fetched on demand via get_answers (tiny per-question reads you can
//   throttle). Bulk answer scrape becomes ~37k throttled requests instead of
//   1 download. This preserves ~95% of the Firestore cost saving (bulk stems
//   still come from private R2, 0 reads hot).

import { createHash } from "node:crypto";

const encoder = new TextEncoder();

function parseJsonMap(envVal: string | undefined): Record<string, string> {
  if (!envVal) return {};
  try {
    const v = JSON.parse(envVal);
    if (v && typeof v === "object") {
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v)) {
        if (typeof val === "string" && val.length >= 16) out[k.toLowerCase()] = val;
      }
      return out;
    }
  } catch {
    /* ignore malformed */
  }
  return {};
}

// AES-GCM raw keys must be exactly 16/24/32 bytes. Env values are ASCII, so
// enforce 16/24/32 chars and fail fast with an ops-readable message instead
// of a cryptic WebCrypto error at request time.
function assertValidKeyLength(key: string, where: string): string {
  if (key.length === 16 || key.length === 24 || key.length === 32) return key;
  throw new Error(
    `${where}: DRM keys must be 16, 24, or 32 chars (got ${key.length}). Generate with: openssl rand -hex 16`,
  );
}

/**
 * Resolve the raw key string for a bank. Order:
 *  1. DRM_BANK_KEYS JSON: { "<bankId>": "<32+ char key>" }
 *  2. DRM_COUNTRY_KEYS JSON: { "tn": "...", "eg": "...", "dz": "...", "ma": "..." }
 *  3. Derived: SHA256hex(DRM_MASTER + ":" + bankIdLower) — monthly rotation
 *     = rotate DRM_MASTER. Legacy DRM_KEY env is accepted as DRM_MASTER for
 *     migration, but the hardcoded fallback string is GONE (throws).
 */
export function getBankKeyString(qbankId: string, bankCountry = ""): string {
  const bankKeys = parseJsonMap(process.env.DRM_BANK_KEYS);
  const hit = bankKeys[String(qbankId || "").toLowerCase()];
  if (hit) return assertValidKeyLength(hit, `DRM_BANK_KEYS[${qbankId}]`);

  const countryKeys = parseJsonMap(process.env.DRM_COUNTRY_KEYS);
  // Also accept KEY_TN / KEY_EG / KEY_DZ style envs for ops convenience.
  for (const c of ["tn", "eg", "dz", "ma", "global"]) {
    const envKey = process.env[`DRM_KEY_${c.toUpperCase()}`];
    if (envKey && envKey.length >= 16) countryKeys[c] = envKey;
  }
  const cHit = bankCountry ? countryKeys[String(bankCountry).toLowerCase()] : undefined;
  if (cHit) return assertValidKeyLength(cHit, `country key [${bankCountry}]`);

  const master = process.env.DRM_MASTER || process.env.DRM_KEY || "";
  if (master && master.length >= 16) {
    // Deterministic 256-bit derivation: sha256 hex sliced to 32 chars =
    // 32 bytes UTF-8 = AES-256. Rotation = change DRM_MASTER monthly.
    return createHash("sha256").update(`${master}:${String(qbankId).toLowerCase()}`).digest("hex").slice(0, 32);
  }
  throw new Error(
    "No DRM key configured for bank. Set DRM_BANK_KEYS, DRM_COUNTRY_KEYS/DRM_KEY_<CC>, or DRM_MASTER.",
  );
}

/** Stable key id for logging / client cache keying (never the key itself). */
export function getBankKeyId(qbankId: string, bankCountry = ""): string {
  const raw = `${String(qbankId).toLowerCase()}:${String(bankCountry).toLowerCase()}:${process.env.DRM_KEY_VERSION || "v1"}`;
  return `kb_${createHash("sha256").update(raw).digest("hex").slice(0, 12)}`;
}

async function importKeyRaw(keyStr: string, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const keyData = encoder.encode(keyStr);
  return crypto.subtle.importKey("raw", keyData, { name: "AES-GCM" }, false, [usage]);
}

export async function encryptForBank(text: string, qbankId: string, bankCountry = ""): Promise<string> {
  const keyStr = getBankKeyString(qbankId, bankCountry);
  const key = await importKeyRaw(keyStr, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = encoder.encode(text);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  let binary = "";
  for (let i = 0; i < combined.byteLength; i++) binary += String.fromCharCode(combined[i]);
  return btoa(binary);
}

// Answer fields that must NEVER ship in the bulk static file.
const ANSWER_KEYS = new Set([
  "correctIndices",
  "correctOptionIndex",
  "correctAnswer",
  "correctAnswers",
  "answer",
  "answerIndices",
  "explanation",
  "explanationBlocks",
  "distractors",
  "distractorExplanations",
  "tip",
]);

/** Extract the answer slice of one question's data blob. */
export function extractAnswer(data: any): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const k of ANSWER_KEYS) {
    if (data[k] !== undefined) out[k] = data[k];
  }
  // Canonical aliases the client understands.
  if (out.correctOptionIndex !== undefined && out.correctIndices === undefined) {
    const n = Number(out.correctOptionIndex);
    if (Number.isFinite(n)) out.correctIndices = [n];
  }
  return out;
}

/** Strip answer fields from one question's data blob (stems-only). */
export function stripAnswer(data: any): any {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!ANSWER_KEYS.has(k)) out[k] = v;
  }
  // Non-sensitive input-type hint: the client needs to know QCM (checkbox)
  // vs QCS (radio) BEFORE answers arrive. A boolean reveals nothing about
  // which options are correct.
  if (out.multi === undefined) {
    const ci = (data as any).correctIndices;
    if (Array.isArray(ci)) out.multi = ci.length > 1;
    else if (typeof (data as any).correctOptionIndex === "number") out.multi = false;
  }
  return out;
}

/** Split a full question list into stems (bulk) + answers (on-demand). */
export function splitQuestionsForStatic(questions: any[]): { stems: any[]; answerCount: number } {
  const stems = questions.map((q: any) => {
    if (!q || typeof q !== "object") return q;
    // Top-level concept payloads stay in R2 (0-read serving via the concept
    // map) but never ship in bulk: 37k concepts would add tens of MB to
    // every download + IDB. Answers are fetched per block instead.
    const { studyConcepts, studyConcept, studyConceptLang, ...rest } = q as Record<string, unknown>;
    if (q.data && typeof q.data === "object" && !Array.isArray(q.data)) {
      return { ...rest, data: stripAnswer(q.data) };
    }
    return rest;
  });
  let answerCount = 0;
  for (const q of questions) {
    if (q?.data && typeof q.data === "object" && extractAnswer(q.data).correctIndices !== undefined) answerCount++;
  }
  return { stems, answerCount };
}
