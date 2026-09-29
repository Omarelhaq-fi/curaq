// Shared in-memory question-code index (module singleton).
// Maps normalized codes + Firestore doc ids -> bank/question locations.
// Built lazily from Firestore, refreshed on TTL, and SURGICALLY updated by
// admin operations (edit/import/delete/regenerate) so results are always fresh
// without rescanning everything.
import { getServiceAccount } from "./firebase.server";

export type QIdxEntry = { qbankId: string; questionId: string; code: string };

let byId: Map<string, QIdxEntry[]> | null = null;      // key: firestore doc id
let byCode: Map<string, QIdxEntry[]> | null = null;    // key: normalized code
let builtAt = 0;
let building: Promise<void> | null = null;
const TTL = 10 * 60_000;

/** Canonical form of any code/id typed or stored: uppercase, no separators,
 *  strips an optional leading "Q-" / "Q_" system prefix, keeps [A-Z0-9]. */
export function normRef(raw: string): string {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/^Q[-_]/, "")
    .replace(/[^A-Z0-9]/g, "");
}

function push(e: QIdxEntry) {
  if (!byId || !byCode) return;
  const a = byId.get(e.questionId);
  if (a) a.push(e); else byId.set(e.questionId, [e]);
  const nk = normRef(e.code);
  if (nk && nk.length >= 3) {
    const b = byCode.get(nk);
    if (b) b.push(e); else byCode.set(nk, [e]);
  }
}

async function fetchToken(): Promise<string> {
  const { getGoogleAccessToken } = await import("./firebase.server");
  return getGoogleAccessToken();
}

export async function ensureQIndex(force = false): Promise<void> {
  if (!force && byId && Date.now() - builtAt < TTL) return;
  if (building) return building;
  building = (async () => {
    console.log("[qindex] building…");
    const t0 = Date.now();
    byId = new Map();
    byCode = new Map();
    const sa = getServiceAccount();
    const token = await fetchToken();

    // bank ids
    const bankIds: string[] = [];
    let pt = "";
    while (true) {
      const bp = new URLSearchParams({ pageSize: "300", "mask.fieldPaths": "name" });
      if (pt) bp.set("pageToken", pt);
      const r = await fetch(
        `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks?${bp}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!r.ok || r.status === 404) break;
      const d = await r.json();
      for (const doc of d.documents || []) bankIds.push(doc.name.split("/").pop());
      pt = d.nextPageToken || "";
      if (!pt) break;
    }

    for (const bid of bankIds) {
      let cpt = "";
      while (true) {
        const params = new URLSearchParams({ pageSize: "300", "mask.fieldPaths": "data" });
        if (cpt) params.set("pageToken", cpt);
        let d: any = null;
        for (let attempt = 0; attempt < 2 && !d; attempt++) {
          try {
            const r = await fetch(
              `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${bid}/questions?${params}`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            if (r.ok) d = await r.json();
            else if (r.status === 404) break;
          } catch {}
        }
        if (d) {
          for (const doc of d.documents || []) {
            let code = "";
            try { code = String(JSON.parse(doc.fields?.data?.stringValue || "{}").code || ""); } catch {}
            push({ qbankId: bid, questionId: doc.name.split("/").pop() || "", code });
          }
          cpt = d.nextPageToken || "";
        } else cpt = "";
        if (!cpt) break;
      }
    }

    builtAt = Date.now();
    console.log(`[qindex] built ${byId.size} questions in ${Date.now() - t0}ms`);
  })();
  try {
    await building;
  } finally {
    building = null;
  }
}

/** Candidates for a user-typed reference: exact code, exact doc id, then doc-id prefix. */
export function qindexLookup(refRaw: string): QIdxEntry[] {
  if (!byId || !byCode) return [];
  const n = normRef(refRaw);
  if (!n || n.length < 3) return [];

  let out: QIdxEntry[] = [];
  const seen = new Set<string>();

  const addAll = (entries: QIdxEntry[] | undefined) => {
    for (const e of entries || []) {
      const k = `${e.qbankId}/${e.questionId}`;
      if (!seen.has(k)) { seen.add(k); out.push(e); }
    }
  };

  addAll(byCode.get(n));                 // human code (normalized)
  addAll(byId.get(refRaw.trim()));       // exact doc id as typed
  if (out.length === 0) {
    for (const [id, entries] of byId) {  // doc-id prefix
      if (id.toLowerCase().startsWith(n.toLowerCase())) addAll(entries);
      if (out.length > 20) break;
    }
  }
  return out;
}

/** Surgical update after create/edit — keeps the index fresh without rebuilds. */
export function qindexUpsert(qbankId: string, questionId: string, rawCode: string): void {
  if (!byId || !byCode) return; // not built yet; next build will include it
  // drop existing entries for this question
  const old = byId.get(questionId);
  if (old) {
    for (const e of old) {
      const nk = normRef(e.code);
      const arr = byCode.get(nk);
      if (arr) {
        const i = arr.findIndex(x => x.questionId === questionId && x.qbankId === qbankId);
        if (i >= 0) arr.splice(i, 1);
        if (!arr.length) byCode.delete(nk);
      }
    }
  }
  byId.delete(questionId);
  push({ qbankId, questionId, code: String(rawCode || "") });
}

/** Surgical removal after deletes. */
export function qindexRemove(qbankId: string, questionId: string): void {
  if (!byId || !byCode) return;
  const old = byId.get(questionId);
  if (old) {
    for (const e of old) {
      const nk = normRef(e.code);
      const arr = byCode.get(nk);
      if (arr) {
        const i = arr.findIndex(x => x.questionId === questionId && x.qbankId === qbankId);
        if (i >= 0) arr.splice(i, 1);
        if (!arr.length) byCode.delete(nk);
      }
    }
  }
  byId.delete(questionId);
}

export function qIndexIsReady(): boolean {
  return !!byId;
}
