// Admin-only notification sender + per-user fan-out.
// All privileged writes go through this route so the browser SDK never
// touches the top-level /notifications collection.

import { createFileRoute } from "@tanstack/react-router";
import {
  verifyFirebaseIdToken,
  getServiceAccount,
  getGoogleAccessToken,
} from "@/lib/firebase.server";
import { isAdminEmail } from "@/lib/admin.server";
import { getCorsHeaders } from "@/lib/cors";
import { getClientIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit.server";

type FSValue = {
  stringValue?: string;
  integerValue?: string;
  timestampValue?: string;
  nullValue?: null;
  booleanValue?: boolean;
  arrayValue?: { values?: FSValue[] };
  mapValue?: { fields?: Record<string, FSValue> };
};

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

function toFSValue(v: unknown): FSValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return { integerValue: String(Math.floor(v)) };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFSValue) } };
  if (typeof v === "object") {
    const fields: Record<string, FSValue> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      fields[k] = toFSValue(val);
    }
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

function toFields(obj: Record<string, unknown>): Record<string, FSValue> {
  const out: Record<string, FSValue> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = toFSValue(v);
  return out;
}

async function requireAdmin(request: Request) {
  const auth = request.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Response("Unauthorized", { status: 401 });
  const user = await verifyFirebaseIdToken(m[1]);
  if (user.email_verified === false) throw new Response("Forbidden", { status: 403 });
  if (!(await isAdminEmail(user.email))) throw new Response("Forbidden", { status: 403 });
  return user;
}

// Batched Firestore commit — up to 500 writes/call.
async function fsCommit(writes: Array<{ update: { name: string; fields: Record<string, FSValue> } }>) {
  if (writes.length === 0) return;
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents:commit`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ writes }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`commit failed ${resp.status}: ${t.slice(0, 200)}`);
  }
}

async function fsDelete(path: string) {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}`;
  const r = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok && r.status !== 404) throw new Error(`delete failed ${r.status}`);
}

async function fsListUsersIndex(): Promise<Array<{ uid: string; plan: string; proUntil: string | null }>> {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const users: Array<{ uid: string; plan: string; proUntil: string | null }> = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(
      `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users_index`,
    );
    url.searchParams.set("pageSize", "500");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`list users failed ${r.status}`);
    const j = (await r.json()) as {
      documents?: Array<{ name: string; fields?: Record<string, FSValue> }>;
      nextPageToken?: string;
    };
    for (const d of j.documents || []) {
      const uid = d.name.split("/").pop() || "";
      const f = d.fields || {};
      users.push({
        uid,
        plan: f.plan?.stringValue || "free",
        proUntil: f.proUntil?.timestampValue || null,
      });
    }
    pageToken = j.nextPageToken;
  } while (pageToken);
  return users;
}

async function fsListNotifications(limit = 50) {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: "notifications" }],
      orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
      limit,
    },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`list notif failed ${r.status}`);
  const rows = (await r.json()) as Array<{ document?: { name: string; fields?: Record<string, FSValue> } }>;
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (!row.document) continue;
    const id = row.document.name.split("/").pop() || "";
    const f = row.document.fields || {};
    const linkF = f.link?.mapValue?.fields;
    out.push({
      id,
      title: f.title?.stringValue || "",
      body: f.body?.stringValue || "",
      type: f.type?.stringValue || "info",
      link: linkF
        ? { kind: linkF.kind?.stringValue || "url", value: linkF.value?.stringValue || "" }
        : null,
      audienceMode: f.audienceMode?.stringValue || "all",
      audienceSummary: f.audienceSummary?.stringValue || "",
      recipientCount: Number(f.recipientCount?.integerValue || 0),
      createdAt: f.createdAt?.timestampValue || null,
      createdByEmail: f.createdByEmail?.stringValue || "",
    });
  }
  return out;
}

const ALLOWED_TABS = new Set(["study-plan", "summary", "ai-tutor", "review", "qbank"]);
const ALLOWED_TYPES = new Set(["info", "success", "warning", "promo"]);

function sanitizeText(s: unknown, max: number) {
  return String(s || "")
    // strip control chars
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, max)
    .trim();
}

function validLink(link: unknown): null | { kind: "url" | "tab"; value: string } {
  if (!link || typeof link !== "object") return null;
  const l = link as { kind?: unknown; value?: unknown };
  if (l.kind === "url") {
    const v = String(l.value || "").trim();
    if (!/^https?:\/\//i.test(v) || v.length > 500) return null;
    return { kind: "url", value: v };
  }
  if (l.kind === "tab") {
    const v = String(l.value || "").trim();
    if (!ALLOWED_TABS.has(v)) return null;
    return { kind: "tab", value: v };
  }
  return null;
}

type SendBody = {
  action: "send";
  title: string;
  body: string;
  type: string;
  link: unknown;
  audience:
    | { mode: "all" }
    | { mode: "plan"; plans: string[] }
    | { mode: "users"; userIds: string[] };
};

async function handleSend(body: SendBody, actor: { sub: string; email?: string }) {
  const title = sanitizeText(body.title, 120);
  const message = sanitizeText(body.body, 600);
  if (!title || !message) throw new Error("Title and message are required");
  const type = ALLOWED_TYPES.has(body.type) ? body.type : "info";
  const link = validLink(body.link);

  let targetUids: string[] = [];
  let audienceSummary = "";
  const now = Date.now();

  const aud = body.audience;
  if (!aud || typeof aud !== "object") throw new Error("Invalid audience");

  if (aud.mode === "all") {
    const users = await fsListUsersIndex();
    targetUids = users.map((u) => u.uid);
    audienceSummary = `Everyone (${targetUids.length})`;
  } else if (aud.mode === "plan") {
    const wantPlans = new Set((aud.plans || []).filter((p) => p === "free" || p === "pro" || p === "aplus"));
    if (wantPlans.size === 0) throw new Error("Pick at least one plan");
    const users = await fsListUsersIndex();
    targetUids = users
      .filter((u) => {
        const notExpired = !u.proUntil || Date.parse(u.proUntil) > now;
        const effPlan = (u.plan === "pro" || u.plan === "aplus") && notExpired ? u.plan : "free";
        return wantPlans.has(effPlan);
      })
      .map((u) => u.uid);
    audienceSummary = `Plans: ${[...wantPlans].join(", ")} (${targetUids.length})`;
  } else if (aud.mode === "users") {
    targetUids = (aud.userIds || [])
      .filter((u) => typeof u === "string" && u.length > 0 && u.length < 128)
      .slice(0, 5000);
    if (targetUids.length === 0) throw new Error("No users selected");
    audienceSummary = `Selected users (${targetUids.length})`;
  } else {
    throw new Error("Invalid audience");
  }

  targetUids = [...new Set(targetUids)];
  if (targetUids.length === 0) throw new Error("No recipients matched");

  const sa = getServiceAccount();
  const nid = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const createdAt = new Date();
  const basePath = `projects/${sa.project_id}/databases/(default)/documents`;

  const topFields = toFields({
    title,
    body: message,
    type,
    link,
    createdAt,
    createdBy: actor.sub,
    createdByEmail: actor.email || "",
    audienceMode: aud.mode,
    audienceSummary,
    recipientCount: targetUids.length,
  });

  // Write the top-level doc first so history is durable even if fan-out fails.
  await fsCommit([{ update: { name: `${basePath}/notifications/${nid}`, fields: topFields } }]);

  const perUserFields = toFields({
    notificationId: nid,
    title,
    body: message,
    type,
    link,
    createdAt,
    read: false,
    readAt: null,
  });

  const CHUNK = 400;
  let sent = 0;
  for (let i = 0; i < targetUids.length; i += CHUNK) {
    const chunk = targetUids.slice(i, i + CHUNK);
    const writes = chunk.map((uid) => ({
      update: { name: `${basePath}/users/${uid}/notifications/${nid}`, fields: perUserFields },
    }));
    await fsCommit(writes);
    sent += chunk.length;
  }

  return { ok: true, id: nid, recipientCount: sent };
}

export const Route = createFileRoute("/api/notifications")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, POST, OPTIONS" });
        return new Response(null, { status: 204, headers: cors });
      },

      GET: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, POST, OPTIONS" });
        const ip = getClientIp(request);
        const rl = rateLimit(`notif:ip:${ip}`, 60_000, 60);
        if (!rl.ok) return rateLimitResponse(rl.retryAfter, cors);

        try {
          await requireAdmin(request);
        } catch (e) {
          if (e instanceof Response) {
            return json({ error: e.status === 403 ? "Forbidden" : "Unauthorized" }, e.status, cors);
          }
          return json({ error: "Unauthorized" }, 401, cors);
        }

        const url = new URL(request.url);
        const action = url.searchParams.get("action");
        try {
          if (action === "list_sent") {
            return json({ notifications: await fsListNotifications(50) }, 200, cors);
          }
          return json({ error: "Bad request" }, 400, cors);
        } catch (e) {
          console.error("[notifications]", (e as Error).message);
          return json({ error: "Server error" }, 500, cors);
        }
      },

      POST: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, POST, OPTIONS" });
        const ip = getClientIp(request);
        const rl = rateLimit(`notif:send:ip:${ip}`, 3600_000, 40);
        if (!rl.ok) return rateLimitResponse(rl.retryAfter, cors);

        let actor;
        try {
          actor = await requireAdmin(request);
        } catch (e) {
          if (e instanceof Response) {
            return json({ error: e.status === 403 ? "Forbidden" : "Unauthorized" }, e.status, cors);
          }
          return json({ error: "Unauthorized" }, 401, cors);
        }

        let body: { action?: string; id?: string } & Partial<SendBody>;
        try {
          body = await request.json();
        } catch {
          return json({ error: "Bad request" }, 400, cors);
        }

        try {
          if (body.action === "send") {
            const res = await handleSend(body as SendBody, actor);
            return json(res, 200, cors);
          }
          if (body.action === "delete") {
            const id = String(body.id || "");
            if (!id || id.length > 100) return json({ error: "Bad id" }, 400, cors);
            await fsDelete(`notifications/${id}`);
            return json({ ok: true }, 200, cors);
          }
          return json({ error: "Bad request" }, 400, cors);
        } catch (e) {
          const msg = (e as Error).message || "Server error";
          console.error("[notifications]", msg);
          return json({ error: msg }, 400, cors);
        }
      },
    },
  },
});
