// Activity heartbeat — records the last time a signed-in user did ANYTHING
// in the app (navigation, clicks, edits), not just AI calls.
// Writes users_index/{uid}.lastActiveIso + lastActionLabel via the service
// account, so the browser SDK never needs write access to those fields.

import { createFileRoute } from "@tanstack/react-router";
import { getServiceAccount, getGoogleAccessToken, verifyFirebaseIdToken, dbStats } from "@/lib/firebase.server";
import { getCorsHeaders } from "@/lib/cors";
import { getClientIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit.server";

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

async function touchActivity(uid: string, email: string | undefined, action: string) {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const fields: Record<string, { stringValue: string }> = {
    lastActiveIso: { stringValue: new Date().toISOString() },
    lastActionLabel: { stringValue: action },
  };
  if (email) fields.email = { stringValue: email };
  const mask = Object.keys(fields)
    .map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
    .join("&");
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users_index/${uid}?${mask}`;
  const resp = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!resp.ok) throw new Error(`activity patch failed: ${resp.status}`);
}

export const Route = createFileRoute("/api/activity")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "POST, OPTIONS" });
        return new Response(null, { status: 204, headers: cors });
      },
      POST: async ({ request }) => {
        return dbStats.run({reads: 0, writes: 0}, async () => {
        const cors = getCorsHeaders(request, { methods: "POST, OPTIONS" });
        try {
          const auth = request.headers.get("authorization") || "";
          const m = auth.match(/^Bearer\s+(.+)$/i);
          if (!m) return json({ error: "Unauthorized" }, 401, cors);
          const user = await verifyFirebaseIdToken(m[1]);
          const uid = String(user.sub || user.user_id || "");
          if (!uid) return json({ error: "Unauthorized" }, 401, cors);

          const rl = rateLimit(`activity:${uid}:${getClientIp(request)}`, 60_000, 6);
          if (!rl.ok) return rateLimitResponse(rl.retryAfter, cors);

          let action = "";
          try {
            const body = (await request.json()) as { action?: unknown };
            action = typeof body.action === "string" ? body.action : "";
          } catch { /* body optional */ }
          // Sanitize: short, plain label only.
          action = action.replace(/[^\w \-./]/g, "").slice(0, 40);

          await touchActivity(uid, user.email as string | undefined, action);
          return json({ ok: true }, 200, cors);
        } catch (e) {
          console.error("[activity]", (e as Error).message);
          return json({ error: "Server error" }, 500, cors);
        }
        });
      },
    },
  },
});
