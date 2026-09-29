// Support tickets — user↔admin chat.
// All writes go through the server so users never touch top-level
// /support_tickets in Firestore directly. Reads are also server-mediated
// so no client rules changes are needed.

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

async function fsPatch(path: string, obj: Record<string, unknown>) {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const mask = Object.keys(obj)
    .map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
    .join("&");
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}?${mask}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: toFields(obj) }),
  });
  if (!r.ok) throw new Error(`patch failed ${r.status}`);
}
async function fsGet(path: string) {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`get failed ${r.status}`);
  return (await r.json()) as { fields?: Record<string, FSValue> };
}
async function fsCreate(path: string, obj: Record<string, unknown>) {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: toFields(obj) }),
  });
  if (!r.ok) throw new Error(`create failed ${r.status}`);
}
async function fsDelete(path: string) {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}`;
  const r = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok && r.status !== 404) throw new Error(`delete failed ${r.status}`);
}
async function fsRunQuery(body: unknown, parentPath?: string) {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const base = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
  const url = parentPath ? `${base}/${parentPath}:runQuery` : `${base}:runQuery`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`query failed ${r.status}`);
  return (await r.json()) as Array<{ document?: { name: string; fields?: Record<string, FSValue> } }>;
}

function sanitize(s: unknown, max: number) {
  return String(s || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max).trim();
}

function parseTicket(name: string, f: Record<string, FSValue> = {}) {
  return {
    id: name.split("/").pop() || "",
    uid: f.uid?.stringValue || "",
    email: f.email?.stringValue || "",
    subject: f.subject?.stringValue || "",
    category: f.category?.stringValue || "other",
    status: f.status?.stringValue || "open",
    createdAt: f.createdAt?.timestampValue || null,
    updatedAt: f.updatedAt?.timestampValue || null,
    lastMessageAt: f.lastMessageAt?.timestampValue || null,
    lastMessageBy: f.lastMessageBy?.stringValue || "",
    lastMessagePreview: f.lastMessagePreview?.stringValue || "",
    userUnread: !!f.userUnread?.booleanValue,
    adminUnread: !!f.adminUnread?.booleanValue,
    messageCount: Number(f.messageCount?.integerValue || 0),
  };
}

async function requireUser(request: Request) {
  const auth = request.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Response("Unauthorized", { status: 401 });
  return await verifyFirebaseIdToken(m[1]);
}

async function listUserTickets(uid: string) {
  const rows = await fsRunQuery({
    structuredQuery: {
      from: [{ collectionId: "support_tickets" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "uid" },
          op: "EQUAL",
          value: { stringValue: uid },
        },
      },
      limit: 100,
    },
  });
  const list = rows.filter((r) => r.document).map((r) => parseTicket(r.document!.name, r.document!.fields));
  list.sort((a, b) => (b.lastMessageAt || "").localeCompare(a.lastMessageAt || ""));
  return list;
}

async function listAllTickets(status?: string) {
  const where = status && status !== "all"
    ? {
        fieldFilter: {
          field: { fieldPath: "status" },
          op: "EQUAL",
          value: { stringValue: status },
        },
      }
    : undefined;
  const rows = await fsRunQuery({
    structuredQuery: {
      from: [{ collectionId: "support_tickets" }],
      ...(where ? { where } : {}),
      limit: 200,
    },
  });
  const list = rows.filter((r) => r.document).map((r) => parseTicket(r.document!.name, r.document!.fields));
  list.sort((a, b) => (b.lastMessageAt || "").localeCompare(a.lastMessageAt || ""));
  return list;
}

async function listMessages(tid: string) {
  const rows = await fsRunQuery(
    {
      structuredQuery: {
        from: [{ collectionId: "messages" }],
        orderBy: [{ field: { fieldPath: "createdAt" }, direction: "ASCENDING" }],
        limit: 200,
      },
    },
    `support_tickets/${tid}`,
  );
  return rows.filter((r) => r.document).map((r) => {
    const f = r.document!.fields || {};
    return {
      id: r.document!.name.split("/").pop() || "",
      from: f.from?.stringValue || "user",
      text: f.text?.stringValue || "",
      authorEmail: f.authorEmail?.stringValue || "",
      createdAt: f.createdAt?.timestampValue || null,
    };
  });
}

async function pushUserNotification(uid: string, title: string, body: string) {
  const sa = getServiceAccount();
  const nid = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  await fsCreate(`users/${uid}/notifications/${nid}`, {
    title,
    body,
    type: "info",
    link: null,
    createdAt: new Date(),
    read: false,
    readAt: null,
    source: "support",
  });
}

async function appendMessage(opts: {
  tid: string;
  from: "user" | "admin";
  text: string;
  authorUid: string;
  authorEmail: string;
}) {
  const now = new Date();
  const mid = `${now.getTime()}_${crypto.randomUUID().slice(0, 8)}`;
  await fsCreate(`support_tickets/${opts.tid}/messages/${mid}`, {
    from: opts.from,
    text: opts.text,
    authorUid: opts.authorUid,
    authorEmail: opts.authorEmail,
    createdAt: now,
  });
  return { mid, now };
}

export const Route = createFileRoute("/api/support")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, POST, OPTIONS" });
        return new Response(null, { status: 204, headers: cors });
      },

      GET: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, POST, OPTIONS" });
        const ip = getClientIp(request);
        const rl = rateLimit(`support:get:${ip}`, 60_000, 120);
        if (!rl.ok) return rateLimitResponse(rl.retryAfter, cors);

        let user;
        try { user = await requireUser(request); }
        catch (e) {
          if (e instanceof Response) return json({ error: "Unauthorized" }, 401, cors);
          return json({ error: "Unauthorized" }, 401, cors);
        }

        const url = new URL(request.url);
        const action = url.searchParams.get("action") || "";
        const isAdmin = await isAdminEmail(user.email);

        try {
          if (action === "list") {
            const tickets = await listUserTickets(user.sub);
            return json({ tickets }, 200, cors);
          }
          if (action === "unread") {
            const tickets = await listUserTickets(user.sub);
            const n = tickets.filter((t) => t.userUnread).length;
            return json({ count: n, totalTickets: tickets.length }, 200, cors);
          }
          if (action === "thread") {
            const id = url.searchParams.get("id") || "";
            if (!id) return json({ error: "Bad id" }, 400, cors);
            const doc = await fsGet(`support_tickets/${id}`);
            if (!doc) return json({ error: "Not found" }, 404, cors);
            const t = parseTicket(id, doc.fields);
            if (t.uid !== user.sub && !isAdmin) return json({ error: "Forbidden" }, 403, cors);
            const messages = await listMessages(id);
            // If user is opening their own ticket, clear their unread flag.
            if (t.uid === user.sub && t.userUnread) {
              await fsPatch(`support_tickets/${id}`, { userUnread: false }).catch(() => {});
            }
            if (isAdmin && t.adminUnread) {
              await fsPatch(`support_tickets/${id}`, { adminUnread: false }).catch(() => {});
            }
            return json({ ticket: t, messages }, 200, cors);
          }

          // Admin-only reads
          if (isAdmin && action === "admin_list") {
            const status = url.searchParams.get("status") || "all";
            const tickets = await listAllTickets(status);
            return json({ tickets }, 200, cors);
          }
          if (isAdmin && action === "admin_unread") {
            const tickets = await listAllTickets("all");
            const n = tickets.filter((t) => t.adminUnread).length;
            const open = tickets.filter((t) => t.status === "open").length;
            return json({ count: n, open }, 200, cors);
          }

          return json({ error: "Bad request" }, 400, cors);
        } catch (e) {
          console.error("[support]", (e as Error).message);
          return json({ error: "Server error" }, 500, cors);
        }
      },

      POST: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, POST, OPTIONS" });
        const ip = getClientIp(request);
        const rl = rateLimit(`support:post:${ip}`, 60_000, 30);
        if (!rl.ok) return rateLimitResponse(rl.retryAfter, cors);

        let user;
        try { user = await requireUser(request); }
        catch { return json({ error: "Unauthorized" }, 401, cors); }
        // Email verification not required for support tickets.

        let body: {
          action?: string;
          id?: string;
          subject?: string;
          category?: string;
          message?: string;
          status?: string;
        };
        try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400, cors); }

        const isAdmin = await isAdminEmail(user.email);

        try {
          if (body.action === "create") {
            // Rate-limit per user
            const rl2 = rateLimit(`support:create:${user.sub}`, 3600_000, 8);
            if (!rl2.ok) return rateLimitResponse(rl2.retryAfter, cors);

            const subject = sanitize(body.subject, 140);
            const message = sanitize(body.message, 4000);
            const category = ["payment", "bug", "account", "feature", "other"].includes(body.category || "")
              ? body.category! : "other";
            if (!subject || !message) return json({ error: "Subject and message required" }, 400, cors);

            const tid = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
            const now = new Date();
            await fsCreate(`support_tickets/${tid}`, {
              uid: user.sub,
              email: user.email || "",
              subject,
              category,
              status: "open",
              createdAt: now,
              updatedAt: now,
              lastMessageAt: now,
              lastMessageBy: "user",
              lastMessagePreview: message.slice(0, 140),
              userUnread: false,
              adminUnread: true,
              messageCount: 1,
            });
            await appendMessage({
              tid, from: "user", text: message,
              authorUid: user.sub, authorEmail: user.email || "",
            });
            return json({ ok: true, id: tid }, 200, cors);
          }

          if (body.action === "reply") {
            const id = String(body.id || "");
            const message = sanitize(body.message, 4000);
            if (!id || !message) return json({ error: "Bad request" }, 400, cors);
            const doc = await fsGet(`support_tickets/${id}`);
            if (!doc) return json({ error: "Not found" }, 404, cors);
            const t = parseTicket(id, doc.fields);
            if (t.uid !== user.sub && !isAdmin) return json({ error: "Forbidden" }, 403, cors);

            const now = new Date();
            const from: "user" | "admin" = isAdmin && t.uid !== user.sub ? "admin" : "user";
            await appendMessage({
              tid: id, from, text: message,
              authorUid: user.sub, authorEmail: user.email || "",
            });
            await fsPatch(`support_tickets/${id}`, {
              updatedAt: now,
              lastMessageAt: now,
              lastMessageBy: from,
              lastMessagePreview: message.slice(0, 140),
              messageCount: (t.messageCount || 0) + 1,
              userUnread: from === "admin",
              adminUnread: from === "user",
              status: t.status === "resolved" && from === "user" ? "open" : t.status,
            });
            if (from === "admin") {
              await pushUserNotification(
                t.uid,
                "Support replied to your ticket",
                `${t.subject} — tap Support to view the reply.`,
              ).catch(() => {});
            }
            return json({ ok: true }, 200, cors);
          }

          // Admin-only writes
          if (isAdmin && body.action === "admin_set_status") {
            const id = String(body.id || "");
            const status = body.status === "open" || body.status === "resolved" ? body.status : null;
            if (!id || !status) return json({ error: "Bad request" }, 400, cors);
            await fsPatch(`support_tickets/${id}`, { status, updatedAt: new Date() });
            return json({ ok: true }, 200, cors);
          }
          if (isAdmin && body.action === "admin_delete") {
            const id = String(body.id || "");
            if (!id) return json({ error: "Bad request" }, 400, cors);
            const msgs = await listMessages(id);
            for (const m of msgs) {
              await fsDelete(`support_tickets/${id}/messages/${m.id}`).catch(() => {});
            }
            await fsDelete(`support_tickets/${id}`);
            return json({ ok: true }, 200, cors);
          }

          return json({ error: "Bad request" }, 400, cors);
        } catch (e) {
          console.error("[support]", (e as Error).message);
          return json({ error: "Server error" }, 500, cors);
        }
      },
    },
  },
});
