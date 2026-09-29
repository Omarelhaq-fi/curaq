// POST /api/qbank_key { qbankId } -> { key, keyId, qbankId }
//
// Per-bank DRM key issuance. Same auth + access rule as the static payload,
// strictly rate-limited and logged (uid, bank, ip, time). The key lives in
// client memory only — never localStorage/IndexedDB — and rotates by
// changing env (DRM_BANK_KEYS / DRM_COUNTRY_KEYS / DRM_MASTER, monthly).
// Without this call a downloaded static file cannot be decrypted, and an
// Egypt user 403s here for a Tunisia bank even if they hold the file.
import { createFileRoute } from "@tanstack/react-router";
import {
  getServiceAccount,
  getGoogleAccessToken,
  verifyFirebaseIdToken,
  dbStats,
} from "@/lib/firebase.server";
import { getCorsHeaders } from "@/lib/cors";
import { getClientIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit.server";
import { resolveBankAccessEdge, checkAppCheck } from "@/lib/qbank-access.server";
import { getBankKeyString, getBankKeyId } from "@/lib/qbank-drm.server";

export const Route = createFileRoute("/api/qbank_key")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "POST, OPTIONS" });
        return new Response(null, { status: 204, headers: cors });
      },
      POST: async ({ request }) => {
        return dbStats.run({ reads: 0, writes: 0 }, async () => {
          const cors = getCorsHeaders(request, { methods: "POST, OPTIONS" });
          const ip = getClientIp(request);
          const ipLimit = rateLimit(`qbank-key:ip:${ip}`, 60_000, 30);
          if (!ipLimit.ok) return rateLimitResponse(ipLimit.retryAfter, cors);

          const auth = request.headers.get("authorization") || "";
          const m = auth.match(/^Bearer\s+(.+)$/i);
          if (!m) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
              status: 401,
              headers: { "content-type": "application/json", ...cors },
            });
          }
          let uid = "";
          let email = "";
          try {
            const user = await verifyFirebaseIdToken(m[1]);
            uid = String((user as any).sub || (user as any).user_id || "");
            email = String((user as any).email || "");
            if (!uid) throw new Error("no uid");
          } catch {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
              status: 401,
              headers: { "content-type": "application/json", ...cors },
            });
          }

          // Strict per-user limit: key issuance is the DRM choke point.
          // 10/min/uid still allows normal study; bulk key-harvest stalls.
          const userLimit = rateLimit(`qbank-key:uid:${uid}`, 60_000, 10);
          if (!userLimit.ok) return rateLimitResponse(userLimit.retryAfter, cors);

          const appCheck = checkAppCheck(request);
          if (appCheck.enforced && !appCheck.present) {
            return new Response(JSON.stringify({ error: "Missing App Check token" }), {
              status: 401,
              headers: { "content-type": "application/json", ...cors },
            });
          }

          let body: any = {};
          try {
            body = await request.json();
          } catch {
            return new Response(JSON.stringify({ error: "Invalid JSON" }), {
              status: 400,
              headers: { "content-type": "application/json", ...cors },
            });
          }
          const qbankId = String(body?.qbankId || "");
          if (!qbankId || !/^[a-zA-Z0-9_-]+$/.test(qbankId)) {
            return new Response(JSON.stringify({ error: "Missing or invalid qbankId" }), {
              status: 400,
              headers: { "content-type": "application/json", ...cors },
            });
          }

          try {
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();
            const access = await resolveBankAccessEdge(sa, token, uid, qbankId);
            if (!access.ok) {
              console.warn(
                `[qbank_key] DENIED uid=${uid} bank=${qbankId} ip=${ip} status=${access.status} at=${new Date().toISOString()}`,
              );
              return new Response(
                JSON.stringify({ error: access.status === 404 ? "QBank not found" : "Forbidden" }),
                {
                  status: access.status === 404 ? 404 : 403,
                  headers: { "content-type": "application/json", ...cors },
                },
              );
            }

            const bankCountry = access.meta?.country || "global";
            let key: string;
            try {
              key = getBankKeyString(qbankId, bankCountry);
            } catch (e: any) {
              console.error("[qbank_key] DRM key missing:", e?.message);
              return new Response(JSON.stringify({ error: "Server misconfigured" }), {
                status: 500,
                headers: { "content-type": "application/json", ...cors },
              });
            }
            const keyId = getBankKeyId(qbankId, bankCountry);
            // Audit log: who, when, ip, bank, key id (never the key itself).
            console.info(
              `[qbank_key] ISSUED uid=${uid} email=${email} bank=${qbankId} country=${bankCountry} keyId=${keyId} ip=${ip} appCheck=${appCheck.present ? "yes" : "no"} at=${new Date().toISOString()}`,
            );
            const store = dbStats.getStore();
            return new Response(
              JSON.stringify({ key, keyId, qbankId, answersSplit: true }),
              {
                status: 200,
                headers: {
                  "content-type": "application/json",
                  "cache-control": "no-store",
                  "x-firestore-reads": store ? String(store.reads) : "0",
                  ...cors,
                },
              },
            );
          } catch (e: any) {
            console.error("[qbank_key] Error:", e?.message);
            return new Response(JSON.stringify({ error: "Server error" }), {
              status: 500,
              headers: { "content-type": "application/json", ...cors },
            });
          }
        });
      },
    },
  },
});
