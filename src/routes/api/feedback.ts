// In-app feedback popup backend — star rating (1-5) + optional comment.
// One time forever per account: enforced server-side via
// users/{uid}/meta/feedback_status (set on show, submit AND dismiss).
// NOTE: must be 4 path segments (a valid document). A 3-segment path like
// users/{uid}/feedback_status is a COLLECTION: GET returns a listing
// (truthy!) instead of a document, and DELETE/writes 400.
// Eligibility: users_index.qbankAnswerCount >= 5 (server-checked).
// Global kill switch: admin/feedback_settings.enabled (admin panel Feedback tab).

import { createFileRoute } from "@tanstack/react-router";
import { getServiceAccount, getGoogleAccessToken, verifyFirebaseIdToken, dbStats } from "@/lib/firebase.server";
import { getCorsHeaders } from "@/lib/cors";
import { getClientIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit.server";

const MIN_ANSWERS = 5;
const MAX_COMMENT = 1000;

function json(body: unknown, status: number, cors: Record<string, string>) {
  const store = dbStats.getStore();
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-firestore-reads": store ? String(store.reads) : "0",
      "x-firestore-writes": store ? String(store.writes) : "0",
      ...cors,
    },
  });
}

// Kill switch + push blast, 60s shared cache (0 reads when warm).
let settingsCache: { enabled: boolean; pushActive: boolean; exp: number } | null = null;
async function feedbackSettings(): Promise<{ enabled: boolean; pushActive: boolean }> {
  const now = Date.now();
  if (settingsCache && settingsCache.exp > now) {
    return { enabled: settingsCache.enabled, pushActive: settingsCache.pushActive };
  }
  const fallback = {
    enabled: settingsCache?.enabled ?? true,
    pushActive: settingsCache?.pushActive ?? false,
  };
  try {
    const sa = getServiceAccount();
    const token = await getGoogleAccessToken();
    const r = await fetch(
      `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/admin/feedback_settings`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (r.status === 404) {
      settingsCache = { enabled: true, pushActive: false, exp: now + 60_000 };
      return { enabled: true, pushActive: false };
    }
    if (!r.ok) return fallback; // fail-open to last known
    const doc = await r.json();
    const enabled = doc.fields?.enabled?.booleanValue !== false;
    const pushActive = doc.fields?.pushActive?.booleanValue === true;
    settingsCache = { enabled, pushActive, exp: now + 60_000 };
    return { enabled, pushActive };
  } catch {
    return fallback;
  }
}
export function invalidateFeedbackSettingsCache(): void {
  settingsCache = null;
}

async function fsGetDoc(path: string): Promise<any | null> {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const r = await fetch(
    `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`fsGet failed: ${r.status}`);
  return r.json();
}

export const Route = createFileRoute("/api/feedback")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "POST, OPTIONS" });
        return new Response(null, { status: 204, headers: cors });
      },
      POST: async ({ request }) => {
        return dbStats.run({ reads: 0, writes: 0 }, async () => {
          const cors = getCorsHeaders(request, { methods: "POST, OPTIONS" });
          try {
            const auth = request.headers.get("authorization") || "";
            const m = auth.match(/^Bearer\s+(.+)$/i);
            if (!m) return json({ error: "Unauthorized" }, 401, cors);
            const user = await verifyFirebaseIdToken(m[1]);
            const uid = String((user as any).sub || (user as any).user_id || "");
            if (!uid || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return json({ error: "Unauthorized" }, 401, cors);

            const ipRl = rateLimit(`feedback:ip:${getClientIp(request)}`, 60_000, 60);
            if (!ipRl.ok) return rateLimitResponse(ipRl.retryAfter, cors);
            const uidRl = rateLimit(`feedback:uid:${uid}`, 60_000, 30);
            if (!uidRl.ok) return rateLimitResponse(uidRl.retryAfter, cors);

            let body: any = {};
            try { body = await request.json(); } catch { /* body optional for status */ }
            const action = String(body.action || "status");

            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();
            const base = `projects/${sa.project_id}/databases/(default)/documents`;
            const commitUrl = `https://firestore.googleapis.com/v1/${base}:commit`;
            const statusPath = `users/${uid}/meta/feedback_status`;

            if (action === "status") {
              const settings = await feedbackSettings();
              const statusDoc = await fsGetDoc(statusPath).catch(() => null);
              if (statusDoc) {
                const sf = statusDoc.fields || {};
                return json({
                  done: true, enabled: settings.enabled, eligible: false, answers: 0, viaPush: false,
                  state: sf.state?.stringValue || "unknown",
                  at: sf.at?.timestampValue || null,
                }, 200, cors);
              }
              const indexDoc = await fsGetDoc(`users_index/${uid}`).catch(() => null);
              const f = indexDoc?.fields || {};
              const answers = Number(f.qbankAnswerCount?.integerValue ?? f.qbankAnswerCount?.doubleValue ?? 0);
              // Push-only: the popup NEVER shows automatically. It shows once
              // per account only while an admin push is active, and only to
              // users with 5+ answered questions. The done-flag above keeps
              // the once-forever guarantee.
              const eligible = settings.pushActive && answers >= MIN_ANSWERS;
              return json({ done: false, enabled: settings.enabled, eligible, answers, viaPush: eligible }, 200, cors);
            }

            if (action === "shown") {
              // Recorded the instant the popup is DISPLAYED (not on close),
              // so a reload/instant-dismiss can't cause a second showing.
              // Never overwrites an existing state.
              const existing = await fsGetDoc(statusPath).catch(() => null);
              if (!existing) {
                await fetch(`${commitUrl}`, {
                  method: "POST",
                  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    writes: [{
                      update: {
                        name: `${base}/${statusPath}`,
                        fields: {
                          state: { stringValue: "shown" },
                          at: { timestampValue: new Date().toISOString() },
                        },
                      },
                      updateMask: { fieldPaths: ["state", "at"] },
                    }],
                  }),
                });
              }
              return json({ ok: true, done: true }, 200, cors);
            }

            if (action === "dismiss") {
              // Dismissing counts as the one lifetime showing — never ask again.
              // Never overwrites a submitted response.
              const existing = await fsGetDoc(statusPath).catch(() => null);
              if (existing?.fields?.state?.stringValue === "submitted") {
                return json({ ok: true, done: true }, 200, cors);
              }
              await fetch(`${commitUrl}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  writes: [{
                    update: {
                      name: `${base}/${statusPath}`,
                      fields: {
                        state: { stringValue: "dismissed" },
                        at: { timestampValue: new Date().toISOString() },
                      },
                    },
                    updateMask: { fieldPaths: ["state", "at"] },
                  }],
                }),
              });
              return json({ ok: true, done: true }, 200, cors);
            }

            if (action === "submit") {
              const settings = await feedbackSettings();
              if (!settings.enabled) return json({ error: "Feedback is currently disabled.", reason: "feedback_disabled" }, 403, cors);
              const stars = Number(body.stars);
              if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
                return json({ error: "Pick a star rating from 1 to 5." }, 400, cors);
              }
              const comment = String(body.comment || "").trim().slice(0, MAX_COMMENT);
              let existing: any = null;
              try {
                existing = await fsGetDoc(statusPath).catch(() => null);
              } catch {
                return json({ error: "Could not check previous feedback. Please try again." }, 500, cors);
              }
              if (existing?.fields?.state?.stringValue === "submitted") {
                return json({ error: "Feedback already submitted.", reason: "already_submitted" }, 409, cors);
              }
              let answers = 0;
              try {
                const indexDoc = await fsGetDoc(`users_index/${uid}`).catch(() => null);
                const f = indexDoc?.fields || {};
                answers = Number(f.qbankAnswerCount?.integerValue ?? f.qbankAnswerCount?.doubleValue ?? 0);
              } catch {
                return json({ error: "Could not verify eligibility. Please try again." }, 500, cors);
              }
              if (answers < MIN_ANSWERS) return json({ error: "Not eligible yet.", reason: "not_eligible" }, 403, cors);

              const now = new Date().toISOString();
              const fid = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
              let commitRes: Response;
              try {
                commitRes = await fetch(`${commitUrl}`, {
                  method: "POST",
                  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    writes: [
                      {
                        update: {
                          name: `${base}/users/${uid}/feedback/${fid}`,
                          fields: {
                            uid: { stringValue: uid },
                            email: { stringValue: String((user as any).email || "") },
                            stars: { integerValue: String(stars) },
                            comment: { stringValue: comment },
                            answers: { integerValue: String(answers) },
                            createdAt: { integerValue: String(Date.now()) },
                            createdAtIso: { stringValue: now },
                          },
                        },
                        updateMask: { fieldPaths: ["uid", "email", "stars", "comment", "answers", "createdAt", "createdAtIso"] },
                      },
                      {
                        update: {
                          name: `${base}/${statusPath}`,
                          fields: {
                            state: { stringValue: "submitted" },
                            at: { timestampValue: now },
                          },
                        },
                        updateMask: { fieldPaths: ["state", "at"] },
                      },
                    ],
                  }),
                });
              } catch (e) {
                console.error("[feedback] submit commit threw:", (e as Error)?.message || e);
                return json({ error: "Save request failed. Check your connection and try again." }, 500, cors);
              }
              if (!commitRes.ok) {
                let detail = "";
                try { detail = (await commitRes.text()).slice(0, 300); } catch { /* ignore */ }
                console.error("[feedback] submit commit failed:", commitRes.status, detail);
                return json({ error: `Could not save (server ${commitRes.status}). Please try again.` }, 500, cors);
              }
              return json({ ok: true, done: true }, 200, cors);
            }

            return json({ error: "Bad request" }, 400, cors);
          } catch (e) {
            console.error("[feedback]", (e as Error).message);
            return json({ error: "Server error" }, 500, cors);
          }
        });
      },
    },
  },
});
