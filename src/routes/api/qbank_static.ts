// Authenticated private endpoint for QBank question payloads (stems-only).
//
// Security model (replaces the old PUBLIC + global-key design):
//   - Requires Authorization: Bearer <Firebase ID token> (+ optional
//     X-Firebase-AppCheck when APP_CHECK_ENFORCE=true).
//   - Same country+grant rule as /api/qbank?action=get_questions: Egypt can
//     no longer fetch Tunisia. 403 detail shape matches get_questions so the
//     client routes to the request-access flow.
//   - 0 Firestore reads on the hot path: verifyIdToken uses cached JWKS (no
//     DB); access bundle comes from the 1h KV-style cache
//     (src/lib/qbank-access.server.ts); bank meta from the shared
//     publish-invalidated list cache. Miss = Firestore once, then cache 1h.
//   - R2 stays PRIVATE: no public CDN cache. Responses are Cache-Control:
//     private + Vary: Authorization (per-user), never s-maxage/CDN hints.
//   - Payload is single-file AES-GCM but encrypted with a PER-BANK key
//     (src/lib/qbank-drm.server.ts, env-only, never in JS). Without an
//     authorized POST /api/qbank_key call the file is useless.
//   - Answer split: the bulk file carries STEMS ONLY (text + options).
//     correctIndices/explanation stay server-side for on-demand get_answers
//     (tiny throttled reads). Bulk answer scrape becomes ~37k requests.

import { createFileRoute } from "@tanstack/react-router";
import {
  getServiceAccount,
  getGoogleAccessToken,
  verifyFirebaseIdToken,
  dbStats,
} from "@/lib/firebase.server";
import { getCorsHeaders } from "@/lib/cors";
import { getClientIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit.server";
import { gunzipSync } from "node:zlib";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { resolveBankAccessEdge, checkAppCheck } from "@/lib/qbank-access.server";
import { encryptForBank, splitQuestionsForStatic, getBankKeyId } from "@/lib/qbank-drm.server";

// QBank metadata (storage_provider) rarely changes. 5-min shared cache
// avoids 1 Firestore read on every origin miss.
const metaCache = new Map<string, { provider: string | undefined; exp: number }>();
const META_TTL_MS = 5 * 60_000;

export const Route = createFileRoute("/api/qbank_static")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, OPTIONS" });
        return new Response(null, { status: 204, headers: cors });
      },
      GET: async ({ request }) => {
        return dbStats.run({ reads: 0, writes: 0 }, async () => {
          const cors = getCorsHeaders(request, { methods: "GET, OPTIONS" });
          const ip = getClientIp(request);
          const rl = rateLimit(`qbank-static:${ip}`, 60_000, 30);
          if (!rl.ok) return rateLimitResponse(rl.retryAfter, cors);

          // ---- Auth at the edge (no DB): Firebase ID token via cached JWKS.
          const auth = request.headers.get("authorization") || "";
          const m = auth.match(/^Bearer\s+(.+)$/i);
          if (!m) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
              status: 401,
              headers: { "content-type": "application/json", ...cors },
            });
          }
          let uid = "";
          try {
            const user = await verifyFirebaseIdToken(m[1]);
            uid = String((user as any).sub || (user as any).user_id || "");
            if (!uid) throw new Error("no uid");
          } catch {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
              status: 401,
              headers: { "content-type": "application/json", ...cors },
            });
          }

          const userLimit = rateLimit(`qbank-static:uid:${uid}`, 60_000, 10);
          if (!userLimit.ok) return rateLimitResponse(userLimit.retryAfter, cors);

          // ---- Optional App Check (opt-in enforcement, presence logged).
          const appCheck = checkAppCheck(request);
          if (appCheck.enforced && !appCheck.present) {
            return new Response(JSON.stringify({ error: "Missing App Check token" }), {
              status: 401,
              headers: { "content-type": "application/json", ...cors },
            });
          }

          const urlObj = new URL(request.url);
          const qbankId = urlObj.searchParams.get("qbankId");
          const v = urlObj.searchParams.get("v"); // version/updatedAt stamp (client cache-bust only)

          if (!qbankId || !/^[a-zA-Z0-9_-]+$/.test(qbankId)) {
            return new Response(JSON.stringify({ error: "Missing or invalid qbankId" }), {
              status: 400,
              headers: { "content-type": "application/json", ...cors },
            });
          }

          try {
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();

            // ---- Same access rule as get_questions, 0 reads when warm.
            const access = await resolveBankAccessEdge(sa, token, uid, qbankId);
            if (!access.ok && access.status === 404) {
              return new Response(JSON.stringify({ error: "QBank not found" }), {
                status: 404,
                headers: { "content-type": "application/json", ...cors },
              });
            }
            if (!access.ok) {
              return new Response(
                JSON.stringify({
                  error: "Forbidden: You do not have access to this QBank.",
                  detail: {
                    bankKind: access.meta?.kind || "unknown",
                    bankCountry: access.meta?.country || "unknown",
                    profileCountry: access.profile.country || "(none)",
                    grantListed: access.profile.grants.includes(qbankId),
                  },
                }),
                { status: 403, headers: { "content-type": "application/json", ...cors } },
              );
            }
            const bankCountry = access.meta?.country || "global";

            const questions: any[] = [];

            // Fetch QBank metadata to check storage provider (cached: 0 reads when warm)
            let storageProvider: string | undefined;
            const metaHit = metaCache.get(qbankId);
            if (metaHit && metaHit.exp > Date.now()) {
              storageProvider = metaHit.provider;
            } else if (access.meta?.storage_provider !== undefined) {
              // Prefer the value already resolved by the access check (0 reads).
              storageProvider = access.meta.storage_provider;
              metaCache.set(qbankId, { provider: storageProvider, exp: Date.now() + META_TTL_MS });
            } else {
              const metaUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}`;
              const metaRes = await fetch(metaUrl, { headers: { Authorization: `Bearer ${token}` } });
              const metaData = metaRes.ok ? await metaRes.json() : {};
              storageProvider = metaData.fields?.storage_provider?.stringValue;
              metaCache.set(qbankId, { provider: storageProvider, exp: Date.now() + META_TTL_MS });
            }

            let fetchedFromChunks = false;

            // 1. Try fetching from Cloudflare R2 (private bucket, server-side only)
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
                const objRes = await s3Client.send(
                  new GetObjectCommand({
                    Bucket: process.env.R2_BUCKET_NAME || "curaq",
                    Key: `qbanks/${qbankId}/chunks.json.gz`,
                  }),
                );
                const bytes = await objRes.Body?.transformToByteArray();
                if (bytes) {
                  const rawJson = gunzipSync(bytes).toString("utf-8");
                  const parsed = JSON.parse(rawJson);
                  questions.push(...parsed);
                  fetchedFromChunks = true;
                }
              } catch (e) {
                console.error("[qbank_static] Failed to fetch chunks from R2", e);
              }
            }

            // 2. Try fetching from Firestore chunks (fallback if not fetched from R2)
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
                      let parsedChunk: any[];
                      if (dataStr.trim().startsWith("[")) {
                        // Legacy uncompressed JSON array
                        parsedChunk = JSON.parse(dataStr);
                      } else {
                        // New gzip+base64 format
                        const buf = Buffer.from(dataStr, "base64");
                        const rawJson = gunzipSync(buf).toString("utf-8");
                        parsedChunk = JSON.parse(rawJson);
                      }
                      questions.push(...parsedChunk);
                    } catch (e) {
                      console.error("[qbank_static] Failed to parse chunk", doc.name, e);
                    }
                  }
                }
              }
            }

            // 3. Fallback: fetch individual question documents (pre-chunk QBanks)
            if (!fetchedFromChunks) {
              let pageTokenQ = "";
              while (true) {
                const params = new URLSearchParams({ pageSize: "300" });
                if (pageTokenQ) params.set("pageToken", pageTokenQ);
                const qRes = await fetch(
                  `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}/questions?${params}`,
                  { headers: { Authorization: `Bearer ${token}` } },
                );
                if (!qRes.ok && qRes.status !== 404) break;
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
                      } catch {}
                    }
                  }
                }
                pageTokenQ = qData.nextPageToken || "";
                if (!pageTokenQ) break;
              }
            }

            if (questions.length === 0) {
              return new Response(JSON.stringify({ error: "No questions found" }), {
                status: 404,
                headers: { "content-type": "application/json", ...cors },
              });
            }

            // Answer split + per-bank encryption (env-only key, never in JS).
            const { stems } = splitQuestionsForStatic(questions);
            let encryptedQuestions: string;
            try {
              encryptedQuestions = await encryptForBank(JSON.stringify(stems), qbankId, bankCountry);
            } catch (e: any) {
              console.error("[qbank_static] DRM key missing:", e?.message);
              return new Response(JSON.stringify({ error: "Server misconfigured" }), {
                status: 500,
                headers: { "content-type": "application/json", ...cors },
              });
            }

            // Private per-user response. R2 stays private; no public/shared
            // CDN may cache this (Vary: Authorization). Cost stays R2 + KV.
            const store = dbStats.getStore();
            const keyId = getBankKeyId(qbankId, bankCountry);
            return new Response(
              JSON.stringify({ encryptedQuestions, answersSplit: true, keyId, count: stems.length, v: v || undefined }),
              {
                status: 200,
                headers: {
                  "content-type": "application/json",
                  "cache-control": "private, max-age=300",
                  vary: "Authorization",
                  "x-questions-count": String(stems.length),
                  "x-firestore-reads": store ? String(store.reads) : "0",
                  "x-cache-status": "ORIGIN",
                  "x-key-id": keyId,
                  ...cors,
                },
              },
            );
          } catch (e: any) {
            console.error("[qbank_static] Error:", e?.message);
            return new Response(JSON.stringify({ error: "Server error" }), {
              status: 500,
              headers: { "content-type": "application/json", ...cors },
            });
          }
        }); // end dbStats.run
      },
    },
  },
});
