// Medical image generation proxy.
//
// POST /api/ai-image  { prompt, kind?, modality?, title?, aspect?, size? }
//   → { url } (R2-backed) or { dataUrl } (local-dev fallback)
//
// GET  /api/ai-image?img=<id>
//   → the generated image bytes, cached forever (the id is unguessable).
//
// Keys never leave the server: generation uses the same Google Gemini key pool
// as /api/ai, with per-key/model cooldowns handled in ai-image.server.ts.

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { verifyFirebaseIdToken } from "@/lib/firebase.server";
import { getCorsHeaders } from "@/lib/cors";
import { getClientIp, rateLimit, rateLimitGlobal, rateLimitResponse } from "@/lib/rate-limit.server";
import { generateMedicalImage, getStoredImage } from "@/lib/ai-image.server";

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

const BodySchema = z.object({
  prompt: z.string().min(10).max(8_000),
  kind: z.string().max(40).optional(),
  modality: z.string().max(120).optional(),
  title: z.string().max(200).optional(),
  aspect: z.string().max(10).optional(),
  size: z.enum(["1K", "2K", "4K"]).optional(),
});

export const Route = createFileRoute("/api/ai-image")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, POST, OPTIONS" });
        return new Response(null, { status: 204, headers: cors });
      },

      GET: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, POST, OPTIONS" });
        const id = new URL(request.url).searchParams.get("img") || "";
        const stored = await getStoredImage(id);
        if (!stored) return json({ error: "Not found" }, 404, cors);
        return new Response(stored.bytes, {
          status: 200,
          headers: {
            "content-type": stored.mimeType,
            "content-length": String(stored.bytes.byteLength),
            "cache-control": "public, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
          },
        });
      },

      POST: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, POST, OPTIONS" });

        const ip = getClientIp(request);
        const ipLimit = rateLimit(`aiimg:ip:${ip}`, 60_000, 120);
        if (!ipLimit.ok) return rateLimitResponse(ipLimit.retryAfter, cors);

        const authHeader = request.headers.get("authorization") || "";
        const match = authHeader.match(/^Bearer\s+(.+)$/i);
        if (!match) return json({ error: "Unauthorized" }, 401, cors);
        let user;
        try {
          user = await verifyFirebaseIdToken(match[1]);
        } catch (e) {
          console.warn("[ai-image] token verify failed:", (e as Error).message);
          return json({ error: "Unauthorized" }, 401, cors);
        }

        const userLimit = await rateLimitGlobal(`aiimg:uid:${user.sub}`, 60_000, 60);
        if (!userLimit.ok) return rateLimitResponse(userLimit.retryAfter, cors);

        let raw: unknown;
        try { raw = await request.json(); }
        catch { return json({ error: "Bad request" }, 400, cors); }
        const parsed = BodySchema.safeParse(raw);
        if (!parsed.success) {
          return json({ error: "Bad request", details: parsed.error.issues.slice(0, 3) }, 400, cors);
        }

        try {
          const result = await generateMedicalImage(parsed.data);
          if (!result.ok) {
            return json(
              {
                error: result.message,
                reason: result.reason,
                retryAfter: result.reason === "busy" ? 20 : undefined,
              },
              result.reason === "no_key" ? 503 : 502,
              cors,
            );
          }
          return json(
            {
              url: result.url,
              dataUrl: result.dataUrl,
              mimeType: result.mimeType,
              model: result.model,
              ms: result.ms,
            },
            200,
            cors,
          );
        } catch (e) {
          console.error("[ai-image] unexpected:", (e as Error).message);
          return json({ error: "Image generation failed" }, 500, cors);
        }
      },
    },
  },
});
